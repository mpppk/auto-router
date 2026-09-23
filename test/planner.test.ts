import { describe, expect, test } from "bun:test";
import type { ModelProfile } from "../src/catalog/model-catalog";
import type { Requirement } from "../src/core/capabilities";
import {
	blocksServerTools,
	buildRequestPatch,
	buildRoutePlan,
} from "../src/core/planner";
import type { RequestFeatures } from "../src/core/types";
import { required, structural } from "./helpers/requirements";

const features = (
	overrides: Partial<RequestFeatures> = {},
): RequestFeatures => ({
	contentParts: [],
	...overrides,
});

const fn = { type: "function", function: { name: "lookup", parameters: {} } };

const plan = (
	model: string,
	requirements: Requirement[],
	f: RequestFeatures,
	options: { profile?: ModelProfile; requireParameters?: boolean } = {},
) =>
	buildRoutePlan({
		model,
		profile: options.profile,
		requirements,
		features: f,
		patch: buildRequestPatch(
			requirements,
			f,
			options.requireParameters ?? false,
		),
	});

const grokProfile: ModelProfile = {
	id: "x-ai/grok-4.7",
	inputModalities: ["text", "image"],
	supportedParameters: [
		"tools",
		"tool_choice",
		"structured_outputs",
		"reasoning",
	],
};

describe("buildRequestPatch: tool merge", () => {
	test("X Search: injects web_search with native engine and x_search, keeping caller function tools", () => {
		const patch = buildRequestPatch(
			[required("social.x.search")],
			features({ tools: [fn] }),
			false,
		);
		const xSearch = {
			type: "openrouter:web_search",
			parameters: { engine: "native", x_search: {} },
		};
		expect(patch.tools).toEqual([fn, xSearch]);
		expect(patch.injectedTools).toEqual([xSearch]);
		expect(patch.conflicts).toEqual([]);
	});

	test("web.search: injects a bare web_search tool", () => {
		const patch = buildRequestPatch(
			[required("web.search")],
			features(),
			false,
		);
		expect(patch.tools).toEqual([{ type: "openrouter:web_search" }]);
	});

	test("web.search + X Search share a single web_search tool", () => {
		const patch = buildRequestPatch(
			[required("web.search"), required("social.x.search")],
			features(),
			false,
		);
		expect(patch.tools).toEqual([
			{
				type: "openrouter:web_search",
				parameters: { engine: "native", x_search: {} },
			},
		]);
	});

	test("does not duplicate an existing server tool and completes missing parameters", () => {
		const callerTool = {
			type: "openrouter:web_search",
			parameters: { max_results: 3, x_search: { allowed_x_handles: ["a"] } },
		};
		const patch = buildRequestPatch(
			[required("social.x.search")],
			features({ tools: [fn, callerTool] }),
			false,
		);
		const completed = {
			type: "openrouter:web_search",
			parameters: {
				max_results: 3,
				x_search: { allowed_x_handles: ["a"] },
				engine: "native",
			},
		};
		expect(patch.tools).toEqual([fn, completed]);
		expect(patch.injectedTools).toEqual([]);
		expect(patch.completedTools).toEqual([completed]);
	});

	test("leaves tools untouched when the existing server tool already satisfies the requirement", () => {
		const callerTool = {
			type: "openrouter:web_search",
			parameters: { engine: "native", x_search: {} },
		};
		const patch = buildRequestPatch(
			[required("social.x.search")],
			features({ tools: [callerTool] }),
			false,
		);
		expect(patch.tools).toBeUndefined();
		expect(patch.injectedTools).toEqual([]);
	});

	test("caller parameter that would change meaning → tool_parameter_conflict", () => {
		const patch = buildRequestPatch(
			[required("social.x.search")],
			features({
				tools: [
					{ type: "openrouter:web_search", parameters: { engine: "exa" } },
				],
			}),
			false,
		);
		expect(patch.conflicts).toEqual([
			expect.objectContaining({
				code: "tool_parameter_conflict",
				capability: "social.x.search",
			}),
		]);
	});

	test("no semantic requirement → no tool change", () => {
		const patch = buildRequestPatch(
			[structural("tools")],
			features({ tools: [fn] }),
			false,
		);
		expect(patch.tools).toBeUndefined();
		expect(patch.toolChoice).toBeUndefined();
	});
});

describe("tool_choice", () => {
	const required_ = new Set(["openrouter:web_search"]);

	test.each([
		["none", true],
		[{ type: "function", function: { name: "lookup" } }, true],
		["auto", false],
		["required", false],
		[undefined, false],
		[{ type: "openrouter:web_search" }, false],
	])("%j blocks=%p", (toolChoice, expected) => {
		expect(blocksServerTools(toolChoice, required_)).toBe(expected);
	});

	test("X Search already configured + tool_choice none → auto without adding tools", () => {
		const patch = buildRequestPatch(
			[required("social.x.search")],
			features({
				tools: [
					{
						type: "openrouter:web_search",
						parameters: { engine: "native", x_search: {} },
					},
				],
				toolChoice: "none",
			}),
			false,
		);
		expect(patch.tools).toBeUndefined();
		expect(patch.toolChoice).toEqual({ value: "auto" });
	});

	test("unrelated forced function → auto", () => {
		const patch = buildRequestPatch(
			[required("web.search")],
			features({
				tools: [fn],
				toolChoice: { type: "function", function: { name: "lookup" } },
			}),
			false,
		);
		expect(patch.toolChoice).toEqual({ value: "auto" });
	});

	test("auto is not changed", () => {
		const patch = buildRequestPatch(
			[required("web.search")],
			features({ toolChoice: "auto" }),
			false,
		);
		expect(patch.toolChoice).toBeUndefined();
	});

	test("tool_choice none without required server tools is kept", () => {
		const patch = buildRequestPatch(
			[structural("tools")],
			features({ tools: [fn], toolChoice: "none" }),
			true,
		);
		expect(patch.toolChoice).toBeUndefined();
	});
});

describe("provider enforcement", () => {
	test("structural parameter requirement → require_parameters true, caller restrictions kept", () => {
		const provider = {
			only: ["openai", "azure"],
			ignore: ["foo"],
			order: ["openai"],
			zdr: true,
			data_collection: "deny" as const,
			require_parameters: false,
		};
		const patch = buildRequestPatch(
			[structural("structured_output")],
			features({ provider }),
			true,
		);
		expect(patch.provider).toEqual({ ...provider, require_parameters: true });
		expect(patch.requireParametersOverridden).toBe(true);
	});

	test("no enforcement when not requested", () => {
		const patch = buildRequestPatch(
			[required("web.search")],
			features(),
			false,
		);
		expect(patch.provider).toBeUndefined();
		expect(patch.requireParametersOverridden).toBe(false);
	});
});

describe("buildRoutePlan", () => {
	test("Grok candidate with X Search required is compatible", () => {
		const p = plan("x-ai/grok-4.7", [required("social.x.search")], features(), {
			profile: grokProfile,
		});
		expect(p.conflicts).toEqual([]);
		expect(p.effectiveTools).toEqual([
			{
				type: "openrouter:web_search",
				parameters: { engine: "native", x_search: {} },
			},
		]);
	});

	test("non-Grok candidate cannot do X Search", () => {
		const p = plan(
			"anthropic/claude-sonnet-5",
			[required("social.x.search")],
			features(),
		);
		expect(p.conflicts.map((c) => c.code)).toEqual(["capability_unsupported"]);
	});

	test("unknown support for a semantic requirement is rejected", () => {
		const p = plan("unknown/model", [required("web.search")], features());
		expect(p.conflicts.map((c) => c.code)).toEqual(["capability_unknown"]);
	});

	test("web.search is satisfied by a tool-capable requested model without override", () => {
		const p = plan(
			"anthropic/claude-sonnet-5",
			[required("web.search")],
			features(),
			{
				profile: {
					id: "anthropic/claude-sonnet-5",
					inputModalities: ["text", "image"],
					supportedParameters: ["tools"],
				},
			},
		);
		expect(p.conflicts).toEqual([]);
	});

	test("Places requirements are never supported", () => {
		const p = plan("x-ai/grok-4.7", [required("places.search")], features(), {
			profile: grokProfile,
		});
		expect(p.conflicts.map((c) => c.code)).toEqual(["capability_unsupported"]);
	});

	test("structural requirement lost by candidate → structural_unsupported", () => {
		const p = plan(
			"text/only",
			[structural("input.image", "messages[0].content[1]")],
			features(),
			{
				profile: {
					id: "text/only",
					inputModalities: ["text"],
					supportedParameters: [],
				},
			},
		);
		expect(p.conflicts.map((c) => c.code)).toEqual(["structural_unsupported"]);
	});

	test("unknown structural support is accepted (enforced by require_parameters)", () => {
		const p = plan(
			"unknown/model",
			[structural("tools")],
			features({ tools: [fn] }),
			{
				requireParameters: true,
			},
		);
		expect(p.conflicts).toEqual([]);
		expect(p.effectiveProvider).toEqual({ require_parameters: true });
	});

	test("provider restriction excluding xAI conflicts with X Search", () => {
		const p = plan(
			"x-ai/grok-4.7",
			[required("social.x.search")],
			features({ provider: { only: ["openai"] } }),
			{ profile: grokProfile },
		);
		expect(p.conflicts.map((c) => c.code)).toEqual(["provider_conflict"]);
	});

	test("X Search + image + json_schema + caller tools are all preserved", () => {
		const f = features({
			tools: [fn],
			responseFormat: { type: "json_schema", json_schema: {} },
			provider: { order: ["xai"] },
		});
		const p = plan(
			"x-ai/grok-4.7",
			[
				required("social.x.search"),
				structural("input.image"),
				structural("tools"),
				structural("structured_output"),
			],
			f,
			{ profile: grokProfile, requireParameters: true },
		);
		expect(p.conflicts).toEqual([]);
		expect(p.effectiveTools?.[0]).toEqual(fn);
		expect(p.effectiveProvider).toEqual({
			order: ["xai"],
			require_parameters: true,
		});
	});
});
