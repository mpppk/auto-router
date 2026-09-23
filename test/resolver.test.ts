import { describe, expect, test } from "bun:test";
import { createStaticModelCatalog } from "../src/catalog/model-catalog";
import type { SemanticRequirement } from "../src/core/capabilities";
import { ACCOUNT_DEFAULT_MODEL, resolveRoute } from "../src/core/resolver";
import { detectStructuralRequirements } from "../src/core/structural";
import type { RequestFeatures } from "../src/core/types";
import { MODEL_PROFILES } from "./helpers/app";
import { required } from "./helpers/requirements";

const CLAUDE = "anthropic/claude-sonnet-5";
const GPT = "openai/gpt-5";
const GROK = "x-ai/grok-4.7";
const GROK_OLD = "x-ai/grok-4.5";

const catalog = createStaticModelCatalog([
	...MODEL_PROFILES,
	{
		id: GROK_OLD,
		inputModalities: ["text", "image"],
		supportedParameters: ["tools", "structured_outputs"],
	},
	{
		id: "vision/no-audio",
		inputModalities: ["text", "image"],
		supportedParameters: ["tools"],
	},
]);

const resolve = (
	requestedChain: string[],
	semantic: SemanticRequirement[],
	options: {
		features?: Partial<RequestFeatures>;
		allowModelOverride?: boolean;
		degraded?: boolean;
	} = {},
) => {
	const features: RequestFeatures = { contentParts: [], ...options.features };
	return resolveRoute({
		requestedChain,
		semanticRequirements: semantic,
		semanticDegraded: options.degraded ?? false,
		structural: detectStructuralRequirements(features),
		features,
		catalog,
		allowModelOverride: options.allowModelOverride ?? true,
	});
};

const uncertain: SemanticRequirement = {
	kind: "semantic",
	capability: "social.x.search",
	decision: "uncertain",
	requiredProbability: 0.5,
};

describe("resolveRoute without Hard Requirements", () => {
	test("keeps the caller chain untouched", () => {
		const r = resolve([CLAUDE, GPT], [uncertain]);
		expect(r.reason).toBe("requested_model");
		expect(r.plan).toEqual({ modelChain: [CLAUDE, GPT] });
		expect(r.candidates).toEqual([]);
	});

	test("degraded semantic detection keeps the chain and reports degraded", () => {
		const r = resolve([CLAUDE], [], { degraded: true });
		expect(r.reason).toBe("degraded");
		expect(r.plan).toEqual({ modelChain: [CLAUDE] });
	});
});

describe("resolveRoute with Hard Requirements", () => {
	test("model=Claude, models=[GPT, Grok], X Search → only Grok remains", () => {
		const r = resolve([CLAUDE, GPT, GROK], [required("social.x.search")]);
		expect(r.reason).toBe("filtered_fallback_chain");
		expect(r.effectiveChain).toEqual([GROK]);
		expect(r.candidates.map((c) => [c.model, c.accepted])).toEqual([
			[CLAUDE, false],
			[GPT, false],
			[GROK, true],
		]);
		expect(r.plan?.tools).toEqual([
			{
				type: "openrouter:web_search",
				parameters: { engine: "native", x_search: {} },
			},
		]);
	});

	test("compatible primary stays first and incompatible fallbacks are removed", () => {
		const r = resolve([GROK, CLAUDE, GROK_OLD], [required("social.x.search")]);
		expect(r.effectiveChain).toEqual([GROK, GROK_OLD]);
		expect(r.reason).toBe("filtered_fallback_chain");
	});

	test("all compatible → requested_model with injected tool but same chain", () => {
		const r = resolve([GROK, GROK_OLD], [required("social.x.search")]);
		expect(r.reason).toBe("requested_model");
		expect(r.effectiveChain).toEqual([GROK, GROK_OLD]);
		expect(r.plan?.tools).toBeDefined();
	});

	test("requested model that satisfies via tool injection is not overridden", () => {
		const r = resolve([CLAUDE], [required("web.search")]);
		expect(r.reason).toBe("requested_model");
		expect(r.effectiveChain).toEqual([CLAUDE]);
		expect(r.plan?.tools).toEqual([{ type: "openrouter:web_search" }]);
	});

	test("chain wiped out + override=true → default route only", () => {
		const r = resolve([CLAUDE, GPT], [required("social.x.search")]);
		expect(r.reason).toBe("capability_override");
		expect(r.effectiveChain).toEqual([GROK]);
		expect(r.plan?.modelChain).toEqual([GROK]);
		expect(r.candidates.at(-1)).toMatchObject({
			model: GROK,
			origin: "default_route",
			accepted: true,
		});
	});

	test("chain wiped out + override=false → capability_not_supported", () => {
		const r = resolve([CLAUDE, GPT], [required("social.x.search")], {
			allowModelOverride: false,
		});
		expect(r.reason).toBe("capability_not_supported");
		expect(r.plan).toBeUndefined();
		expect(r.error?.code).toBe("capability_not_supported");
		expect(r.candidates.every((c) => c.origin === "requested")).toBe(true);
	});

	test("Places required → capability_not_supported even with override", () => {
		const r = resolve([GROK], [required("places.search")]);
		expect(r.error?.code).toBe("capability_not_supported");
	});

	test("Places + X Search cannot be satisfied by one route", () => {
		const r = resolve(
			[GROK],
			[required("social.x.search"), required("source.google_maps")],
		);
		expect(r.error?.code).toBe("capability_not_supported");
	});

	test("structural requirement is preserved on override (image + X Search)", () => {
		const r = resolve([CLAUDE], [required("social.x.search")], {
			features: {
				contentParts: [{ type: "image_url", path: "messages[0].content[1]" }],
			},
		});
		expect(r.effectiveChain).toEqual([GROK]);
		expect(r.hardRequirements.map((h) => h.capability)).toEqual([
			"social.x.search",
			"input.image",
		]);
	});

	test("multi-capability impossible on default route (audio + X Search) → not supported", () => {
		const r = resolve([CLAUDE], [required("social.x.search")], {
			features: {
				contentParts: [{ type: "input_audio", path: "messages[0].content[1]" }],
			},
		});
		expect(r.error?.code).toBe("capability_not_supported");
	});

	test("structural-only requirement filters out a model that would lose it", () => {
		const r = resolve(["text/no-tools", GPT], [], {
			features: { tools: [{ type: "function", function: { name: "f" } }] },
		});
		expect(r.reason).toBe("filtered_fallback_chain");
		expect(r.effectiveChain).toEqual([GPT]);
		expect(r.plan?.provider).toEqual({ require_parameters: true });
	});

	test("structural-only requirement with no compatible model → not supported (no default route)", () => {
		const r = resolve(["vision/no-audio"], [], {
			features: {
				contentParts: [{ type: "input_audio", path: "messages[0].content[0]" }],
			},
		});
		expect(r.error?.code).toBe("capability_not_supported");
	});

	test("unknown models are accepted for structural requirements", () => {
		const r = resolve(["some/unknown-model"], [], {
			features: { responseFormat: { type: "json_schema", json_schema: {} } },
		});
		expect(r.effectiveChain).toEqual(["some/unknown-model"]);
		expect(r.plan?.provider).toEqual({ require_parameters: true });
	});

	test("caller tool parameter conflict → capability_conflict", () => {
		const r = resolve([GROK], [required("social.x.search")], {
			features: {
				tools: [
					{ type: "openrouter:web_search", parameters: { engine: "exa" } },
				],
			},
		});
		expect(r.error?.code).toBe("capability_conflict");
	});

	test("provider restriction excluding xAI → capability_conflict", () => {
		const r = resolve([GROK], [required("social.x.search")], {
			features: { provider: { only: ["openai"] } },
		});
		expect(r.error?.code).toBe("capability_conflict");
	});

	test("provider preferences are kept on override", () => {
		const provider = { order: ["xai"], data_collection: "deny" as const };
		const r = resolve([CLAUDE], [required("social.x.search")], {
			features: {
				provider,
				tools: [{ type: "function", function: { name: "f" } }],
			},
		});
		expect(r.effectiveChain).toEqual([GROK]);
		expect(r.plan?.provider).toEqual({ ...provider, require_parameters: true });
	});

	test("no model specified: semantic requirement → default route", () => {
		const r = resolve([], [required("social.x.search")]);
		expect(r.effectiveChain).toEqual([GROK]);
		expect(r.reason).toBe("capability_override");
	});

	test("no model specified: structural-only → keep account default", () => {
		const r = resolve([], [], {
			features: { tools: [{ type: "function", function: { name: "f" } }] },
		});
		expect(r.reason).toBe("requested_model");
		expect(r.effectiveChain).toEqual([]);
		expect(r.candidates[0]?.model).toBe(ACCOUNT_DEFAULT_MODEL);
	});
});
