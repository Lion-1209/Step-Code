import { getEventListeners } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	JEV_EXCERPT_CHARS,
	JEV_MAX_REQUEST_CHARS,
	JEV_MAX_SKILLS,
	JEV_TIMEOUT_MS,
	type JevRoutingOptions,
	type JevSkill,
	suggestJevSkill,
} from "../src/features/jev-skill-router/router.ts";

const REQUEST = "Investigate why the TypeScript build fails.";
const API_KEY = "test-key-never-in-the-body";
const SKILLS: readonly JevSkill[] = Object.freeze([
	Object.freeze({ name: "debug", description: "Investigate failures and verify their causes." }),
	Object.freeze({ name: "review", description: "Review a proposed code change." }),
]);

function choice(probabilities: Record<string, number>, selected = "skill_0", confidence = 0.9) {
	return { type: "choice", choice: selected, probabilities, confidence };
}

function noul(value: number) {
	return { type: "noul", noul: value };
}

function firstAnswers(selected = "skill_0", needsSkill = 0.9) {
	return {
		which: choice({ skill_0: 0.7, skill_1: 0.2, none: 0.1 }, selected),
		needs_skill: noul(needsSkill),
	};
}

function secondAnswers(selected = "skill_0", confidence = 0.9, chosenFit = 0.9) {
	return {
		which: choice({ skill_0: 0.7, skill_1: 0.2, none: 0.1 }, selected, confidence),
		fits_skill_0: noul(chosenFit),
		fits_skill_1: noul(1),
	};
}

function response(answers: Record<string, unknown>) {
	return Response.json({ answers, model: "jev-latest", usage: { input_tokens: 80, output_tokens: 12 } });
}

function setup(first = firstAnswers(), second = secondAnswers()) {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(response(first))
		.mockResolvedValueOnce(response(second));
	const loadExcerpt = vi
		.fn<JevRoutingOptions["loadExcerpt"]>()
		.mockImplementation(async (skill) => `Guide for ${skill.name}`);
	return { fetch, loadExcerpt, apiKey: API_KEY };
}

function requestBody(fetch: ReturnType<typeof setup>["fetch"], call: number) {
	return JSON.parse(fetch.mock.calls[call][1]!.body as string);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Jev skill recommendations", () => {
	test("exports the agreed routing bounds", () => {
		expect([JEV_MAX_SKILLS, JEV_MAX_REQUEST_CHARS, JEV_EXCERPT_CHARS, JEV_TIMEOUT_MS]).toEqual([
			254, 12000, 700, 1500,
		]);
	});

	test("selects a skill using two batched requests with self-contained questions and no host fields", async () => {
		const skills = [
			{
				...SKILLS[0],
				description: `Full description: ${"D".repeat(1600)}`,
				path: "/private/debug/SKILL.md",
				secret: "host-secret",
			},
			{ ...SKILLS[1], cwd: "/private/worktree", hidden: false },
		];
		const options = setup();

		await expect(suggestJevSkill(REQUEST, skills, options)).resolves.toEqual({
			reason: "selected",
			skillName: "debug",
		});
		expect(options.fetch).toHaveBeenCalledTimes(2);
		const [first, second] = [requestBody(options.fetch, 0), requestBody(options.fetch, 1)];
		const signal = options.fetch.mock.calls[0][1]!.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
		for (const [url, init] of options.fetch.mock.calls) {
			expect(url).toBe("https://api.typesafe.ai/v1/systemone");
			expect(init).toMatchObject({
				method: "POST",
				redirect: "error",
				headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
				signal,
			});
			expect(init!.signal).toBe(signal);
			for (const excluded of [API_KEY, "host-secret", "/private/", '"hidden"', '"cwd"', '"path"']) {
				expect(init!.body).not.toContain(excluded);
			}
		}
		for (const body of [first, second]) {
			expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
			expect(body.model).toBe("jev-latest");
			expect(body.state).toEqual({ request: REQUEST });
			expect(body.questions.which).toEqual({
				type: "choice",
				instructions: expect.any(String),
				criteria: expect.objectContaining({ none: expect.any(String) }),
			});
			expect(Object.keys(body.questions.which.criteria)).toEqual(["skill_0", "skill_1", "none"]);
		}
		expect(Object.keys(first.questions)).toEqual(["which", "needs_skill"]);
		expect(first.questions.needs_skill).toEqual({ type: "noul", instructions: expect.any(String) });
		expect(Object.keys(second.questions)).toEqual(["which", "fits_skill_0", "fits_skill_1"]);
		for (const [index, skill] of skills.entries()) {
			const id = `skill_${index}`;
			expect(JSON.parse(first.questions.which.criteria[id])).toEqual({
				name: skill.name,
				description: skill.description,
			});
			expect(first.questions.needs_skill.instructions).toContain(skill.name);
			expect(first.questions.needs_skill.instructions).toContain(skill.description);
			expect(JSON.parse(second.questions.which.criteria[id])).toEqual({
				name: skill.name,
				description: skill.description,
				excerpt: `Guide for ${skill.name}`,
			});
			expect(second.questions[`fits_${id}`]).toEqual({ type: "noul", instructions: expect.any(String) });
			expect(second.questions[`fits_${id}`].instructions).toContain(skill.description);
			expect(second.questions[`fits_${id}`].instructions).toContain(`Guide for ${skill.name}`);
			expect(options.loadExcerpt).toHaveBeenNthCalledWith(index + 1, skill, signal);
		}
		expect(options.loadExcerpt).toHaveBeenCalledTimes(2);
	});

	test.each([
		["none", 0.99],
		["skill_0", 0.499],
	])("stops after the first pass for choice %s and needs_skill %s", async (selected, needsSkill) => {
		const options = setup(firstAnswers(selected, needsSkill));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "no-match" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test("returns no-match for the second pass's explicit none even with high fits", async () => {
		const options = setup(firstAnswers(), secondAnswers("none"));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "no-match" });
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});

	test.each([
		[0.6, 0.5, "selected"],
		[0.599, 1, "low-confidence"],
		[1, 0.499, "low-confidence"],
		[0, 0, "low-confidence"],
	])("gates the chosen candidate on confidence %s and its own fit %s", async (confidence, fit, reason) => {
		const first = firstAnswers("skill_0", 0.5);
		first.which.confidence = 0;
		const options = setup(first, secondAnswers("skill_0", confidence, fit));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual(
			reason === "selected" ? { reason, skillName: "debug" } : { reason },
		);
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});

	test("loads only the three highest probabilities with catalog-order ties and 700-character excerpts", async () => {
		const skills = Object.freeze(
			Array.from({ length: 5 }, (_, index) =>
				Object.freeze({
					name: ["none", "skill_0", "constructor", "__proto__", "fifth"][index],
					description: `Documentation ${index}`,
				}),
			),
		);
		const first = {
			which: choice(
				{ skill_0: 0.02, skill_1: 0.15, skill_2: 0.15, skill_3: 0.25, skill_4: 0.03, none: 0.4 },
				"skill_0",
				0.01,
			),
			needs_skill: noul(0.9),
		};
		const second = {
			which: choice({ skill_3: 0.6, skill_1: 0.2, skill_2: 0.1, none: 0.1 }, "skill_3"),
			fits_skill_3: noul(0.8),
			fits_skill_1: noul(0.9),
			fits_skill_2: noul(0.9),
		};
		const options = setup();
		options.fetch.mockReset().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second));
		options.loadExcerpt.mockResolvedValue(`${"E".repeat(700)}EXCERPT_TAIL_MUST_NOT_LEAK`);

		await expect(suggestJevSkill(REQUEST, skills, options)).resolves.toEqual({
			reason: "selected",
			skillName: "__proto__",
		});
		expect(options.fetch).toHaveBeenCalledTimes(2);
		expect(options.loadExcerpt.mock.calls.map(([skill]) => skill.name)).toEqual([
			"__proto__",
			"skill_0",
			"constructor",
		]);
		const body = requestBody(options.fetch, 1);
		expect(Object.keys(body.questions)).toEqual(["which", "fits_skill_3", "fits_skill_1", "fits_skill_2"]);
		expect(Object.keys(body.questions.which.criteria)).toEqual(["skill_3", "skill_1", "skill_2", "none"]);
		for (const id of ["skill_3", "skill_1", "skill_2"]) {
			expect(JSON.parse(body.questions.which.criteria[id]).excerpt).toBe("E".repeat(700));
		}
		expect(JSON.stringify(body)).not.toContain("EXCERPT_TAIL_MUST_NOT_LEAK");
		expect(skills.map((skill) => skill.name)).toEqual(["none", "skill_0", "constructor", "__proto__", "fifth"]);
	});

	test("uses global fetch when no transport is injected", async () => {
		const options = setup();
		vi.stubGlobal("fetch", options.fetch);
		await expect(
			suggestJevSkill(REQUEST, SKILLS, { apiKey: API_KEY, loadExcerpt: options.loadExcerpt }),
		).resolves.toEqual({
			reason: "selected",
			skillName: "debug",
		});
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});
});

describe("input bounds", () => {
	test.each(["", " \n\t", "x".repeat(12001), null, 42])(
		"rejects unsupported request %# before doing any work",
		async (request) => {
			const options = setup();
			await expect(suggestJevSkill(request as string, SKILLS, options)).resolves.toEqual({
				reason: "unsupported-input",
			});
			expect(options.fetch).not.toHaveBeenCalled();
			expect(options.loadExcerpt).not.toHaveBeenCalled();
		},
	);

	test.each([0, 1, 255])("rejects a catalog of %s skills without contacting Jev", async (count) => {
		const options = setup();
		const skills = Array.from({ length: count }, (_, index) => ({
			name: `name-${index}`,
			description: "Description",
		}));
		await expect(suggestJevSkill(REQUEST, skills, options)).resolves.toEqual({ reason: "unsupported-input" });
		expect(options.fetch).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test.each([
		null,
		{},
		[SKILLS[0], SKILLS[0]],
		[SKILLS[0], { name: "", description: "Empty name" }],
		[SKILLS[0], { name: " \t", description: "Blank name" }],
		[SKILLS[0], { name: 42, description: "Non-string name" }],
		[SKILLS[0], { name: "missing-description" }],
		[SKILLS[0], { name: "invalid-description", description: 12 }],
		[SKILLS[0], null],
		new Array(2),
	])("rejects invalid or duplicate skill metadata %# without throwing", async (skills) => {
		const options = setup();
		await expect(suggestJevSkill(REQUEST, skills as readonly JevSkill[], options)).resolves.toEqual({
			reason: "unsupported-input",
		});
		expect(options.fetch).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test.each(["", " \n\t", undefined, null, 42])("rejects invalid API key %# without HTTP", async (apiKey) => {
		const options = setup();
		await expect(suggestJevSkill(REQUEST, SKILLS, { ...options, apiKey: apiKey as string })).resolves.toEqual({
			reason: "unsupported-input",
		});
		expect(options.fetch).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "100", null])(
		"rejects invalid timeout %# without HTTP",
		async (timeoutMs) => {
			const options = setup();
			await expect(
				suggestJevSkill(REQUEST, SKILLS, { ...options, timeoutMs: timeoutMs as number }),
			).resolves.toEqual({ reason: "unsupported-input" });
			expect(options.fetch).not.toHaveBeenCalled();
			expect(options.loadExcerpt).not.toHaveBeenCalled();
		},
	);

	test.each([null, undefined, {}, { apiKey: API_KEY, loadExcerpt: "not a function" }])(
		"rejects invalid options %# without throwing",
		async (invalid) => {
			const options = setup();
			vi.stubGlobal("fetch", options.fetch);
			await expect(suggestJevSkill(REQUEST, SKILLS, invalid as unknown as JevRoutingOptions)).resolves.toEqual({
				reason: "unsupported-input",
			});
			expect(options.fetch).not.toHaveBeenCalled();
		},
	);

	test("accepts exactly 254 skills and a 12000-character request without truncating either", async () => {
		const skills = Array.from({ length: 254 }, (_, index) => ({
			name: `name-${index}`,
			description: `Full description ${index}`,
		}));
		const request = ` ${"x".repeat(11998)} `;
		const probabilities = Object.fromEntries(skills.map((_, index) => [`skill_${index}`, 0]));
		const options = setup();
		options.fetch.mockReset().mockResolvedValueOnce(
			response({
				which: choice({ ...probabilities, none: 1 }, "none"),
				needs_skill: noul(0),
			}),
		);
		await expect(suggestJevSkill(request, skills, options)).resolves.toEqual({ reason: "no-match" });
		const body = requestBody(options.fetch, 0);
		expect(body.state).toEqual({ request });
		expect(Object.keys(body.questions.which.criteria)).toHaveLength(255);
		expect(JSON.parse(body.questions.which.criteria.skill_253)).toEqual(skills[253]);
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});
});

describe("response validation", () => {
	const malformedChoices: [string, unknown][] = [
		["missing choice answer", undefined],
		["null answer", null],
		["array answer", []],
		["wrong answer type", { ...firstAnswers().which, type: "score" }],
		["unknown chosen ID", { ...firstAnswers().which, choice: "skill_999" }],
		["skill name used as ID", { ...firstAnswers().which, choice: "debug" }],
		["non-string chosen ID", { ...firstAnswers().which, choice: 0 }],
		["prototype ID", { ...firstAnswers().which, choice: "constructor" }],
		["missing probabilities", { ...firstAnswers().which, probabilities: undefined }],
		["array probabilities", { ...firstAnswers().which, probabilities: [0.7, 0.2, 0.1] }],
		["missing none probability", { ...firstAnswers().which, probabilities: { skill_0: 0.8, skill_1: 0.2 } }],
		["missing candidate probability", { ...firstAnswers().which, probabilities: { skill_0: 0.9, none: 0.1 } }],
		[
			"extra probability",
			{ ...firstAnswers().which, probabilities: { skill_0: 0.7, skill_1: 0.2, none: 0.1, extra: 0 } },
		],
		[
			"unknown probability replacing candidate",
			{ ...firstAnswers().which, probabilities: { skill_0: 0.7, other: 0.2, none: 0.1 } },
		],
		["negative probability", { ...firstAnswers().which, probabilities: { skill_0: 0.9, skill_1: 0.2, none: -0.1 } }],
		["probability over one", { ...firstAnswers().which, probabilities: { skill_0: 1.1, skill_1: 0, none: 0 } }],
		["string probability", { ...firstAnswers().which, probabilities: { skill_0: "0.7", skill_1: 0.2, none: 0.1 } }],
		["null probability", { ...firstAnswers().which, probabilities: { skill_0: null, skill_1: 0.9, none: 0.1 } }],
		[
			"unnormalized distribution",
			{ ...firstAnswers().which, probabilities: { skill_0: 0.1, skill_1: 0.1, none: 0.1 } },
		],
		["missing confidence", { ...firstAnswers().which, confidence: undefined }],
		["negative confidence", { ...firstAnswers().which, confidence: -0.01 }],
		["confidence over one", { ...firstAnswers().which, confidence: 1.01 }],
		["string confidence", { ...firstAnswers().which, confidence: "0.9" }],
		["null confidence", { ...firstAnswers().which, confidence: null }],
	];

	test.each(malformedChoices)("rejects first-pass %s before reading excerpts", async (_label, which) => {
		const options = setup();
		options.fetch.mockReset().mockResolvedValueOnce(response({ ...firstAnswers(), which }));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test.each(malformedChoices)("rejects second-pass %s", async (_label, which) => {
		const options = setup();
		options.fetch
			.mockReset()
			.mockResolvedValueOnce(response(firstAnswers()))
			.mockResolvedValueOnce(response({ ...secondAnswers(), which }));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});

	const malformedNouls: [string, unknown][] = [
		["missing", undefined],
		["null", null],
		["array", []],
		["wrong type", { type: "score", noul: 0.9 }],
		["missing noul", { type: "noul", confidence: 0.9 }],
		["string noul", { type: "noul", noul: "0.9" }],
		["negative noul", noul(-0.1)],
		["noul over one", noul(1.1)],
	];

	test.each(malformedNouls)("rejects %s needs_skill even when the choice is none", async (_label, needs_skill) => {
		const options = setup();
		options.fetch.mockReset().mockResolvedValueOnce(response({ ...firstAnswers("none"), needs_skill }));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test.each(malformedNouls)("rejects %s fit for an unchosen candidate", async (_label, fits_skill_1) => {
		const options = setup();
		options.fetch
			.mockReset()
			.mockResolvedValueOnce(response(firstAnswers()))
			.mockResolvedValueOnce(response({ ...secondAnswers(), fits_skill_1 }));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});

	test.each([null, [], {}, { answers: null }, { answers: [] }, { answers: "wrong" }])(
		"rejects malformed response envelope %#",
		async (payload) => {
			const options = setup();
			options.fetch.mockReset().mockResolvedValueOnce(Response.json(payload));
			await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
			expect(options.fetch).toHaveBeenCalledTimes(1);
			expect(options.loadExcerpt).not.toHaveBeenCalled();
		},
	);

	test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects non-finite numerical answers %# from injected JSON readers",
		async (value) => {
			for (const field of ["probability", "confidence", "noul"]) {
				const answers = firstAnswers();
				if (field === "probability") answers.which.probabilities.skill_0 = value;
				if (field === "confidence") answers.which.confidence = value;
				if (field === "noul") answers.needs_skill.noul = value;
				const reply = response(firstAnswers());
				vi.spyOn(reply, "json").mockResolvedValue({ answers });
				const options = setup();
				options.fetch.mockReset().mockResolvedValueOnce(reply);
				await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
				expect(options.fetch).toHaveBeenCalledTimes(1);
				expect(options.loadExcerpt).not.toHaveBeenCalled();
			}
		},
	);

	test("allows small probability rounding error", async () => {
		const first = firstAnswers();
		first.which.probabilities = { skill_0: 0.7, skill_1: 0.2, none: 0.099 };
		const second = secondAnswers();
		second.which.probabilities = { skill_0: 0.7, skill_1: 0.2, none: 0.101 };
		await expect(suggestJevSkill(REQUEST, SKILLS, setup(first, second))).resolves.toEqual({
			reason: "selected",
			skillName: "debug",
		});
	});

	test("rejects a valid catalog skill that was not shortlisted", async () => {
		const skills = [...SKILLS, { name: "third", description: "Third" }, { name: "fourth", description: "Fourth" }];
		const options = setup();
		options.fetch
			.mockReset()
			.mockResolvedValueOnce(
				response({
					which: choice({ skill_0: 0.5, skill_1: 0.25, skill_2: 0.15, skill_3: 0.05, none: 0.05 }),
					needs_skill: noul(1),
				}),
			)
			.mockResolvedValueOnce(
				response({
					which: choice({ skill_0: 0.5, skill_1: 0.3, skill_2: 0.1, none: 0.1 }, "skill_3"),
					fits_skill_0: noul(1),
					fits_skill_1: noul(1),
					fits_skill_2: noul(1),
					fits_skill_3: noul(1),
				}),
			);
		await expect(suggestJevSkill(REQUEST, skills, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(2);
	});
});

describe("fail-open errors", () => {
	test.each([301, 302, 307, 308, 401, 429, 500, 503, 529])(
		"stops without retrying HTTP %s in either pass",
		async (status) => {
			for (const pass of [1, 2]) {
				const options = setup();
				options.fetch.mockReset();
				if (pass === 2) options.fetch.mockResolvedValueOnce(response(firstAnswers()));
				const failed = new Response(API_KEY, {
					status,
					headers: { Location: "https://other.example", "Retry-After": "0" },
				});
				const read = vi.spyOn(failed, "json");
				options.fetch.mockResolvedValueOnce(failed);
				await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
				expect(options.fetch).toHaveBeenCalledTimes(pass);
				expect(options.loadExcerpt).toHaveBeenCalledTimes(pass === 1 ? 0 : 2);
				expect(read).not.toHaveBeenCalled();
			}
		},
	);

	test("rejects a redirected response from an injected transport", async () => {
		const reply = response(firstAnswers());
		Object.defineProperty(reply, "redirected", { value: true });
		const options = setup();
		options.fetch.mockReset().mockResolvedValueOnce(reply);
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test.each([1, 2])("handles network rejection in pass %s without retrying or logging secrets", async (pass) => {
		const logs = ["error", "warn", "log", "info", "debug"].map((method) =>
			vi.spyOn(console, method as "error").mockImplementation(() => {}),
		);
		const options = setup();
		options.fetch.mockReset();
		if (pass === 2) options.fetch.mockResolvedValueOnce(response(firstAnswers()));
		options.fetch.mockRejectedValueOnce(new Error(`Transport failed with ${API_KEY}`));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(pass);
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});

	test.each([1, 2])("handles invalid JSON in pass %s", async (pass) => {
		const options = setup();
		options.fetch.mockReset();
		if (pass === 2) options.fetch.mockResolvedValueOnce(response(firstAnswers()));
		options.fetch.mockResolvedValueOnce(new Response("{invalid json", { status: 200 }));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(pass);
	});

	test.each(["sync", "async"])("handles a %s excerpt failure without the second HTTP request", async (kind) => {
		const options = setup();
		if (kind === "sync")
			options.loadExcerpt.mockImplementation(() => {
				throw new Error("read failed");
			});
		else options.loadExcerpt.mockRejectedValue(new Error("read failed"));
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
	});

	test("handles a non-string excerpt as unavailable", async () => {
		const options = setup();
		options.loadExcerpt.mockResolvedValue(null as unknown as string);
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("one shared deadline", () => {
	test("returns at the default deadline when the first transport ignores abort and ignores its late response", async () => {
		vi.useFakeTimers();
		const first = deferred<Response>();
		const options = setup();
		options.fetch.mockReset().mockReturnValueOnce(first.promise);
		const settled = vi.fn();
		const result = suggestJevSkill(REQUEST, SKILLS, options);
		void result.then(settled);
		const signal = options.fetch.mock.calls[0][1]!.signal!;

		await vi.advanceTimersByTimeAsync(1499);
		expect(settled).not.toHaveBeenCalled();
		expect(signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
		expect(signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		const late = response(firstAnswers());
		const parse = vi.spyOn(late, "json");
		first.resolve(late);
		await vi.advanceTimersByTimeAsync(0);
		expect(parse).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
		expect(options.fetch).toHaveBeenCalledTimes(1);
	});

	test("includes the first request's time in the excerpt budget and never sends a late second request", async () => {
		vi.useFakeTimers();
		const first = deferred<Response>();
		const excerpt = deferred<string>();
		const options = setup();
		options.fetch.mockReset().mockReturnValueOnce(first.promise);
		options.loadExcerpt.mockReturnValue(excerpt.promise);
		const settled = vi.fn();
		void suggestJevSkill(REQUEST, SKILLS, { ...options, timeoutMs: 1000 }).then(settled);
		const signal = options.fetch.mock.calls[0][1]!.signal!;

		await vi.advanceTimersByTimeAsync(600);
		first.resolve(response(firstAnswers()));
		await vi.advanceTimersByTimeAsync(0);
		expect(options.loadExcerpt).toHaveBeenCalledTimes(2);
		for (const [, excerptSignal] of options.loadExcerpt.mock.calls) expect(excerptSignal).toBe(signal);
		await vi.advanceTimersByTimeAsync(399);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
		expect(signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		excerpt.resolve("Eventually read, despite ignoring abort.");
		await vi.advanceTimersByTimeAsync(0);
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	test("includes both earlier phases in the second request's budget and uses the identical signal", async () => {
		vi.useFakeTimers();
		const first = deferred<Response>();
		const excerpt = deferred<string>();
		const second = deferred<Response>();
		const options = setup();
		options.fetch.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		options.loadExcerpt.mockReturnValue(excerpt.promise);
		const settled = vi.fn();
		void suggestJevSkill(REQUEST, SKILLS, options).then(settled);
		const signal = options.fetch.mock.calls[0][1]!.signal!;

		await vi.advanceTimersByTimeAsync(500);
		first.resolve(response(firstAnswers()));
		await vi.advanceTimersByTimeAsync(500);
		excerpt.resolve("Documented instructions.");
		await vi.advanceTimersByTimeAsync(0);
		expect(options.fetch).toHaveBeenCalledTimes(2);
		expect(options.fetch.mock.calls[1][1]!.signal).toBe(signal);
		for (const [, excerptSignal] of options.loadExcerpt.mock.calls) expect(excerptSignal).toBe(signal);
		await vi.advanceTimersByTimeAsync(499);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
		expect(signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		const late = response(secondAnswers());
		const parse = vi.spyOn(late, "json");
		second.resolve(late);
		await vi.advanceTimersByTimeAsync(0);
		expect(parse).not.toHaveBeenCalled();
		expect(options.fetch).toHaveBeenCalledTimes(2);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	test.each([1, 2])("bounds JSON body parsing that ignores abort in pass %s", async (pass) => {
		vi.useFakeTimers();
		const body = deferred<unknown>();
		const reply = response(pass === 1 ? firstAnswers() : secondAnswers());
		vi.spyOn(reply, "json").mockReturnValue(body.promise);
		const options = setup();
		options.fetch.mockReset();
		if (pass === 2) options.fetch.mockResolvedValueOnce(response(firstAnswers()));
		options.fetch.mockResolvedValueOnce(reply);
		const settled = vi.fn();
		void suggestJevSkill(REQUEST, SKILLS, { ...options, timeoutMs: 100 }).then(settled);

		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
		expect(options.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		body.resolve({ answers: pass === 1 ? firstAnswers() : secondAnswers() });
		await vi.advanceTimersByTimeAsync(0);
		expect(options.fetch).toHaveBeenCalledTimes(pass);
		if (pass === 1) expect(options.loadExcerpt).not.toHaveBeenCalled();
	});

	test("does not send the second request if elapsed time exceeds the budget before a timer callback runs", async () => {
		vi.useFakeTimers();
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const options = setup();
		options.loadExcerpt.mockImplementation(async () => {
			elapsed = 1500;
			return "A read that consumed the remaining wall-clock budget.";
		});
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(1);
		expect(options.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("does not accept an answer parsed after the absolute deadline even before timers run", async () => {
		vi.useFakeTimers();
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const late = response(secondAnswers());
		vi.spyOn(late, "json").mockImplementation(async () => {
			elapsed = 1500;
			return { answers: secondAnswers() };
		});
		const options = setup();
		options.fetch.mockReset().mockResolvedValueOnce(response(firstAnswers())).mockResolvedValueOnce(late);
		await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
		expect(options.fetch).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each(["selected", "no-match", "low-confidence", "unavailable", "unsupported-input"])(
		"clears its timer when returning %s early",
		async (reason) => {
			vi.useFakeTimers();
			const options = setup(
				firstAnswers(reason === "no-match" ? "none" : "skill_0"),
				secondAnswers("skill_0", reason === "low-confidence" ? 0.5 : 0.9),
			);
			if (reason === "unavailable")
				options.fetch.mockReset().mockResolvedValueOnce(new Response(null, { status: 401 }));
			const result = await suggestJevSkill(reason === "unsupported-input" ? "" : REQUEST, SKILLS, options);
			expect(result.reason).toBe(reason);
			expect(vi.getTimerCount()).toBe(0);
			const calls = options.fetch.mock.calls.length;
			await vi.advanceTimersByTimeAsync(3000);
			expect(options.fetch).toHaveBeenCalledTimes(calls);
			if (["selected", "no-match", "low-confidence"].includes(reason)) {
				expect(options.fetch.mock.calls[0][1]!.signal!.aborted).toBe(false);
			}
		},
	);

	test.each(["resolve", "reject"])(
		"aborts other reads after an excerpt fails and consumes their late %s",
		async (outcome) => {
			vi.useFakeTimers();
			const other = deferred<string>();
			const options = setup();
			options.loadExcerpt.mockRejectedValueOnce(new Error("First read failed")).mockReturnValueOnce(other.promise);
			await expect(suggestJevSkill(REQUEST, SKILLS, options)).resolves.toEqual({ reason: "unavailable" });
			expect(options.loadExcerpt).toHaveBeenCalledTimes(2);
			expect(options.loadExcerpt.mock.calls[1][1].aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			if (outcome === "resolve") other.resolve("Too late");
			else other.reject(new Error("Late read failure"));
			await vi.advanceTimersByTimeAsync(0);
			expect(options.fetch).toHaveBeenCalledTimes(1);
		},
	);
});

describe("caller cancellation", () => {
	test("returns unavailable for an initially aborted signal without HTTP, reads, listeners, or timers", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		caller.abort(new Error("Already cancelled"));
		const options = setup();
		await expect(suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal })).resolves.toEqual({
			reason: "unavailable",
		});
		expect(options.fetch).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
		expect(getEventListeners(caller.signal, "abort")).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each([
		null,
		false,
		42,
		"cancel",
		{},
		new AbortController(),
		{ aborted: true },
		{ aborted: false, addEventListener() {}, removeEventListener() {} },
		Object.create(AbortSignal.prototype),
		Object.create(AbortSignal.prototype, { aborted: { value: false } }),
	])("rejects invalid signal %# without throwing or starting work", async (signal) => {
		vi.useFakeTimers();
		const options = setup();
		await expect(suggestJevSkill(REQUEST, SKILLS, { ...options, signal: signal as AbortSignal })).resolves.toEqual({
			reason: "unsupported-input",
		});
		expect(options.fetch).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each([1, 2])(
		"immediately cancels HTTP pass %s that ignores abort and discards its late response",
		async (pass) => {
			vi.useFakeTimers();
			const caller = new AbortController();
			const transport = deferred<Response>();
			const options = setup();
			options.fetch.mockReset();
			if (pass === 2) options.fetch.mockResolvedValueOnce(response(firstAnswers()));
			options.fetch.mockReturnValueOnce(transport.promise);
			const settled = vi.fn();
			void suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal }).then(settled);
			await vi.advanceTimersByTimeAsync(0);
			expect(options.fetch).toHaveBeenCalledTimes(pass);
			const requestSignal = options.fetch.mock.calls[0][1]!.signal!;
			for (const [, init] of options.fetch.mock.calls) expect(init!.signal).toBe(requestSignal);
			for (const [, signal] of options.loadExcerpt.mock.calls) expect(signal).toBe(requestSignal);

			caller.abort(new Error("Session cancelled"));
			expect(requestSignal.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
			expect(getEventListeners(caller.signal, "abort")).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);

			const late = response(pass === 1 ? firstAnswers() : secondAnswers());
			const parse = vi.spyOn(late, "json");
			transport.resolve(late);
			await vi.advanceTimersByTimeAsync(0);
			expect(parse).not.toHaveBeenCalled();
			expect(options.fetch).toHaveBeenCalledTimes(pass);
			expect(options.loadExcerpt).toHaveBeenCalledTimes(pass === 1 ? 0 : 2);
			expect(settled).toHaveBeenCalledTimes(1);
		},
	);

	test.each([1, 2])("immediately cancels JSON parsing in pass %s even when it ignores abort", async (pass) => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const body = deferred<unknown>();
		const reply = response(pass === 1 ? firstAnswers() : secondAnswers());
		const parse = vi.spyOn(reply, "json").mockReturnValue(body.promise);
		const options = setup();
		options.fetch.mockReset();
		if (pass === 2) options.fetch.mockResolvedValueOnce(response(firstAnswers()));
		options.fetch.mockResolvedValueOnce(reply);
		const settled = vi.fn();
		void suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal }).then(settled);
		await vi.advanceTimersByTimeAsync(0);
		expect(parse).toHaveBeenCalledTimes(1);

		caller.abort();
		expect(options.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
		expect(getEventListeners(caller.signal, "abort")).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		body.resolve({ answers: pass === 1 ? firstAnswers() : secondAnswers() });
		await vi.advanceTimersByTimeAsync(0);
		expect(options.fetch).toHaveBeenCalledTimes(pass);
		expect(options.loadExcerpt).toHaveBeenCalledTimes(pass === 1 ? 0 : 2);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	test.each(["resolve", "reject"])(
		"cancels pending excerpts and consumes their late %s without a second request",
		async (outcome) => {
			vi.useFakeTimers();
			const caller = new AbortController();
			const excerpt = deferred<string>();
			const options = setup();
			options.loadExcerpt.mockReturnValue(excerpt.promise);
			const settled = vi.fn();
			void suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal }).then(settled);
			await vi.advanceTimersByTimeAsync(0);
			expect(options.loadExcerpt).toHaveBeenCalledTimes(2);
			const requestSignal = options.fetch.mock.calls[0][1]!.signal!;
			for (const [, signal] of options.loadExcerpt.mock.calls) expect(signal).toBe(requestSignal);

			caller.abort();
			expect(requestSignal.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
			expect(getEventListeners(caller.signal, "abort")).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
			if (outcome === "resolve") excerpt.resolve("Late documentation");
			else excerpt.reject(new Error("Late read failure"));
			await vi.advanceTimersByTimeAsync(0);
			expect(options.fetch).toHaveBeenCalledTimes(1);
			expect(settled).toHaveBeenCalledTimes(1);
		},
	);

	test.each(["first-fetch", "excerpt", "second-body"])(
		"prevents selection when %s cancels synchronously while completing",
		async (phase) => {
			vi.useFakeTimers();
			const caller = new AbortController();
			const options = setup();
			if (phase === "first-fetch") {
				options.fetch.mockReset().mockImplementationOnce(async () => {
					caller.abort();
					return response(firstAnswers());
				});
			} else if (phase === "excerpt") {
				options.loadExcerpt.mockImplementation(async () => {
					caller.abort();
					return "Completed documentation";
				});
			} else {
				const reply = response(secondAnswers());
				vi.spyOn(reply, "json").mockImplementation(async () => {
					caller.abort();
					return { answers: secondAnswers() };
				});
				options.fetch.mockReset().mockResolvedValueOnce(response(firstAnswers())).mockResolvedValueOnce(reply);
			}
			await expect(suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal })).resolves.toEqual({
				reason: "unavailable",
			});
			expect(options.fetch).toHaveBeenCalledTimes(phase === "second-body" ? 2 : 1);
			expect(options.loadExcerpt).toHaveBeenCalledTimes(phase === "first-fetch" ? 0 : phase === "excerpt" ? 1 : 2);
			expect(options.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
			expect(getEventListeners(caller.signal, "abort")).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	test.each(["selected", "first-none", "second-none", "low-confidence", "unavailable", "unsupported-input"])(
		"removes only its own external listener and timer after %s",
		async (outcome) => {
			vi.useFakeTimers();
			const caller = new AbortController();
			const otherListener = vi.fn();
			caller.signal.addEventListener("abort", otherListener);
			const options = setup(
				firstAnswers(outcome === "first-none" ? "none" : "skill_0"),
				secondAnswers(outcome === "second-none" ? "none" : "skill_0", outcome === "low-confidence" ? 0.5 : 0.9),
			);
			if (outcome === "unavailable")
				options.fetch.mockReset().mockResolvedValueOnce(new Response(null, { status: 401 }));
			const result = await suggestJevSkill(outcome === "unsupported-input" ? "" : REQUEST, SKILLS, {
				...options,
				signal: caller.signal,
			});
			expect(result.reason).toBe(outcome.endsWith("-none") ? "no-match" : outcome);
			expect(getEventListeners(caller.signal, "abort")).toEqual([otherListener]);
			expect(vi.getTimerCount()).toBe(0);

			const requestSignal = options.fetch.mock.calls[0]?.[1]?.signal;
			const wasAborted = requestSignal?.aborted;
			const calls = options.fetch.mock.calls.length;
			caller.abort();
			await vi.advanceTimersByTimeAsync(3000);
			expect(otherListener).toHaveBeenCalledTimes(1);
			expect(requestSignal?.aborted).toBe(wasAborted);
			expect(options.fetch).toHaveBeenCalledTimes(calls);
		},
	);

	test("preserves the shared 1500ms deadline with an active caller signal and detaches on timeout", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const first = deferred<Response>();
		const options = setup();
		options.fetch.mockReset().mockReturnValueOnce(first.promise);
		const settled = vi.fn();
		void suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal }).then(settled);
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1499);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toHaveBeenCalledExactlyOnceWith({ reason: "unavailable" });
		expect(options.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
		expect(caller.signal.aborted).toBe(false);
		expect(getEventListeners(caller.signal, "abort")).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		first.reject(new Error("Late transport failure"));
		await vi.advanceTimersByTimeAsync(0);
		expect(options.fetch).toHaveBeenCalledTimes(1);
	});

	test("fails open and removes a listener even if caller listener registration throws after attaching it", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const addListener = caller.signal.addEventListener.bind(caller.signal);
		vi.spyOn(caller.signal, "addEventListener").mockImplementation((...args) => {
			addListener(...args);
			throw new Error("Invalid signal listener registration");
		});
		const options = setup();
		await expect(suggestJevSkill(REQUEST, SKILLS, { ...options, signal: caller.signal })).resolves.toEqual({
			reason: "unavailable",
		});
		expect(options.fetch).not.toHaveBeenCalled();
		expect(options.loadExcerpt).not.toHaveBeenCalled();
		expect(getEventListeners(caller.signal, "abort")).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
