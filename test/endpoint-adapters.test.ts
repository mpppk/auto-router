import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
	messagesAdapter,
	normalizeMessagesToolChoice,
} from "../src/adapters/messages";
import { responsesAdapter } from "../src/adapters/responses";
import { RouterError } from "../src/core/errors";
import { detectStructuralRequirements } from "../src/core/structural";
import type { RoutingTrace } from "../src/trace/trace";
import { createTestApp, type FakeSemantic } from "./helpers/app";
import { sseResponse } from "./helpers/fake-upstream";

const X_TEXT = "Xで今Claude Codeについてどんな反応がありますか？";
const X_SEARCH_TOOL = {
	type: "openrouter:web_search",
	parameters: { engine: "native", x_search: {} },
};

describe("responsesAdapter", () => {
	test.each([
		["non-object body", []],
		["missing input", { model: "a" }],
		["non-string instructions", { input: "hi", instructions: 1 }],
		["non-array models", { input: "hi", models: "a" }],
		["non-array tools", { input: "hi", tools: {} }],
	])("rejects %s", (_, body) => {
		expect(() => responsesAdapter.parseRequest(body)).toThrow(RouterError);
	});

	test("string input is the latest user message", () => {
		const context = responsesAdapter.extractRoutingContext(
			responsesAdapter.parseRequest({
				input: "hello",
				instructions: "be brief",
			}),
		);
		expect(context.conversation).toEqual([{ role: "user", text: "hello" }]);
		expect(context.instructions).toEqual(["be brief"]);
		expect(context.agentLoopTurns).toBe(0);
	});

	test("extracts messages, content parts, features and agent loop turns", () => {
		const request = responsesAdapter.parseRequest({
			model: "a",
			input: [
				{ role: "developer", content: "dev rule" },
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: X_TEXT },
						{ type: "input_image", image_url: "https://e.x/a.png" },
					],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "調べます" }],
				},
				{ type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
				{ type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "huge" },
				{ type: "function_call_output", call_id: "c2", output: "huge" },
				{ type: "function_call", call_id: "c3", name: "a", arguments: "{}" },
			],
			tools: [{ type: "function", name: "a", parameters: {} }],
			text: { format: { type: "json_schema", name: "s", schema: {} } },
			reasoning: { effort: "low" },
		});
		const context = responsesAdapter.extractRoutingContext(request);
		expect(context.instructions).toEqual(["dev rule"]);
		expect(context.conversation).toEqual([
			{ role: "user", text: X_TEXT },
			{ role: "assistant", text: "調べます" },
		]);
		// 並列 call (c1, c2) は1ターン
		expect(context.agentLoopTurns).toBe(2);
		expect(
			detectStructuralRequirements(context.features).requirements.map(
				(r) => r.capability,
			),
		).toEqual(["input.image", "tools", "structured_output", "reasoning"]);
	});
});

describe("messagesAdapter", () => {
	test.each([
		["non-object body", []],
		["missing messages", { model: "a" }],
		["invalid system", { messages: [], system: 1 }],
		["non-object provider", { messages: [], provider: "x" }],
	])("rejects %s", (_, body) => {
		expect(() => messagesAdapter.parseRequest(body)).toThrow(RouterError);
	});

	test("extracts system, text blocks and tool loop turns", () => {
		const request = messagesAdapter.parseRequest({
			model: "a",
			system: [{ type: "text", text: "system rule" }],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: X_TEXT },
						{ type: "document", source: { type: "base64", data: "AA" } },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "...", signature: "sig" },
						{ type: "tool_use", id: "toolu_1", name: "save", input: {} },
					],
				},
				// tool_result だけの user message は新しい user turn ではない
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
					],
				},
			],
			tools: [{ name: "save", input_schema: { type: "object" } }],
			thinking: { type: "enabled", budget_tokens: 1024 },
			output_config: { format: { type: "json_schema", schema: {} } },
		});
		const context = messagesAdapter.extractRoutingContext(request);
		expect(context.instructions).toEqual(["system rule"]);
		expect(context.conversation).toEqual([{ role: "user", text: X_TEXT }]);
		expect(context.agentLoopTurns).toBe(1);
		expect(
			detectStructuralRequirements(context.features).requirements.map(
				(r) => r.capability,
			),
		).toEqual(["input.file", "tools", "structured_output", "reasoning"]);
	});

	test("disabled thinking is not a reasoning requirement", () => {
		const context = messagesAdapter.extractRoutingContext(
			messagesAdapter.parseRequest({
				messages: [{ role: "user", content: "hi" }],
				thinking: { type: "disabled" },
			}),
		);
		expect(detectStructuralRequirements(context.features).requirements).toEqual(
			[],
		);
	});

	test.each([
		[{ type: "auto" }, "auto"],
		[{ type: "any" }, "required"],
		[{ type: "none" }, "none"],
		[
			{ type: "tool", name: "save" },
			{ type: "function", function: { name: "save" } },
		],
	])("normalizes tool_choice %p", (input, expected) => {
		expect(normalizeMessagesToolChoice(input)).toEqual(expected);
	});
});

const send = async (
	path: string,
	body: Record<string, unknown>,
	semantic: FakeSemantic = { "social.x.search": 0.95 },
) => {
	const { app, upstream, traceStore } = createTestApp({ semantic });
	const res = await app.request(path, {
		method: "POST",
		headers: {
			authorization: "Bearer sk-or-test",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const forwarded = upstream.requests[0];
	return {
		app,
		res,
		upstream,
		traceStore,
		url: forwarded?.url,
		forwarded: forwarded
			? (JSON.parse(forwarded.body) as Record<string, unknown>)
			: undefined,
	};
};

describe("POST /responses", () => {
	test.each(["/api/v1/responses", "/v1/responses"])(
		"%s routes X Search to Grok and keeps the Responses body",
		async (path) => {
			const input = [
				{ role: "user", content: [{ type: "input_text", text: X_TEXT }] },
			];
			const { res, url, forwarded } = await send(path, {
				model: "anthropic/claude-sonnet-5",
				input,
				instructions: "short",
				tools: [{ type: "function", name: "save", parameters: {} }],
				tool_choice: { type: "function", name: "save" },
				max_output_tokens: 100,
			});
			expect(res.status).toBe(200);
			expect(url).toBe("https://openrouter.test/api/v1/responses");
			expect(res.headers.get("Auto-Router-Route-Reason")).toBe(
				"capability_override",
			);
			expect(forwarded).toEqual({
				model: "x-ai/grok-4.7",
				models: ["x-ai/grok-4.6"],
				input,
				instructions: "short",
				tools: [
					{ type: "function", name: "save", parameters: {} },
					X_SEARCH_TOOL,
				],
				tool_choice: "auto",
				max_output_tokens: 100,
				provider: { require_parameters: true },
			});
		},
	);

	test("no requirement: raw body is forwarded", async () => {
		const raw = { model: "openai/gpt-5", input: "hi", store: false };
		const { forwarded } = await send("/api/v1/responses", raw, {});
		expect(forwarded).toEqual(raw);
	});
});

describe("POST /messages", () => {
	test("routes X Search to Grok and converts tool_choice back", async () => {
		const messages = [{ role: "user", content: X_TEXT }];
		const { res, url, forwarded, app } = await send("/v1/messages", {
			model: "anthropic/claude-sonnet-5",
			max_tokens: 100,
			system: "short",
			messages,
			tools: [{ name: "save", input_schema: { type: "object" } }],
			tool_choice: {
				type: "tool",
				name: "save",
				disable_parallel_tool_use: true,
			},
		});
		expect(res.status).toBe(200);
		expect(url).toBe("https://openrouter.test/api/v1/messages");
		expect(forwarded).toEqual({
			model: "x-ai/grok-4.7",
			models: ["x-ai/grok-4.6"],
			max_tokens: 100,
			system: "short",
			messages,
			tools: [
				{ name: "save", input_schema: { type: "object" } },
				X_SEARCH_TOOL,
			],
			tool_choice: { type: "auto", disable_parallel_tool_use: true },
			provider: { require_parameters: true },
		});
		const trace = (await (
			await app.request(
				`/api/v1/auto-router/traces/${res.headers.get("Auto-Router-Trace-Id")}`,
				{ headers: { authorization: "Bearer sk-or-test" } },
			)
		).json()) as RoutingTrace;
		expect(trace.tools.caller).toEqual([{ type: "custom", name: "save" }]);
		expect(trace.structuralRequirements).toEqual([{ capability: "tools" }]);
	});

	test("web search on Claude only injects the server tool", async () => {
		const { forwarded } = await send(
			"/api/v1/messages",
			{
				model: "anthropic/claude-sonnet-5",
				max_tokens: 10,
				messages: [{ role: "user", content: "今日のニュース" }],
				tool_choice: { type: "auto" },
			},
			{ "web.search": 0.95 },
		);
		expect(forwarded?.model).toBe("anthropic/claude-sonnet-5");
		expect(forwarded?.tools).toEqual([{ type: "openrouter:web_search" }]);
		expect(forwarded?.tool_choice).toEqual({ type: "auto" });
	});

	test("Places required → 422 without calling upstream", async () => {
		const { res, upstream } = await send(
			"/api/v1/messages",
			{
				model: "anthropic/claude-sonnet-5",
				max_tokens: 10,
				messages: [{ role: "user", content: "近くのカフェ" }],
			},
			{ "places.search": 0.95 },
		);
		expect(res.status).toBe(422);
		expect(upstream.requests).toHaveLength(0);
	});
});

describe("inspect ?endpoint=", () => {
	test("inspects Messages requests", async () => {
		const { res, upstream } = await send(
			"/api/v1/auto-router/inspect?endpoint=messages",
			{
				model: "anthropic/claude-sonnet-5",
				max_tokens: 10,
				messages: [{ role: "user", content: X_TEXT }],
			},
		);
		expect(res.status).toBe(200);
		expect(upstream.requests).toHaveLength(0);
		const body = (await res.json()) as {
			effective_request: Record<string, unknown>;
		};
		expect(body.effective_request.model).toBe("x-ai/grok-4.7");
	});

	test("unknown endpoint → invalid_router_request", async () => {
		const { res } = await send("/api/v1/auto-router/inspect?endpoint=x", {});
		expect(res.status).toBe(400);
	});
});

describe("SDK compatibility", () => {
	const appFetch =
		(app: ReturnType<typeof createTestApp>["app"]) =>
		async (input: string | URL | Request, init?: RequestInit) =>
			app.fetch(new Request(input, init));

	test("OpenAI SDK responses.create", async () => {
		const { app, upstream } = createTestApp({
			respond: () =>
				Response.json({
					id: "resp_1",
					object: "response",
					created_at: 0,
					model: "openai/gpt-5",
					status: "completed",
					output: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [
								{ type: "output_text", text: "hello", annotations: [] },
							],
						},
					],
				}),
		});
		const client = new OpenAI({
			baseURL: "https://auto-router.test/api/v1",
			apiKey: "sk-or-test",
			fetch: appFetch(app),
		});
		const response = await client.responses.create({
			model: "openai/gpt-5",
			input: "hi",
		});
		expect(response.output_text).toBe("hello");
		expect(upstream.requests[0]?.url).toBe(
			"https://openrouter.test/api/v1/responses",
		);
	});

	test("Anthropic SDK default apiKey (x-api-key) is accepted as BYOK", async () => {
		const { app, upstream, detector } = createTestApp({
			respond: () =>
				Response.json({
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "anthropic/claude-sonnet-5",
					content: [{ type: "text", text: "hi" }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
		});
		const client = new Anthropic({
			baseURL: "https://auto-router.test/api",
			apiKey: "sk-or-x-api-key",
			fetch: appFetch(app),
		});
		const message = await client.messages.create({
			model: "anthropic/claude-sonnet-5",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(message.content[0]).toMatchObject({ type: "text", text: "hi" });
		expect(detector.calls).toBe(1);
		expect(upstream.requests[0]?.headers.get("x-api-key")).toBe(
			"sk-or-x-api-key",
		);
	});

	test("Anthropic SDK messages.create (stream)", async () => {
		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "anthropic/claude-sonnet-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hello" },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
		const { app, upstream } = createTestApp({
			respond: () =>
				sseResponse(
					events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
				),
		});
		const client = new Anthropic({
			baseURL: "https://auto-router.test/api",
			apiKey: "unused",
			authToken: "sk-or-test",
			fetch: appFetch(app),
		});
		const stream = client.messages.stream({
			model: "anthropic/claude-sonnet-5",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(await stream.finalText()).toBe("hello");
		expect(upstream.requests[0]?.url).toBe(
			"https://openrouter.test/api/v1/messages",
		);
		expect(upstream.requests[0]?.headers.get("authorization")).toBe(
			"Bearer sk-or-test",
		);
	});
});
