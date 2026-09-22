export const JEV_MAX_SKILLS = 254;
export const JEV_MAX_REQUEST_CHARS = 12000;
export const JEV_EXCERPT_CHARS = 700;
export const JEV_TIMEOUT_MS = 1500;

export interface JevSkill {
	name: string;
	description: string;
}

export interface JevRoutingOptions {
	apiKey: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
	loadExcerpt: (skill: JevSkill, signal: AbortSignal) => Promise<string>;
}

export interface JevRoutingResult {
	skillName?: string;
	reason: "selected" | "no-match" | "low-confidence" | "unavailable" | "unsupported-input";
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MIN_CONFIDENCE = 0.6;
const MIN_FIT = 0.5;
const SHORTLIST_SIZE = 3;
// Allow rounding in an otherwise complete probability distribution.
const PROBABILITY_SUM_TOLERANCE = 0.01;
const NONE = "No documented skill would be useful for this specific task.";
const RANK_INSTRUCTIONS =
	"Which documented skill would be most useful for the user's specific request? Choose none if no skill would help.";
const VERIFY_INSTRUCTIONS =
	"Which skill best fits the user's specific request, considering its description and excerpt? Choose none if none fits.";
const NEEDS_INSTRUCTIONS = "Would any of these documented skills be useful for the user's specific request?\n";
const FIT_INSTRUCTIONS = "Does this skill, as documented below, fit the user's specific request?\n";

type Questions = Record<
	string,
	{ type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "noul"; instructions: string }
>;

interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readChoice(value: unknown, allowed: readonly string[]): ChoiceAnswer {
	if (
		!isRecord(value) ||
		value.type !== "choice" ||
		typeof value.choice !== "string" ||
		!allowed.includes(value.choice) ||
		!isProbability(value.confidence) ||
		!isRecord(value.probabilities) ||
		Object.keys(value.probabilities).length !== allowed.length
	) {
		throw new Error("Invalid Jev choice");
	}
	const probabilities: Record<string, number> = {};
	let total = 0;
	for (const id of allowed) {
		const probability = value.probabilities[id];
		if (!Object.hasOwn(value.probabilities, id) || !isProbability(probability)) {
			throw new Error("Invalid Jev probability");
		}
		probabilities[id] = probability;
		total += probability;
	}
	if (Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE) throw new Error("Invalid Jev distribution");
	return { type: "choice", choice: value.choice, probabilities, confidence: value.confidence };
}

function readNoul(value: unknown): number {
	if (!isRecord(value) || value.type !== "noul" || !isProbability(value.noul)) {
		throw new Error("Invalid Jev noul");
	}
	return value.noul;
}

export async function suggestJevSkill(
	request: string,
	skills: readonly JevSkill[],
	options: JevRoutingOptions,
): Promise<JevRoutingResult> {
	if (
		typeof request !== "string" ||
		!request.trim() ||
		request.length > JEV_MAX_REQUEST_CHARS ||
		!Array.isArray(skills) ||
		skills.length < 2 ||
		skills.length > JEV_MAX_SKILLS ||
		!isRecord(options) ||
		typeof options.apiKey !== "string" ||
		!options.apiKey.trim() ||
		typeof options.loadExcerpt !== "function" ||
		(options.fetch !== undefined && typeof options.fetch !== "function")
	) {
		return { reason: "unsupported-input" };
	}
	const names = new Set<string>();
	for (const skill of skills) {
		if (
			!isRecord(skill) ||
			typeof skill.name !== "string" ||
			!skill.name.trim() ||
			typeof skill.description !== "string" ||
			names.has(skill.name)
		) {
			return { reason: "unsupported-input" };
		}
		names.add(skill.name);
	}
	const timeoutMs = options.timeoutMs === undefined ? JEV_TIMEOUT_MS : options.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
		return { reason: "unsupported-input" };
	}

	let callerSignal: AbortSignal | undefined;
	try {
		callerSignal = options.signal;
		if (
			callerSignal !== undefined &&
			(!(callerSignal instanceof AbortSignal) ||
				typeof callerSignal.aborted !== "boolean" ||
				typeof callerSignal.addEventListener !== "function" ||
				typeof callerSignal.removeEventListener !== "function")
		) {
			return { reason: "unsupported-input" };
		}
		if (callerSignal?.aborted) return { reason: "unavailable" };
		// A forged prototype can pass instanceof without being a usable native signal.
		if (callerSignal) AbortSignal.prototype.throwIfAborted.call(callerSignal);
	} catch {
		return { reason: "unsupported-input" };
	}

	const controller = new AbortController();
	const fetch = options.fetch ?? globalThis.fetch;
	const deadline = performance.now() + timeoutMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel!: () => void;
	// Both interruption sources win even when injected readers/transports ignore abort.
	const interrupted = new Promise<JevRoutingResult>((resolve) => {
		cancel = () => {
			controller.abort();
			resolve({ reason: "unavailable" });
		};
	});

	function checkDeadline(): void {
		if (controller.signal.aborted || performance.now() >= deadline) throw new Error("Jev routing timed out");
	}

	async function post(questions: Questions): Promise<Record<string, unknown>> {
		checkDeadline();
		const body = JSON.stringify({ model: "jev-latest", state: { request }, questions });
		checkDeadline();
		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
			redirect: "error",
			signal: controller.signal,
			body,
		});
		checkDeadline();
		if (!response.ok || response.redirected) throw new Error("Jev request unavailable");
		const payload: unknown = await response.json();
		checkDeadline();
		if (!isRecord(payload) || !isRecord(payload.answers)) throw new Error("Invalid Jev answers");
		return payload.answers;
	}

	async function route(): Promise<JevRoutingResult> {
		const candidates = skills.map((skill, index) => ({ id: `skill_${index}`, skill, index }));
		const criteria: Record<string, string> = Object.fromEntries(
			candidates.map(({ id, skill }) => [id, JSON.stringify({ name: skill.name, description: skill.description })]),
		);
		const first = await post({
			which: { type: "choice", instructions: RANK_INSTRUCTIONS, criteria: { ...criteria, none: NONE } },
			// Each question is independent, so the Noul must carry its own documentation.
			needs_skill: { type: "noul", instructions: NEEDS_INSTRUCTIONS + Object.values(criteria).join("\n") },
		});
		const ranking = readChoice(first.which, [...candidates.map(({ id }) => id), "none"]);
		const needsSkill = readNoul(first.needs_skill);
		if (ranking.choice === "none" || needsSkill < MIN_FIT) return { reason: "no-match" };

		const shortlist = candidates
			.sort((a, b) => ranking.probabilities[b.id] - ranking.probabilities[a.id] || a.index - b.index)
			.slice(0, SHORTLIST_SIZE);
		const excerpts = await Promise.all(
			shortlist.map(async ({ id, skill }) => {
				checkDeadline();
				const excerpt = await options.loadExcerpt(skill, controller.signal);
				checkDeadline();
				if (typeof excerpt !== "string") throw new Error("Invalid skill excerpt");
				return [
					id,
					JSON.stringify({
						name: skill.name,
						description: skill.description,
						excerpt: excerpt.slice(0, JEV_EXCERPT_CHARS),
					}),
				] as const;
			}),
		);
		const questions: Questions = {
			which: {
				type: "choice",
				instructions: VERIFY_INSTRUCTIONS,
				criteria: { ...Object.fromEntries(excerpts), none: NONE },
			},
		};
		for (const [id, description] of excerpts) {
			questions[`fits_${id}`] = { type: "noul", instructions: FIT_INSTRUCTIONS + description };
		}
		const second = await post(questions);
		const selection = readChoice(second.which, [...shortlist.map(({ id }) => id), "none"]);
		const fits = new Map(shortlist.map(({ id }) => [id, readNoul(second[`fits_${id}`])]));
		if (selection.choice === "none") return { reason: "no-match" };
		if (selection.confidence < MIN_CONFIDENCE || fits.get(selection.choice)! < MIN_FIT) {
			return { reason: "low-confidence" };
		}
		return { reason: "selected", skillName: shortlist.find(({ id }) => id === selection.choice)!.skill.name };
	}

	try {
		timer = setTimeout(cancel, timeoutMs);
		callerSignal?.addEventListener("abort", cancel, { once: true });
		if (callerSignal?.aborted) cancel();
		const result = await Promise.race([route(), interrupted]);
		checkDeadline();
		return result;
	} catch {
		controller.abort();
		return { reason: "unavailable" };
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", cancel);
	}
}
