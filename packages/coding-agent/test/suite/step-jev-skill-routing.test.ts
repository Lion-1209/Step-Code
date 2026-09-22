import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir, type Skill } from "../../src/core/skills.ts";
import { createStepJevSkillRouterExtension } from "../../src/features/step-jev-skill-router.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

interface JevRequest {
	state: { request: string };
	questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
}

describe("Jev routing in an AgentSession", () => {
	let root: string;
	let skills: Skill[];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "step-jev-session-"));
		for (const name of ["browser", "documents", "manual"]) {
			mkdirSync(join(root, name));
			writeFileSync(
				join(root, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Use ${name} instructions\ndisable-model-invocation: ${name === "manual"}\n---\n${name} instructions ${"x".repeat(1000)}\nOUTSIDE_EXCERPT`,
			);
		}
		skills = loadSkillsFromDir({ dir: root, source: "test" }).skills;
	});

	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
		rmSync(root, { recursive: true, force: true });
	});

	function transport() {
		const requests: JevRequest[] = [];
		let noMatch = false;
		const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			expect(url).toBe("https://api.typesafe.ai/v1/systemone");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer typesafe-test-key");
			const request = JSON.parse(String(init?.body)) as JevRequest;
			requests.push(request);
			const answers: Record<string, unknown> = {};
			for (const [id, question] of Object.entries(request.questions)) {
				if (question.type === "choice") {
					const options = Object.keys(question.criteria ?? {});
					const choice = noMatch ? "none" : "skill_0";
					expect(options).toContain(choice);
					answers[id] = {
						type: "choice",
						choice,
						confidence: 0.99,
						probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])),
					};
				} else {
					answers[id] = { type: "noul", noul: noMatch ? 0 : 0.99 };
				}
			}
			return Response.json({ model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 20 } });
		});
		return {
			fetch,
			requests,
			setNoMatch: () => {
				noMatch = true;
			},
		};
	}

	async function session(fetch: typeof globalThis.fetch): Promise<Harness> {
		const extensionsResult = await createTestExtensionsResult(
			[
				createStepJevSkillRouterExtension({
					env: { STEP_JEV_SKILL_ROUTING: "1", TYPESAFE_API_KEY: "typesafe-test-key" },
					fetch,
				}),
			],
			root,
		);
		const harness = await createHarness({
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSkills: () => ({ skills, diagnostics: [] }),
				getAgentsFiles: () => ({ agentsFiles: [{ path: "/private/AGENTS.md", content: "PRIVATE_PROJECT_GUIDE" }] }),
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it("routes once before the tool loop and clears the suggestion on the next no-match prompt", async () => {
		const jev = transport();
		const harness = await session(jev.fetch);
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("read", { path: skills[0].filePath }), { stopReason: "toolUse" });
			},
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("Checked the browser instructions");
			},
		]);

		await harness.session.prompt("Check the checkout page");

		expect(jev.requests).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
		expect(prompts[0]).toBe(prompts[1]);
		expect(prompts[0]).toContain("<skill_relevance>");
		expect(prompts[0]).toContain("<name>browser</name>");
		expect(prompts[0]).toContain("<name>documents</name>");
		expect(prompts[0]).not.toContain("<name>manual</name>");
		const transmitted = JSON.stringify(jev.requests);
		expect(transmitted).not.toContain(root);
		expect(transmitted).not.toContain("PRIVATE_PROJECT_GUIDE");
		expect(transmitted).not.toContain("OUTSIDE_EXCERPT");
		expect(transmitted).not.toContain("manual");
		expect(transmitted).not.toContain("faux-key");

		jev.setNoMatch();
		harness.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("The answer is four");
			},
		]);
		await harness.session.prompt("What is two plus two?");
		expect(jev.requests).toHaveLength(3);
		expect(prompts[2]).not.toContain("<skill_relevance>");
		expect(prompts[0].startsWith(prompts[2])).toBe(true);
	});

	it("allows an explicit hidden skill without sending its expanded body to Jev", async () => {
		const jev = transport();
		const harness = await session(jev.fetch);
		harness.setResponses([fauxAssistantMessage("Following the manual skill")]);
		await harness.session.prompt("/skill:manual follow these instructions");

		expect(jev.fetch).not.toHaveBeenCalled();
		expect(getUserTexts(harness)[0]).toContain('<skill name="manual"');
		expect(getUserTexts(harness)[0]).toContain("manual instructions");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("continues the coding task with the original catalog when TypeSafe is rate-limited", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("rate limited", { status: 429 }));
		const harness = await session(fetch);
		let prompt = "";
		harness.setResponses([
			(context) => {
				prompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("The task can continue");
			},
		]);
		await harness.session.prompt("Check the checkout page");

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(prompt).not.toContain("<skill_relevance>");
		expect(prompt).toContain("<name>browser</name>");
		expect(prompt).toContain("<name>documents</name>");
	});
});
