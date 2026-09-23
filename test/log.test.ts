import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { apiKeyFingerprint } from "../src/trace/fingerprint";
import { createTestApp, type FakeSemantic } from "./helpers/app";

const KEY = "sk-or-log-secret";
const USER_TEXT = "Xで今Claude Codeについてどんな反応がありますか？";

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
	logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const events = () =>
	logSpy.mock.calls.map(
		(args: unknown[]) => JSON.parse(String(args[0])) as Record<string, unknown>,
	);

const send = async (
	body: Record<string, unknown>,
	options: {
		semantic?: FakeSemantic;
		respond?: () => Response;
		headers?: Record<string, string>;
		path?: string;
	} = {},
) => {
	const { app } = createTestApp({
		semantic: options.semantic ?? {},
		...(options.respond ? { respond: options.respond } : {}),
	});
	return app.request(options.path ?? "/api/v1/chat/completions", {
		method: "POST",
		headers: {
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
			...options.headers,
		},
		body: JSON.stringify(body),
	});
};

describe("structured routing log", () => {
	test("one JSON line per routed request without message text or key", async () => {
		const res = await send(
			{
				model: "anthropic/claude-sonnet-5",
				models: ["openai/gpt-5"],
				messages: [{ role: "user", content: USER_TEXT }],
				tools: [{ type: "function", function: { name: "f", parameters: {} } }],
			},
			{ semantic: { "social.x.search": 0.95, "web.search": 0.95 } },
		);
		expect(res.status).toBe(200);

		expect(events()).toEqual([
			{
				source: "auto-router",
				event: "routing_decision",
				endpoint: "chat_completions",
				traceId: res.headers.get("Auto-Router-Trace-Id"),
				reason: "capability_override",
				overridden: true,
				semanticStatus: "ok",
				requiredCapabilities: ["social.x.search", "web.search"],
				structuralCapabilities: ["tools"],
				capabilityDegrades: [],
				requestedModel: "anthropic/claude-sonnet-5",
				requestedChainLength: 2,
				effectiveModel: "x-ai/grok-4.7",
				effectiveChainLength: 2,
				candidates: 4,
				rejectedCandidates: 2,
				agentLoopTurns: 0,
				injectedServerTools: ["web_search", "x_search"],
				jevCalled: true,
				upstreamStatus: 200,
				latencyMs: expect.objectContaining({ routing: expect.any(Number) }),
			},
		]);
		const raw = JSON.stringify(logSpy.mock.calls);
		expect(raw).not.toContain(USER_TEXT);
		expect(raw).not.toContain(KEY);
		expect(raw).not.toContain(await apiKeyFingerprint(KEY, undefined));
	});

	test("degraded and router errors are logged", async () => {
		await send(
			{ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] },
			{ semantic: { degraded: "jev_timeout" } },
		);
		await send(
			{ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] },
			{ semantic: { "places.search": 0.95 } },
		);
		expect(events()).toMatchObject([
			{ reason: "degraded", degradedReason: "jev_timeout", overridden: false },
			{
				reason: "capability_not_supported",
				errorCode: "capability_not_supported",
			},
		]);
		expect(events()[1]).not.toHaveProperty("upstreamStatus");
	});

	test("inspect is logged with its endpoint", async () => {
		await send(
			{ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] },
			{ path: "/api/v1/auto-router/inspect" },
		);
		expect(events()).toMatchObject([
			{ event: "routing_decision", endpoint: "inspect" },
		]);
	});

	test("upstream 401 logs invalid_api_key", async () => {
		await send(
			{ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] },
			{ respond: () => new Response("{}", { status: 401 }) },
		);
		expect(events()).toMatchObject([
			{ event: "routing_decision", upstreamStatus: 401 },
			{ event: "invalid_api_key", source: "upstream" },
		]);
	});

	test("rate limit is logged", async () => {
		const { app } = createTestApp({
			rateLimiters: { key: { limit: async () => ({ success: false }) } },
		});
		await app.request("/api/v1/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${KEY}` },
			body: "{}",
		});
		expect(events()).toEqual([
			{ source: "auto-router", event: "rate_limited", scope: "key" },
		]);
	});
});
