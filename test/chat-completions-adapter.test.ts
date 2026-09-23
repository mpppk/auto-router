import { describe, expect, test } from "bun:test";
import { chatCompletionsAdapter as adapter } from "../src/adapters/chat-completions";
import { RouterError } from "../src/core/errors";

describe("chatCompletionsAdapter.parseRequest", () => {
	test.each([
		["non-object body", []],
		["non-string model", { model: 1, messages: [] }],
		["non-array models", { models: "a", messages: [] }],
		["models with non-string", { models: ["a", 1], messages: [] }],
		["missing messages", { model: "a" }],
		["non-array tools", { model: "a", messages: [], tools: {} }],
		["non-object provider", { model: "a", messages: [], provider: "x" }],
	])("rejects %s", (_, body) => {
		expect(() => adapter.parseRequest(body)).toThrow(RouterError);
	});
});

describe("chatCompletionsAdapter.extractRoutingContext", () => {
	test("separates conversation from instructions and skips tool results", () => {
		const request = adapter.parseRequest({
			model: "a",
			messages: [
				{ role: "system", content: "be nice" },
				{ role: "developer", content: [{ type: "text", text: "dev" }] },
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image_url", image_url: { url: "data:..." } },
					],
				},
				{ role: "assistant", content: null, tool_calls: [{ id: "1" }] },
				{ role: "tool", tool_call_id: "1", content: "huge tool result" },
				{ role: "assistant", content: "answer" },
			],
		});
		const context = adapter.extractRoutingContext(request);
		expect(context.instructions).toEqual(["be nice", "dev"]);
		expect(context.conversation).toEqual([
			{ role: "user", text: "what is this?" },
			{ role: "assistant", text: "answer" },
		]);
		expect(context.features.contentParts).toEqual([
			{ type: "image_url", path: "messages[2].content[1]" },
		]);
	});
});

describe("agentLoopTurns", () => {
	const context = (messages: unknown[]) =>
		adapter.extractRoutingContext(adapter.parseRequest({ messages }))
			.agentLoopTurns;
	const toolCall = {
		role: "assistant",
		content: null,
		tool_calls: [{ id: "call_1", type: "function" }],
	};
	const toolResult = { role: "tool", tool_call_id: "call_1", content: "ok" };

	test("0 for a new user turn", () => {
		expect(context([{ role: "user", content: "hi" }])).toBe(0);
		expect(
			context([
				{ role: "user", content: "a" },
				toolCall,
				toolResult,
				{ role: "assistant", content: "done" },
				{ role: "user", content: "b" },
			]),
		).toBe(0);
	});

	test("counts assistant tool calls after the latest user message", () => {
		expect(
			context([
				{ role: "user", content: "a" },
				toolCall,
				toolResult,
				toolCall,
				toolResult,
			]),
		).toBe(2);
	});
});

describe("chatCompletionsAdapter.applyRoutePlan", () => {
	const request = adapter.parseRequest({
		model: "a",
		models: ["b", "c"],
		messages: [{ role: "user", content: "hi" }],
		temperature: 0.3,
		plugins: [{ id: "unknown-extension" }],
		some_future_field: { nested: true },
	});

	test("keeps request untouched when the chain is unchanged", () => {
		const patched = adapter.applyRoutePlan(request, {
			modelChain: ["a", "b", "c"],
		});
		expect(patched).toEqual(request);
		expect(patched).not.toBe(request);
	});

	test("rewrites model/models and preserves unknown fields", () => {
		const patched = adapter.applyRoutePlan(request, {
			modelChain: ["c", "b"],
			tools: [{ type: "openrouter:web_search" }],
			toolChoice: { value: "auto" },
			provider: { require_parameters: true },
		});
		expect(patched).toEqual({
			model: "c",
			models: ["b"],
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.3,
			plugins: [{ id: "unknown-extension" }],
			some_future_field: { nested: true },
			tools: [{ type: "openrouter:web_search" }],
			tool_choice: "auto",
			provider: { require_parameters: true },
		});
	});

	test("drops models when a single model remains", () => {
		const patched = adapter.applyRoutePlan(request, { modelChain: ["c"] });
		expect(patched.model).toBe("c");
		expect("models" in patched).toBe(false);
	});
});

describe("chatCompletionsAdapter features", () => {
	test("exposes structural request fields", () => {
		const request = adapter.parseRequest({
			model: "a",
			messages: [],
			tools: [{ type: "function", function: { name: "f" } }],
			tool_choice: "none",
			response_format: { type: "json_object" },
			reasoning: { effort: "high" },
			reasoning_effort: "low",
			include_reasoning: true,
			provider: { only: ["openai"] },
		});
		expect(adapter.extractRoutingContext(request).features).toEqual({
			contentParts: [],
			tools: [{ type: "function", function: { name: "f" } }],
			toolChoice: "none",
			responseFormat: { type: "json_object" },
			reasoning: { effort: "high" },
			reasoningEffort: "low",
			includeReasoning: true,
			provider: { only: ["openai"] },
		});
	});
});
