import { describe, expect, test } from "bun:test";
import {
	createStaticModelCatalog,
	type ModelProfile,
} from "../src/catalog/model-catalog";
import { SEMANTIC_CAPABILITIES } from "../src/core/capabilities";
import {
	DEFAULT_GROK_MODEL,
	isGrok4OrLater,
	SEMANTIC_REGISTRY,
	STRUCTURAL_REGISTRY,
	WEB_SEARCH_TOOL_TYPE,
} from "../src/core/registry";

const profile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
	id: "m",
	inputModalities: ["text"],
	supportedParameters: [],
	...overrides,
});

describe("isGrok4OrLater", () => {
	test.each([
		["x-ai/grok-4.7", true],
		["x-ai/grok-4", true],
		["x-ai/grok-5-fast", true],
		["x-ai/grok-4.20", true],
		["x-ai/grok-4.3:batch", true],
		["~x-ai/grok-latest", true],
		["x-ai/grok-4.20-multi-agent", false],
		["x-ai/grok-3", false],
		["x-ai/grok-build-0.1", false],
		["openai/gpt-5", false],
	])("%s → %p", (model, expected) => {
		expect(isGrok4OrLater(model)).toBe(expected);
	});
});

describe("SEMANTIC_REGISTRY", () => {
	test("defines every semantic capability", () => {
		expect(Object.keys(SEMANTIC_REGISTRY).sort()).toEqual(
			[...SEMANTIC_CAPABILITIES].sort(),
		);
	});

	test("social.x.search default route is a Grok 4+ model with native X search", () => {
		const def = SEMANTIC_REGISTRY["social.x.search"];
		expect(def.defaultRoute?.model).toBe(DEFAULT_GROK_MODEL);
		expect(isGrok4OrLater(DEFAULT_GROK_MODEL)).toBe(true);
		expect(def.serverTool?.type).toBe(WEB_SEARCH_TOOL_TYPE);
		const { engine, x_search } = def.serverTool?.parameters ?? {};
		expect(engine?.(undefined)).toEqual({ value: "native" });
		expect(engine?.("auto")).toEqual({ value: "native" });
		expect(engine?.("exa")).toHaveProperty("conflict");
		expect(x_search?.(undefined)).toEqual({ value: {} });
		const filters = { allowed_x_handles: ["a"] };
		expect(x_search?.(filters)).toEqual({ value: filters });
		expect(x_search?.(false)).toHaveProperty("conflict");
	});

	test("web.search uses openrouter:web_search", () => {
		const def = SEMANTIC_REGISTRY["web.search"];
		expect(def.serverTool?.type).toBe(WEB_SEARCH_TOOL_TYPE);
		expect(def.support("a", profile({ supportedParameters: ["tools"] }))).toBe(
			"supported",
		);
		expect(def.support("a", profile())).toBe("unsupported");
		expect(def.support("a", undefined)).toBe("unknown");
		expect(def.support(DEFAULT_GROK_MODEL, undefined)).toBe("supported");
	});

	test.each([
		"places.search",
		"places.opening_hours",
		"places.reviews",
		"geo.proximity",
		"source.google_maps",
	] as const)("%s is unsupported in MVP", (capability) => {
		const def = SEMANTIC_REGISTRY[capability];
		expect(def.defaultRoute).toBeUndefined();
		expect(def.support(DEFAULT_GROK_MODEL, profile())).toBe("unsupported");
	});
});

describe("STRUCTURAL_REGISTRY", () => {
	test("evaluates support from the model profile", () => {
		const vision = profile({
			inputModalities: ["text", "image"],
			supportedParameters: ["tools", "structured_outputs", "reasoning"],
		});
		expect(STRUCTURAL_REGISTRY["input.image"].support("m", vision)).toBe(
			"supported",
		);
		expect(STRUCTURAL_REGISTRY["input.audio"].support("m", vision)).toBe(
			"unsupported",
		);
		expect(STRUCTURAL_REGISTRY.tools.support("m", vision)).toBe("supported");
		expect(STRUCTURAL_REGISTRY.structured_output.support("m", vision)).toBe(
			"supported",
		);
		expect(STRUCTURAL_REGISTRY.reasoning.support("m", vision)).toBe(
			"supported",
		);
		expect(STRUCTURAL_REGISTRY["input.image"].support("m", undefined)).toBe(
			"unknown",
		);
	});
});

describe("createStaticModelCatalog", () => {
	test("falls back to the base model for variant suffixes", () => {
		const catalog = createStaticModelCatalog([profile({ id: "a/b" })]);
		expect(catalog.lookup("a/b")?.id).toBe("a/b");
		expect(catalog.lookup("a/b:nitro")?.id).toBe("a/b");
		expect(catalog.lookup("a/c")).toBeUndefined();
	});
});
