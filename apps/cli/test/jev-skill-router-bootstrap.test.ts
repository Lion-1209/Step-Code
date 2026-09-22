import type { ExtensionAPI } from "@step-harness/coding-agent";
import { expect, it, vi } from "vitest";
import { createStepExtensionFactories } from "../src/bootstrap/extensions.ts";

it("mounts Jev skill routing in the Step CLI without enabling outbound calls by default", async () => {
	vi.stubEnv("STEP_JEV_SKILL_ROUTING", "");
	const extensions = createStepExtensionFactories({
		telemetry: { track: vi.fn() },
		traceHeaderPolicy: { allowedBaseUrls: [], highSensitivityFields: [] },
		stepSettings: undefined,
		feedbackIdentity: undefined,
		permission: undefined,
		stepCodeProviderExtension: undefined,
	});
	const router = extensions.find((extension) => extension.name === "Jev skill routing");
	if (!router || typeof router === "function") throw new Error("Jev inline extension is missing");
	const on = vi.fn();
	await router.factory({ on } as unknown as ExtensionAPI);
	expect(on).not.toHaveBeenCalled();
});
