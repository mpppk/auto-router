import { describe, expect, test } from "bun:test";
import { detectStructuralRequirements } from "../src/core/structural";
import type { RequestFeatures } from "../src/core/types";

const features = (
	overrides: Partial<RequestFeatures> = {},
): RequestFeatures => ({
	contentParts: [],
	...overrides,
});

const capabilities = (f: RequestFeatures): string[] =>
	detectStructuralRequirements(f).requirements.map((r) => r.capability);

describe("detectStructuralRequirements", () => {
	test("plain text request has no structural requirements", () => {
		const analysis = detectStructuralRequirements(features());
		expect(analysis.requirements).toEqual([]);
		expect(analysis.requireParameters).toBe(false);
	});

	test("detects input modalities once each with their source", () => {
		const analysis = detectStructuralRequirements(
			features({
				contentParts: [
					{ type: "image_url", path: "messages[0].content[1]" },
					{ type: "image_url", path: "messages[1].content[1]" },
					{ type: "input_audio", path: "messages[1].content[2]" },
					{ type: "video_url", path: "messages[2].content[0]" },
					{ type: "file", path: "messages[2].content[1]" },
					{ type: "unknown_part", path: "messages[2].content[2]" },
				],
			}),
		);
		expect(analysis.requirements).toEqual([
			{
				kind: "structural",
				capability: "input.image",
				source: "messages[0].content[1]",
			},
			{
				kind: "structural",
				capability: "input.audio",
				source: "messages[1].content[2]",
			},
			{
				kind: "structural",
				capability: "input.video",
				source: "messages[2].content[0]",
			},
			{
				kind: "structural",
				capability: "input.file",
				source: "messages[2].content[1]",
			},
		]);
		// modality は provider parameter ではない
		expect(analysis.requireParameters).toBe(false);
	});

	test("function tools require tool calling support", () => {
		const analysis = detectStructuralRequirements(
			features({ tools: [{ type: "function", function: { name: "f" } }] }),
		);
		expect(analysis.requirements.map((r) => r.capability)).toEqual(["tools"]);
		expect(analysis.requireParameters).toBe(true);
	});

	test("server tools alone are not a tool-calling structural requirement", () => {
		expect(
			capabilities(features({ tools: [{ type: "openrouter:web_search" }] })),
		).toEqual([]);
	});

	test.each([
		[{ type: "json_schema", json_schema: {} }, ["structured_output"]],
		[{ type: "json_object" }, ["json_output"]],
		[{ type: "text" }, []],
	])("response_format %j", (responseFormat, expected) => {
		expect(capabilities(features({ responseFormat }))).toEqual(expected);
	});

	test.each([
		[{ reasoning: { effort: "high" } }, true],
		[{ reasoning: { max_tokens: 1000 } }, true],
		[{ reasoning: { enabled: true } }, true],
		[{ reasoning: { enabled: false } }, false],
		[{ reasoning: { effort: "none" } }, false],
		[{ reasoningEffort: "medium" }, true],
		[{ reasoningEffort: "none" }, false],
		[{ includeReasoning: true }, true],
		[{ includeReasoning: false }, false],
	])("reasoning %j → %p", (overrides, expected) => {
		expect(capabilities(features(overrides)).includes("reasoning")).toBe(
			expected,
		);
	});

	test("keeps caller provider preferences as-is", () => {
		const provider = {
			only: ["openai"],
			ignore: ["azure"],
			order: ["openai"],
			zdr: true,
			data_collection: "deny" as const,
			quantizations: ["fp8"],
			custom: 1,
		};
		expect(detectStructuralRequirements(features({ provider })).provider).toBe(
			provider,
		);
	});
});
