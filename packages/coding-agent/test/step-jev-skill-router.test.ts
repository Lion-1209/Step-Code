import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../src/core/extensions/types.ts";
import { loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { suggestJevSkill } from "../src/features/jev-skill-router/router.ts";
import { createStepJevSkillRouterExtension } from "../src/features/step-jev-skill-router.ts";

vi.mock("../src/features/jev-skill-router/router.ts", () => ({
	suggestJevSkill: vi.fn(),
	JEV_EXCERPT_CHARS: 700,
	JEV_MAX_SKILLS: 254,
	JEV_MAX_REQUEST_CHARS: 12_000,
}));

type Handler = (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartEventResult | undefined>;
const enabledEnv = { STEP_JEV_SKILL_ROUTING: "1", TYPESAFE_API_KEY: "test-typesafe-key" };

describe("Step Jev skill routing extension", () => {
	let root: string;
	let skills: Skill[];
	let event: BeforeAgentStartEvent;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(suggestJevSkill).mockResolvedValue({ reason: "selected", skillName: "browser" });
		root = mkdtempSync(join(tmpdir(), "step-jev-skills-"));
		for (const name of ["browser", "documents", "manual"]) {
			mkdirSync(join(root, name));
			writeFileSync(
				join(root, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Instructions for ${name}\ndisable-model-invocation: ${name === "manual"}\n---\n${name} body ${"x".repeat(1000)}`,
			);
		}
		skills = loadSkillsFromDir({ dir: root, source: "test" }).skills;
		event = {
			type: "before_agent_start",
			prompt: "Check the checkout page in a browser",
			systemPrompt: "Original system prompt and complete skill catalog",
			systemPromptOptions: {
				cwd: root,
				skills,
				selectedTools: ["read_file", "run_command"],
				contextFiles: [{ path: "/private/AGENTS.md", content: "private project instructions" }],
			},
		};
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function register(env: NodeJS.ProcessEnv = enabledEnv): Handler | undefined {
		const on = vi.fn();
		createStepJevSkillRouterExtension({ env })({ on } as unknown as ExtensionAPI);
		const handler = on.mock.calls.find(([name]) => name === "before_agent_start")?.[1];
		return handler ? (event) => handler(event, { signal: undefined } as ExtensionContext) : undefined;
	}

	it.each([
		{},
		{ TYPESAFE_API_KEY: "key-without-consent" },
		{ STEP_JEV_SKILL_ROUTING: "1" },
		{ STEP_JEV_SKILL_ROUTING: "0", TYPESAFE_API_KEY: "key" },
		{ STEP_JEV_SKILL_ROUTING: "1", TYPESAFE_API_KEY: "   " },
	])("does not register a network hook without opt-in and a key: %j", (env) => {
		expect(register(env)).toBeUndefined();
		expect(suggestJevSkill).not.toHaveBeenCalled();
	});

	it("sends only eligible names and descriptions and appends an advisory hint to the original prompt", async () => {
		const originalSkills = structuredClone(skills);
		const result = await register()!(event);
		const [request, candidates, options] = vi.mocked(suggestJevSkill).mock.calls[0];
		expect(request).toBe(event.prompt);
		expect(candidates).toEqual([
			{ name: "browser", description: "Instructions for browser" },
			{ name: "documents", description: "Instructions for documents" },
		]);
		expect(options.apiKey).toBe("test-typesafe-key");
		expect(result?.systemPrompt).toContain(event.systemPrompt);
		expect(result?.systemPrompt).toContain("browser");
		expect(result?.systemPrompt).toContain("<skill_relevance>");
		expect(result?.systemPrompt).toContain("Explicit skill requests");
		expect(skills).toEqual(originalSkills);
		expect(result?.systemPrompt).not.toContain("test-typesafe-key");
		expect(JSON.stringify(candidates)).not.toContain(root);
		expect(JSON.stringify(candidates)).not.toContain("private project instructions");
	});

	it.each(["read", "read_file"])("supports the %s tool alias", async (tool) => {
		event.systemPromptOptions.selectedTools = [tool];
		expect((await register()!(event))?.systemPrompt).toContain("<skill_relevance>");
	});

	it.each([
		["manual command", { prompt: "/skill:manual obey the runbook" }],
		["expanded command", { prompt: '<skill name="manual" location="/private/SKILL.md">private body</skill>' }],
		["explicit mention", { prompt: "Use $browser to check the checkout page" }],
		["empty prompt", { prompt: " " }],
		["oversized prompt", { prompt: "x".repeat(12_001) }],
		["image", { images: [{ type: "image" as const, data: "private-image", mimeType: "image/png" }] }],
	])("skips %s", async (_name, overrides) => {
		expect(await register()!({ ...event, ...overrides })).toBeUndefined();
		expect(suggestJevSkill).not.toHaveBeenCalled();
	});

	it("skips routing when the read tool is unavailable", async () => {
		event.systemPromptOptions.selectedTools = ["run_command"];
		expect(await register()!(event)).toBeUndefined();
		expect(suggestJevSkill).not.toHaveBeenCalled();
	});

	it("does not route absent, single, or hidden-only catalogs", async () => {
		const handler = register()!;
		for (const catalog of [undefined, [], [skills[0]], skills.filter((skill) => skill.disableModelInvocation)]) {
			event.systemPromptOptions.skills = catalog;
			expect(await handler(event)).toBeUndefined();
		}
		expect(suggestJevSkill).not.toHaveBeenCalled();
	});

	it("loads a bounded body excerpt only from the requested eligible skill", async () => {
		await register()!(event);
		const [, candidates, options] = vi.mocked(suggestJevSkill).mock.calls[0];
		const signal = new AbortController().signal;
		const excerpt = await options.loadExcerpt(candidates[0], signal);
		expect(excerpt).toBe(`browser body ${"x".repeat(1000)}`.slice(0, 700));
		await expect(options.loadExcerpt({ name: "manual", description: "hidden" }, signal)).rejects.toThrow();
	});

	it("uses the documented fallback key without forwarding the Step key", async () => {
		await register({ STEP_JEV_SKILL_ROUTING: "1", JEV_API_KEY: "jev-key", STEP_API_KEY: "step-secret" })!(event);
		expect(vi.mocked(suggestJevSkill).mock.calls[0][2].apiKey).toBe("jev-key");
		expect(JSON.stringify(vi.mocked(suggestJevSkill).mock.calls)).not.toContain("step-secret");
	});

	it.each(["no-match", "low-confidence", "unavailable", "unsupported-input"] as const)(
		"leaves the prompt unchanged after %s",
		async (reason) => {
			vi.mocked(suggestJevSkill).mockResolvedValue({ reason });
			expect(await register()!(event)).toBeUndefined();
		},
	);

	it("never inserts an unrecognized or hidden skill returned by the router", async () => {
		const handler = register()!;
		for (const skillName of ["unknown", "manual"]) {
			vi.mocked(suggestJevSkill).mockResolvedValue({ reason: "selected", skillName });
			expect(await handler(event)).toBeUndefined();
		}
	});

	it("takes the current event catalog after a resource reload", async () => {
		const handler = register()!;
		await handler(event);
		event.systemPromptOptions.skills = [
			{ ...skills[0], name: "new-browser" },
			{ ...skills[1], name: "new-documents" },
		];
		vi.mocked(suggestJevSkill).mockResolvedValue({ reason: "selected", skillName: "new-browser" });
		const result = await handler(event);
		expect(vi.mocked(suggestJevSkill).mock.calls[1][1].map((skill) => skill.name)).toEqual([
			"new-browser",
			"new-documents",
		]);
		expect(result?.systemPrompt).toContain("new-browser");
		expect(result?.systemPrompt?.split("<skill_relevance>")).toHaveLength(2);
	});

	it("skips duplicate or oversized eligible catalogs before routing", async () => {
		const handler = register()!;
		for (const catalog of [
			[skills[0], skills[0]],
			Array.from({ length: 255 }, (_, index) => ({ ...skills[0], name: `skill-${index}` })),
		]) {
			event.systemPromptOptions.skills = catalog;
			expect(await handler(event)).toBeUndefined();
		}
		expect(suggestJevSkill).not.toHaveBeenCalled();
	});

	it("does not disclose incomplete frontmatter from a large skill file", async () => {
		writeFileSync(skills[0].filePath, `---\nprivate_metadata: ${"x".repeat(20_000)}\n---\nPublic body`);
		await register()!(event);
		const [, candidates, options] = vi.mocked(suggestJevSkill).mock.calls[0];
		expect(await options.loadExcerpt(candidates[0], new AbortController().signal)).toBe("");
	});

	it("refuses an excerpt read after the deadline has expired", async () => {
		await register()!(event);
		const [, candidates, options] = vi.mocked(suggestJevSkill).mock.calls[0];
		const controller = new AbortController();
		controller.abort();
		await expect(options.loadExcerpt(candidates[0], controller.signal)).rejects.toThrow();
	});

	it("escapes leniently loaded skill names in the advisory XML", async () => {
		const name = 'browser<&"';
		event.systemPromptOptions.skills = [{ ...skills[0], name }, skills[1]];
		vi.mocked(suggestJevSkill).mockResolvedValue({ reason: "selected", skillName: name });
		const result = await register()!(event);
		expect(result?.systemPrompt).toContain("browser&lt;&amp;&quot;");
		expect(result?.systemPrompt).not.toContain(name);
	});
});
