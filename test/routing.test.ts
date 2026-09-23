import { describe, expect, test } from "bun:test";
import { createTestApp, type FakeSemantic } from "./helpers/app";

const X_SEARCH_TOOL = {
	type: "openrouter:web_search",
	parameters: { engine: "native", x_search: {} },
};

const send = async (
	body: Record<string, unknown>,
	options: {
		semantic?: FakeSemantic;
		headers?: Record<string, string>;
		respond?: () => Response;
	} = {},
) => {
	const { app, upstream, detector } = createTestApp({
		semantic: options.semantic ?? {},
		...(options.respond ? { respond: options.respond } : {}),
	});
	const res = await app.request("/api/v1/chat/completions", {
		method: "POST",
		headers: {
			authorization: "Bearer sk-or-test",
			"content-type": "application/json",
			...options.headers,
		},
		body: JSON.stringify(body),
	});
	const forwarded = upstream.requests[0];
	return {
		res,
		upstream,
		detector,
		forwarded: forwarded
			? (JSON.parse(forwarded.body) as Record<string, unknown>)
			: undefined,
	};
};

const messages = [
	{ role: "user", content: "Xで今Claude Codeについてどんな反応がありますか？" },
];

describe("capability-aware routing through the proxy", () => {
	test("no requirement: body forwarded as-is", async () => {
		const { forwarded, detector } = await send(
			{ model: "anthropic/claude-sonnet-5", messages, temperature: 0.1 },
			{ semantic: { "social.x.search": 0.1 } },
		);
		expect(detector.calls).toBe(1);
		expect(forwarded).toEqual({
			model: "anthropic/claude-sonnet-5",
			messages,
			temperature: 0.1,
		});
	});

	test("uncertain does not change routing", async () => {
		const { forwarded } = await send(
			{ model: "anthropic/claude-sonnet-5", messages },
			{ semantic: { "social.x.search": 0.5 } },
		);
		expect(forwarded).toEqual({ model: "anthropic/claude-sonnet-5", messages });
	});

	test("X Search required: filters model + models to compatible candidates and injects the tool", async () => {
		const { forwarded, upstream } = await send(
			{
				model: "anthropic/claude-sonnet-5",
				models: ["openai/gpt-5", "x-ai/grok-4.7"],
				messages,
				unknown_extension: { keep: true },
			},
			{ semantic: { "social.x.search": 0.95 } },
		);
		expect(upstream.requests).toHaveLength(1);
		expect(forwarded).toEqual({
			model: "x-ai/grok-4.7",
			messages,
			unknown_extension: { keep: true },
			tools: [X_SEARCH_TOOL],
		});
	});

	test("X Search required with override: incompatible caller models are not kept as fallback", async () => {
		const { forwarded } = await send(
			{
				model: "anthropic/claude-sonnet-5",
				models: ["openai/gpt-5"],
				messages,
				tools: [{ type: "function", function: { name: "f", parameters: {} } }],
				tool_choice: { type: "function", function: { name: "f" } },
				response_format: {
					type: "json_schema",
					json_schema: { name: "s", schema: {} },
				},
				provider: { order: ["xai"], zdr: true },
			},
			{ semantic: { "social.x.search": 0.95 } },
		);
		expect(forwarded).toEqual({
			model: "x-ai/grok-4.7",
			models: ["x-ai/grok-4.6"],
			messages,
			tools: [
				{ type: "function", function: { name: "f", parameters: {} } },
				X_SEARCH_TOOL,
			],
			tool_choice: "auto",
			response_format: {
				type: "json_schema",
				json_schema: { name: "s", schema: {} },
			},
			provider: { order: ["xai"], zdr: true, require_parameters: true },
		});
	});

	test("override disabled → 422 capability_not_supported without calling upstream", async () => {
		const { res, upstream } = await send(
			{ model: "anthropic/claude-sonnet-5", messages },
			{
				semantic: { "social.x.search": 0.95 },
				headers: { "Auto-Router-Allow-Model-Override": "false" },
			},
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			error: {
				code: "capability_not_supported",
				metadata: { required_capabilities: ["social.x.search"] },
			},
		});
		expect(upstream.requests).toHaveLength(0);
	});

	test("Places required → capability_not_supported (no silent degrade to web search)", async () => {
		const { res, upstream } = await send(
			{ model: "x-ai/grok-4.7", messages },
			{ semantic: { "places.reviews": 0.9, "web.search": 0.9 } },
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			error: { code: "capability_not_supported" },
		});
		expect(upstream.requests).toHaveLength(0);
	});

	test("tool parameter conflict → 422 capability_conflict", async () => {
		const { res } = await send(
			{
				model: "x-ai/grok-4.7",
				messages,
				tools: [
					{ type: "openrouter:web_search", parameters: { engine: "exa" } },
				],
			},
			{ semantic: { "social.x.search": 0.95 } },
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			error: { code: "capability_conflict" },
		});
	});

	test("Jev degraded: chain unchanged, no tool injection, structural still enforced", async () => {
		const { res, forwarded } = await send(
			{
				model: "text/no-tools",
				models: ["anthropic/claude-sonnet-5"],
				messages,
				tools: [{ type: "function", function: { name: "f" } }],
			},
			{ semantic: { degraded: "jev_timeout" } },
		);
		expect(res.status).toBe(200);
		expect(forwarded).toEqual({
			model: "anthropic/claude-sonnet-5",
			messages,
			tools: [{ type: "function", function: { name: "f" } }],
			provider: { require_parameters: true },
		});
	});

	test("upstream failure is returned without falling back to incompatible models", async () => {
		const { res, upstream, forwarded } = await send(
			{
				model: "anthropic/claude-sonnet-5",
				models: ["x-ai/grok-4.7"],
				messages,
			},
			{
				semantic: { "social.x.search": 0.95 },
				respond: () =>
					Response.json(
						{ error: { code: 503, message: "down" } },
						{ status: 503 },
					),
			},
		);
		expect(res.status).toBe(503);
		expect(upstream.requests).toHaveLength(1);
		expect(forwarded?.model).toBe("x-ai/grok-4.7");
		expect(forwarded?.models).toBeUndefined();
	});
});

describe("semantic routing control headers", () => {
	const webSearch = { "web.search": 0.95 };

	test("Auto-Router-Semantic: off skips Jev and keeps the request unchanged", async () => {
		const { res, forwarded, detector } = await send(
			{ model: "anthropic/claude-sonnet-5", messages },
			{
				semantic: { "social.x.search": 0.95, ...webSearch },
				headers: { "Auto-Router-Semantic": "off" },
			},
		);
		expect(res.status).toBe(200);
		expect(detector.calls).toBe(0);
		expect(forwarded).toEqual({ model: "anthropic/claude-sonnet-5", messages });
		expect(res.headers.get("Auto-Router-Route-Reason")).toBe("requested_model");
		expect(res.headers.get("Auto-Router-Degraded")).toBe("false");
	});

	test("disabling semantic routing keeps structural requirements", async () => {
		const { forwarded, detector } = await send(
			{
				model: "anthropic/claude-sonnet-5",
				models: ["text/no-tools"],
				messages,
				tools: [{ type: "function", function: { name: "f", parameters: {} } }],
			},
			{ headers: { "Auto-Router-Semantic": "OFF" } },
		);
		expect(detector.calls).toBe(0);
		expect(forwarded?.model).toBe("anthropic/claude-sonnet-5");
		expect(forwarded?.models).toBeUndefined();
		expect(forwarded?.provider).toEqual({ require_parameters: true });
	});

	test("Auto-Router-Capabilities limits which capabilities can be required", async () => {
		const { forwarded, detector } = await send(
			{ model: "anthropic/claude-sonnet-5", messages },
			{
				semantic: { "social.x.search": 0.95, ...webSearch },
				headers: { "Auto-Router-Capabilities": " web.search " },
			},
		);
		expect(detector.scopes).toEqual([["web.search"]]);
		// X Search は対象外なので override されず、web search tool の注入だけが行われる。
		expect(forwarded).toEqual({
			model: "anthropic/claude-sonnet-5",
			messages,
			tools: [{ type: "openrouter:web_search" }],
		});
	});

	test.each([
		["Auto-Router-Semantic", "maybe"],
		["Auto-Router-Capabilities", "web.search,unknown.cap"],
		["Auto-Router-Capabilities", "web.search,"],
		["Auto-Router-Capabilities", ""],
	])("invalid %s: %p → invalid_router_request", async (header, value) => {
		const { res, upstream, detector } = await send(
			{ model: "anthropic/claude-sonnet-5", messages },
			{ headers: { [header]: value } },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; metadata: { header: string } };
		};
		expect(body.error.code).toBe("invalid_router_request");
		expect(body.error.metadata.header).toBe(header);
		expect(detector.calls).toBe(0);
		expect(upstream.requests).toHaveLength(0);
	});
});
