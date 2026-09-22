import { open } from "node:fs/promises";
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import type { Skill } from "../core/skills.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import {
	JEV_EXCERPT_CHARS,
	JEV_MAX_REQUEST_CHARS,
	JEV_MAX_SKILLS,
	suggestJevSkill,
} from "./jev-skill-router/router.ts";

export interface StepJevSkillRouterOptions {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
}

// Read just the beginning, even when a skill bundles a very large reference.
const MAX_SKILL_PREFIX_BYTES = 16_384;

async function readSkillExcerpt(skill: Skill, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const file = await open(skill.filePath, "r");
	try {
		signal.throwIfAborted();
		const buffer = Buffer.alloc(MAX_SKILL_PREFIX_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		signal.throwIfAborted();
		const prefix = buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.replace(/^\uFEFF/, "")
			.replace(/\r\n?/g, "\n");
		// A frontmatter block larger than the read limit has no body to disclose.
		if (prefix.startsWith("---") && !prefix.includes("\n---", 3)) return "";
		return stripFrontmatter(prefix).slice(0, JEV_EXCERPT_CHARS);
	} finally {
		await file.close();
	}
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Optional skill suggestions, using Pi's existing per-prompt extension hook. */
export function createStepJevSkillRouterExtension(options: StepJevSkillRouterOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		if (env.STEP_JEV_SKILL_ROUTING !== "1") return;
		const apiKey = env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim();
		if (!apiKey) return;

		pi.on("before_agent_start", async (event, ctx) => {
			const prompt = event.prompt.trim();
			if (!prompt || prompt.length > JEV_MAX_REQUEST_CHARS || event.images?.length) return;
			// Expanded manual commands contain full skill bodies; never classify them.
			if (prompt.startsWith("/skill:") || prompt.startsWith("<skill ")) return;
			const { selectedTools, skills: loadedSkills = [] } = event.systemPromptOptions;
			if (selectedTools && !selectedTools.some((name) => name === "read" || name === "read_file")) return;
			if (loadedSkills.some((skill) => prompt.includes(`$${skill.name}`))) return;

			const skills = loadedSkills.filter((skill) => !skill.disableModelInvocation);
			if (skills.length < 2 || skills.length > JEV_MAX_SKILLS) return;
			const byName = new Map(skills.map((skill) => [skill.name, skill]));
			if (byName.size !== skills.length) return;

			const result = await suggestJevSkill(
				event.prompt,
				skills.map(({ name, description }) => ({ name, description })),
				{
					apiKey,
					fetch: options.fetch,
					signal: ctx.signal,
					loadExcerpt: async (candidate, signal) => {
						const skill = byName.get(candidate.name);
						if (!skill) throw new Error("Skill is not eligible for automatic routing");
						return readSkillExcerpt(skill, signal);
					},
				},
			);
			if (result.reason !== "selected" || !result.skillName || !byName.has(result.skillName)) return;

			// Preserve the catalog and the preceding cache prefix. The runtime resets
			// this override before the next prompt, including after a failed route.
			return {
				systemPrompt:
					`${event.systemPrompt}\n\n<skill_relevance>\n` +
					`Jev suggests considering ${escapeXml(result.skillName)} for this request. ` +
					"Read its skill file if it fits the user's task. " +
					"Explicit skill requests and project instructions take precedence; other skills remain available.\n" +
					"</skill_relevance>",
			};
		});
	};
}

export function createStepJevSkillRouterExtensionInline(options: StepJevSkillRouterOptions = {}): InlineExtension {
	return {
		name: "Jev skill routing",
		factory: createStepJevSkillRouterExtension(options),
		hidden: true,
	};
}
