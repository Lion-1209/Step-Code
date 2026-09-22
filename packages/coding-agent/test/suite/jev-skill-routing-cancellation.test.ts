import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionContext, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { type JevRoutingResult, type JevSkill, suggestJevSkill } from "../../src/features/jev-skill-router/router.ts";
import { createStepJevSkillRouterExtension } from "../../src/features/step-jev-skill-router.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const FIRST_PROMPT = "Investigate the build failure";
const NEXT_PROMPT = "What is two plus two?";
const skills = ["valid-skill", "multiline-description"].flatMap(
	(name) =>
		loadSkillsFromDir({
			dir: fileURLToPath(new URL(`../fixtures/skills/${name}/`, import.meta.url)),
			source: "test",
		}).skills,
);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

// Observe rejection immediately: a cancelled prompt may reject before abort() settles.
function observe<T>(promise: Promise<T>) {
	let settled = false;
	const result = promise.then(
		(value) => {
			settled = true;
			return { status: "fulfilled" as const, value };
		},
		(error: unknown) => {
			settled = true;
			return { status: "rejected" as const, error };
		},
	);
	return {
		result,
		get settled() {
			return settled;
		},
	};
}

interface JevRequest {
	state: { request: string };
	questions: Record<string, { type: "choice" | "noul"; criteria?: Record<string, unknown> }>;
}

function reply(request: JevRequest, selected = "skill_0"): Response {
	const answers = Object.fromEntries(
		Object.entries(request.questions).map(([id, question]) => [
			id,
			question.type === "choice"
				? {
						type: "choice",
						choice: selected,
						confidence: 0.99,
						probabilities: Object.fromEntries(
							Object.keys(question.criteria ?? {}).map((option) => [option, option === selected ? 1 : 0]),
						),
					}
				: { type: "noul", noul: selected === "none" ? 0 : 0.99 },
		]),
	);
	return Response.json({ model: "jev-test", answers, usage: { input_tokens: 0, output_tokens: 0 } });
}

function blockedTransport() {
	const started = deferred<void>();
	const firstReply = deferred<Response>();
	const requests: JevRequest[] = [];
	const signals: Array<AbortSignal | null | undefined> = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
		const request = JSON.parse(String(init?.body)) as JevRequest;
		requests.push(request);
		signals.push(init?.signal);
		if (requests.length === 1) {
			started.resolve();
			// Deliberately ignore abort to exercise session and engine cancellation races.
			return firstReply.promise;
		}
		return reply(request, request.state.request === FIRST_PROMPT ? "skill_0" : "none");
	});
	return {
		fetch,
		requests,
		signals,
		started: started.promise,
		release: (selected = "skill_0") => firstReply.resolve(reply(requests[0], selected)),
	};
}

describe("Jev routing cancellation in an AgentSession", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	});

	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
		vi.useRealTimers();
	});

	async function session(factories: ExtensionFactory[]): Promise<Harness> {
		const extensionsResult = await createTestExtensionsResult(factories);
		const harness = await createHarness({
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSkills: () => ({ skills, diagnostics: [] }),
			},
		});
		harnesses.push(harness);
		return harness;
	}

	async function routedSession(
		transport: ReturnType<typeof blockedTransport>,
		additionalFactories: ExtensionFactory[] = [],
	) {
		const contextSignals: Array<AbortSignal | undefined> = [];
		const harness = await session([
			(pi) => {
				pi.on("before_agent_start", (_event, ctx) => {
					contextSignals.push(ctx.signal);
				});
			},
			createStepJevSkillRouterExtension({
				env: { STEP_JEV_SKILL_ROUTING: "1", TYPESAFE_API_KEY: "test-typesafe-key" },
				fetch: transport.fetch,
			}),
			...additionalFactories,
		]);
		return { harness, contextSignals };
	}

	it("aborts the real hook during its first HTTP request, ignores the late reply, and permits a fresh prompt", async () => {
		const transport = blockedTransport();
		const { harness, contextSignals } = await routedSession(transport);
		harness.setResponses([fauxAssistantMessage("The cancelled task must not run")]);
		const pending = observe(harness.session.prompt(FIRST_PROMPT));
		try {
			await transport.started;
			expect.soft(harness.session.isStreaming).toBe(true);
			expect.soft(harness.session.isIdle).toBe(false);
			expect.soft(contextSignals[0]).toBeInstanceOf(AbortSignal);
			expect.soft(contextSignals[0]?.aborted).toBe(false);
			expect.soft(transport.signals[0]?.aborted).toBe(false);

			const abort = observe(harness.session.abort());
			await vi.advanceTimersByTimeAsync(0);
			// No deadline has advanced and the transport is still blocked.
			expect.soft(abort.settled).toBe(true);
			expect.soft(pending.settled).toBe(true);
			expect.soft(contextSignals[0]?.aborted).toBe(true);
			expect.soft(transport.signals[0]?.aborted).toBe(true);
			expect.soft(harness.session.isIdle).toBe(true);

			transport.release();
			await pending.result;
			await abort.result;
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(transport.fetch).toHaveBeenCalledTimes(1);
			expect.soft(harness.faux.state.callCount).toBe(0);
			expect.soft(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
			expect.soft(harness.session.systemPrompt).not.toContain("<skill_relevance>");

			harness.setResponses([fauxAssistantMessage("Four")]);
			await harness.session.prompt(NEXT_PROMPT);
			expect.soft(transport.fetch).toHaveBeenCalledTimes(2);
			expect.soft(harness.faux.state.callCount).toBe(1);
			expect.soft(contextSignals[1]).toBeInstanceOf(AbortSignal);
			expect.soft(contextSignals[1]).not.toBe(contextSignals[0]);
			expect.soft(contextSignals[1]?.aborted).toBe(false);
			expect.soft(getUserTexts(harness)).toEqual([NEXT_PROMPT]);
		} finally {
			transport.release();
			await pending.result;
		}
	});

	it("direct session.dispose cancels blocked Jev HTTP and settles the prompt without stale context errors", async () => {
		const transport = blockedTransport();
		const { harness, contextSignals } = await routedSession(transport);
		harness.setResponses([fauxAssistantMessage("The disposed task must not run")]);
		const pending = observe(harness.session.prompt(FIRST_PROMPT));
		try {
			await transport.started;
			harness.session.dispose();
			// Synchronous disposal must cancel the operation before invalidating its context.
			expect.soft(contextSignals[0]?.aborted).toBe(true);
			expect.soft(transport.signals[0]?.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(pending.settled).toBe(true);
			expect.soft(harness.session.isIdle).toBe(true);

			transport.release();
			const outcome = await pending.result;
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(outcome).toEqual({ status: "fulfilled", value: undefined });
			expect.soft(transport.fetch).toHaveBeenCalledTimes(1);
			expect.soft(harness.faux.state.callCount).toBe(0);
			expect.soft(harness.session.messages).toEqual([]);
		} finally {
			transport.release();
			await pending.result;
		}
	});

	it("awaited runtime.dispose settles blocked Jev routing before shutdown and context invalidation", async () => {
		const transport = blockedTransport();
		const phases: string[] = [];
		const { harness, contextSignals } = await routedSession(transport, [
			(pi) => {
				pi.on("agent_settled", () => {
					phases.push("settled");
				});
				pi.on("session_shutdown", (_event, ctx) => {
					phases.push("shutdown");
					expect.soft(ctx.isIdle()).toBe(true);
					expect.soft(ctx.signal).toBeUndefined();
					expect.soft(contextSignals[0]?.aborted).toBe(true);
					expect.soft(transport.signals[0]?.aborted).toBe(true);
				});
			},
		]);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("Disposal must not create a replacement runtime");
			},
		);
		runtime.setBeforeSessionInvalidate(() => {
			phases.push("invalidate");
			expect.soft(harness.session.isIdle).toBe(true);
		});
		harness.setResponses([fauxAssistantMessage("The disposed task must not run")]);
		const pending = observe(harness.session.prompt(FIRST_PROMPT));
		try {
			await transport.started;
			const disposal = observe(runtime.dispose());
			// Let disposal start; keep both the transport gate and the 1500ms deadline untouched.
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(contextSignals[0]?.aborted).toBe(true);
			expect.soft(transport.signals[0]?.aborted).toBe(true);
			expect.soft(pending.settled).toBe(true);
			expect.soft(disposal.settled).toBe(true);
			expect.soft(phases).toEqual(["settled", "shutdown", "invalidate"]);

			transport.release();
			const [promptOutcome, disposalOutcome] = await Promise.all([pending.result, disposal.result]);
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(promptOutcome).toEqual({ status: "fulfilled", value: undefined });
			expect.soft(disposalOutcome).toEqual({ status: "fulfilled", value: undefined });
			expect.soft(transport.fetch).toHaveBeenCalledTimes(1);
			expect.soft(harness.faux.state.callCount).toBe(0);
			expect.soft(harness.session.messages).toEqual([]);
		} finally {
			transport.release();
			await pending.result;
			await runtime.dispose();
		}
	});

	it("cancels a real engine excerpt wait through before_agent_start's existing ctx.signal", async () => {
		const excerptStarted = deferred<void>();
		const excerpt = deferred<string>();
		const contextSignals: Array<AbortSignal | undefined> = [];
		let routingResult: JevRoutingResult | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			const request = JSON.parse(String(init?.body)) as JevRequest;
			return reply(request, request.state.request === FIRST_PROMPT ? "skill_0" : "none");
		});
		const loadExcerpt = vi.fn(async (_skill: JevSkill, _signal: AbortSignal) => {
			excerptStarted.resolve();
			return excerpt.promise;
		});
		const harness = await session([
			(pi) => {
				pi.on("before_agent_start", async (event, ctx) => {
					contextSignals.push(ctx.signal);
					const options = { apiKey: "test-typesafe-key", fetch, loadExcerpt, signal: ctx.signal };
					routingResult = await suggestJevSkill(event.prompt, skills, options);
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("The cancelled task must not run")]);
		const pending = observe(harness.session.prompt(FIRST_PROMPT));
		try {
			await excerptStarted.promise;
			expect.soft(harness.session.isStreaming).toBe(true);
			expect.soft(harness.session.isIdle).toBe(false);
			expect.soft(contextSignals[0]).toBeInstanceOf(AbortSignal);
			const abort = observe(harness.session.abort());
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(abort.settled).toBe(true);
			expect.soft(pending.settled).toBe(true);
			expect.soft(contextSignals[0]?.aborted).toBe(true);
			for (const [, signal] of loadExcerpt.mock.calls) expect.soft(signal.aborted).toBe(true);
			expect.soft(routingResult).toEqual({ reason: "unavailable" });

			excerpt.resolve("Late excerpt must not trigger verification");
			await pending.result;
			await abort.result;
			await vi.advanceTimersByTimeAsync(0);
			expect.soft(fetch).toHaveBeenCalledTimes(1);
			expect.soft(harness.faux.state.callCount).toBe(0);
			expect.soft(harness.eventsOfType("tool_execution_start")).toHaveLength(0);

			harness.setResponses([fauxAssistantMessage("Four")]);
			await harness.session.prompt(NEXT_PROMPT);
			expect.soft(fetch).toHaveBeenCalledTimes(2);
			expect.soft(harness.faux.state.callCount).toBe(1);
			expect.soft(getUserTexts(harness)).toEqual([NEXT_PROMPT]);
		} finally {
			excerpt.resolve("Cleanup");
			await pending.result;
		}
	});

	it("honors ctx.abort() inside a hook and discards its result and all remaining handlers", async () => {
		let hookContext: ExtensionContext | undefined;
		let hookSignal: AbortSignal | undefined;
		const laterInSameExtension = vi.fn();
		const laterExtension = vi.fn();
		const harness = await session([
			(pi) => {
				pi.on("before_agent_start", (_event, ctx) => {
					hookContext = ctx;
					hookSignal = ctx.signal;
					expect.soft(ctx.isIdle()).toBe(false);
					expect.soft(hookSignal).toBeInstanceOf(AbortSignal);
					expect.soft(hookSignal?.aborted).toBe(false);
					ctx.abort();
					expect.soft(ctx.signal).toBe(hookSignal);
					return {
						systemPrompt: "Discard this cancelled system prompt",
						message: {
							customType: "cancelled-hook-result",
							content: "Discard this cancelled message",
							display: false,
						},
					};
				});
				pi.on("before_agent_start", laterInSameExtension);
			},
			(pi) => {
				pi.on("before_agent_start", laterExtension);
			},
		]);
		const originalSystemPrompt = harness.session.systemPrompt;
		harness.setResponses([fauxAssistantMessage("The cancelled task must not run")]);
		await harness.session.prompt(FIRST_PROMPT);

		expect(hookSignal?.aborted).toBe(true);
		expect(laterInSameExtension).not.toHaveBeenCalled();
		expect(laterExtension).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages).toEqual([]);
		expect(harness.session.systemPrompt).toBe(originalSystemPrompt);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		// The existing context getters follow the run back to idle.
		expect(hookContext?.isIdle()).toBe(true);
		expect(hookContext?.signal).toBeUndefined();
	});

	it.each([undefined, "followUp"] as const)(
		"applies concurrent prompt policy %s while the routing hook is pending",
		async (streamingBehavior) => {
			const transport = blockedTransport();
			const { harness, contextSignals } = await routedSession(transport);
			harness.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Follow-up answer")]);
			const pending = observe(harness.session.prompt(FIRST_PROMPT));
			try {
				await transport.started;
				const concurrent = observe(harness.session.prompt(NEXT_PROMPT, { streamingBehavior }));
				await vi.advanceTimersByTimeAsync(0);
				expect.soft(concurrent.settled).toBe(true);
				expect.soft(transport.fetch).toHaveBeenCalledTimes(1);
				expect.soft(contextSignals).toHaveLength(1);
				expect.soft(harness.faux.state.callCount).toBe(0);
				if (streamingBehavior === "followUp") {
					expect.soft(harness.session.getFollowUpMessages()).toEqual([NEXT_PROMPT]);
				}

				transport.release("none");
				const outcome = await concurrent.result;
				await pending.result;
				if (streamingBehavior === undefined) {
					expect.soft(outcome).toMatchObject({
						status: "rejected",
						error: expect.objectContaining({ message: expect.stringContaining("already processing") }),
					});
					expect.soft(getUserTexts(harness)).toEqual([FIRST_PROMPT]);
					expect.soft(harness.faux.state.callCount).toBe(1);
				} else {
					expect.soft(outcome.status).toBe("fulfilled");
					expect.soft(getUserTexts(harness)).toEqual([FIRST_PROMPT, NEXT_PROMPT]);
					expect.soft(harness.faux.state.callCount).toBe(2);
					expect.soft(harness.session.getFollowUpMessages()).toEqual([]);
				}
				expect.soft(harness.session.isIdle).toBe(true);
			} finally {
				transport.release("none");
				await pending.result;
			}
		},
	);
});
