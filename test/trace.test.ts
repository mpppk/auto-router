import { describe, expect, test } from "bun:test";
import { apiKeyFingerprint } from "../src/trace/fingerprint";
import { createD1TraceStore } from "../src/trace/store";
import type { RoutingTrace } from "../src/trace/trace";
import { createTestApp, type FakeSemantic } from "./helpers/app";
import { createD1Shim } from "./helpers/d1-shim";
import { sseResponse } from "./helpers/fake-upstream";

const KEY = "sk-or-secret-key-123";
const USER_TEXT = "Xで今Claude Codeについてどんな反応がありますか？";
const messages = [{ role: "user", content: USER_TEXT }];

const request = (
	app: ReturnType<typeof createTestApp>["app"],
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	app.request(path, {
		method: "POST",
		headers: {
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});

const getTrace = async (
	app: ReturnType<typeof createTestApp>["app"],
	id: string,
	key = KEY,
) =>
	app.request(`/api/v1/auto-router/traces/${id}`, {
		headers: { authorization: `Bearer ${key}` },
	});

const setup = (semantic: FakeSemantic = {}, respond?: () => Response) =>
	createTestApp({ semantic, ...(respond ? { respond } : {}) });

describe("summary headers", () => {
	test("completion response carries routing summary headers", async () => {
		const { app } = setup({ "social.x.search": 0.95 });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "anthropic/claude-sonnet-5",
			models: ["openai/gpt-5"],
			messages,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Auto-Router-Trace-Id")).toMatch(
			/^rt_[0-9a-f]{32}$/,
		);
		expect(res.headers.get("Auto-Router-Requested-Model")).toBe(
			"anthropic/claude-sonnet-5,openai/gpt-5",
		);
		expect(res.headers.get("Auto-Router-Selected-Model")).toBe(
			"x-ai/grok-4.7,x-ai/grok-4.6",
		);
		expect(res.headers.get("Auto-Router-Route-Reason")).toBe(
			"capability_override",
		);
		expect(res.headers.get("Auto-Router-Degraded")).toBe("false");
	});

	test("stream response keeps the SSE body and carries headers", async () => {
		const chunks = ['data: {"choices":[]}\n\n', "data: [DONE]\n\n"];
		const { app } = setup({}, () => sseResponse(chunks));
		const res = await request(app, "/api/v1/chat/completions", {
			model: "openai/gpt-5",
			stream: true,
			messages,
		});
		expect(res.headers.get("Auto-Router-Route-Reason")).toBe("requested_model");
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(await res.text()).toBe(chunks.join(""));
	});

	test("degraded Jev is reported", async () => {
		const { app } = setup({ degraded: "jev_timeout" });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "openai/gpt-5",
			messages,
		});
		expect(res.headers.get("Auto-Router-Degraded")).toBe("true");
		expect(res.headers.get("Auto-Router-Route-Reason")).toBe("degraded");
	});

	test("router errors carry the trace id", async () => {
		const { app } = setup({ "places.search": 0.95 });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "openai/gpt-5",
			messages,
		});
		expect(res.status).toBe(422);
		expect(res.headers.get("Auto-Router-Trace-Id")).toMatch(/^rt_/);
		expect(res.headers.get("Auto-Router-Route-Reason")).toBe(
			"capability_not_supported",
		);
	});
});

describe("GET /api/v1/auto-router/traces/:traceId", () => {
	test("returns the caller's trace without message text or API key", async () => {
		const { app } = setup({ "social.x.search": 0.95, "web.search": 0.5 });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "anthropic/claude-sonnet-5",
			messages,
			tools: [
				{ type: "function", function: { name: "lookup", parameters: {} } },
			],
			tool_choice: "none",
		});
		const id = res.headers.get("Auto-Router-Trace-Id") ?? "";

		const traceRes = await getTrace(app, id);
		expect(traceRes.status).toBe(200);
		const raw = await traceRes.text();
		expect(raw).not.toContain(USER_TEXT);
		expect(raw).not.toContain(KEY);
		expect(raw).not.toContain("preferred");

		const trace = JSON.parse(raw) as RoutingTrace;
		expect(trace).toMatchObject({
			id,
			detail: "summary",
			requestedModelChain: ["anthropic/claude-sonnet-5"],
			effectiveModelChain: ["x-ai/grok-4.7", "x-ai/grok-4.6"],
			reason: "capability_override",
			context: { conversationMessagesUsed: 1 },
			tools: {
				caller: [{ type: "function", name: "lookup" }],
				injected: [{ type: "openrouter:web_search" }],
			},
			toolChoice: { overridden: true },
			provider: { requireParametersOverridden: true },
		});
		expect(trace.semanticRequirements).toContainEqual({
			capability: "web.search",
			requiredProbability: 0.5,
			decision: "uncertain",
		});
		expect(trace.structuralRequirements).toEqual([{ capability: "tools" }]);
		expect(trace.candidates).toEqual([
			{
				model: "anthropic/claude-sonnet-5",
				origin: "requested",
				accepted: false,
				conflicts: ["capability_unsupported"],
			},
			{
				model: "x-ai/grok-4.7",
				origin: "default_route",
				accepted: true,
				conflicts: [],
			},
			{
				model: "x-ai/grok-4.6",
				origin: "default_route",
				accepted: true,
				conflicts: [],
			},
		]);
		// summary では tool_choice の値を保存しない
		expect(trace.toolChoice.requested).toBeUndefined();
		expect(trace.latencyMs.upstream).toBeGreaterThanOrEqual(0);
	});

	test("Auto-Router-Debug: true stores the full trace", async () => {
		const { app } = setup({ "social.x.search": 0.95 });
		const res = await request(
			app,
			"/api/v1/chat/completions",
			{ model: "anthropic/claude-sonnet-5", messages, tool_choice: "none" },
			{ "Auto-Router-Debug": "true" },
		);
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.detail).toBe("full");
		expect(trace.toolChoice).toEqual({
			requested: "none",
			effective: "auto",
			overridden: true,
		});
		expect(trace.candidates[0]?.conflictDetails?.[0]?.message).toContain(
			"does not support social.x.search",
		);
		expect(trace.candidates[1]?.support).toEqual([
			{ capability: "social.x.search", support: "supported" },
		]);
	});

	test("records the Jev degraded reason", async () => {
		const { app } = setup({ degraded: "jev_invalid_response" });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "openai/gpt-5",
			messages,
		});
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.degraded).toEqual({ reason: "jev_invalid_response" });
		expect(trace.semanticStatus).toBe("degraded");
	});

	test("records billable operations enabled by the router", async () => {
		const { app } = setup({ "social.x.search": 0.95, "web.search": 0.95 });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "anthropic/claude-sonnet-5",
			messages,
		});
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.billing).toEqual({
			jev: true,
			serverTools: ["web_search", "x_search"],
		});
	});

	test("caller-provided web search is not attributed to the router", async () => {
		const { app } = setup({ "social.x.search": 0.95 });
		const res = await request(app, "/api/v1/chat/completions", {
			model: "x-ai/grok-4.7",
			messages,
			tools: [{ type: "openrouter:web_search" }],
		});
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		// caller の web_search に x_search を補完した分だけが router 由来
		expect(trace.tools.completed).toEqual([{ type: "openrouter:web_search" }]);
		expect(trace.billing.serverTools).toEqual(["x_search"]);
	});

	test("semantic routing disabled by header: no Jev, no injected tools", async () => {
		const { app } = setup({ "social.x.search": 0.95, "web.search": 0.95 });
		const res = await request(
			app,
			"/api/v1/chat/completions",
			{ model: "anthropic/claude-sonnet-5", messages },
			{ "Auto-Router-Semantic": "off" },
		);
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.semanticStatus).toBe("disabled");
		expect(trace.billing).toEqual({ jev: false, serverTools: [] });
		expect(trace.latencyMs.jev).toBeUndefined();
	});

	test("records the capability scope", async () => {
		const { app } = setup({ "web.search": 0.95 });
		const res = await request(
			app,
			"/api/v1/chat/completions",
			{ model: "anthropic/claude-sonnet-5", messages },
			{ "Auto-Router-Capabilities": "web.search,social.x.search" },
		);
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.semanticScope).toEqual(["web.search", "social.x.search"]);
		expect(trace.billing.serverTools).toEqual(["web_search"]);
	});

	test("no billable server tools when the request is rejected", async () => {
		const { app } = setup({ "social.x.search": 0.95 });
		const res = await request(
			app,
			"/api/v1/chat/completions",
			{ model: "anthropic/claude-sonnet-5", messages },
			{ "Auto-Router-Allow-Model-Override": "false" },
		);
		expect(res.status).toBe(422);
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.billing).toEqual({ jev: true, serverTools: [] });
	});

	test("records applied capability degrades with the original Jev decision", async () => {
		const { app } = setup({ "places.search": 0.95 });
		const res = await request(
			app,
			"/api/v1/chat/completions",
			{ model: "anthropic/claude-sonnet-5", messages },
			{ "Auto-Router-Allow-Capability-Degrade": "places.search=web.search" },
		);
		const trace = (await (
			await getTrace(app, res.headers.get("Auto-Router-Trace-Id") ?? "")
		).json()) as RoutingTrace;
		expect(trace.capabilityDegrades).toEqual([
			{ from: "places.search", to: "web.search" },
		]);
		expect(trace.semanticRequirements).toContainEqual({
			capability: "places.search",
			requiredProbability: 0.95,
			decision: "required",
		});
		expect(trace.billing.serverTools).toEqual(["web_search"]);
	});

	test("another API key cannot read the trace", async () => {
		const { app } = setup();
		const res = await request(app, "/api/v1/chat/completions", {
			model: "openai/gpt-5",
			messages,
		});
		const other = await getTrace(
			app,
			res.headers.get("Auto-Router-Trace-Id") ?? "",
			"sk-or-other",
		);
		expect(other.status).toBe(404);
		expect(await other.json()).toMatchObject({
			error: { code: "trace_not_found" },
		});
	});

	test("requires Authorization", async () => {
		const { app } = setup();
		const res = await app.request("/api/v1/auto-router/traces/rt_x");
		expect(res.status).toBe(401);
	});
});

describe("POST /api/v1/auto-router/inspect", () => {
	test("returns the route decision without calling the upstream model", async () => {
		const { app, upstream } = setup({ "social.x.search": 0.95 });
		const res = await request(app, "/api/v1/auto-router/inspect", {
			model: "anthropic/claude-sonnet-5",
			models: ["openai/gpt-5", "x-ai/grok-4.7"],
			messages,
			tool_choice: "none",
			provider: { order: ["xai"] },
		});
		expect(res.status).toBe(200);
		expect(upstream.requests).toHaveLength(0);
		expect(res.headers.get("Auto-Router-Selected-Model")).toBe("x-ai/grok-4.7");

		const body = (await res.json()) as {
			trace: RoutingTrace;
			effective_request: Record<string, unknown>;
		};
		expect(body.trace).toMatchObject({
			detail: "full",
			requestedModelChain: [
				"anthropic/claude-sonnet-5",
				"openai/gpt-5",
				"x-ai/grok-4.7",
			],
			effectiveModelChain: ["x-ai/grok-4.7"],
			reason: "filtered_fallback_chain",
			toolChoice: { requested: "none", effective: "auto", overridden: true },
		});
		expect(body.trace.candidates.map((c) => [c.model, c.accepted])).toEqual([
			["anthropic/claude-sonnet-5", false],
			["openai/gpt-5", false],
			["x-ai/grok-4.7", true],
		]);
		expect(body.effective_request).toEqual({
			model: "x-ai/grok-4.7",
			tools: [
				{
					type: "openrouter:web_search",
					parameters: { engine: "native", x_search: {} },
				},
			],
			tool_choice: "auto",
			provider: { order: ["xai"] },
		});
	});

	test("reports capability errors in the body", async () => {
		const { app } = setup({ "social.x.search": 0.95 });
		const res = await request(
			app,
			"/api/v1/auto-router/inspect",
			{ model: "openai/gpt-5", messages },
			{ "Auto-Router-Allow-Model-Override": "false" },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			trace: { reason: "capability_not_supported", effectiveModelChain: [] },
			error: { code: "capability_not_supported" },
		});
	});
});

describe("apiKeyFingerprint", () => {
	test("is deterministic, keyed, and never contains the key", async () => {
		const a = await apiKeyFingerprint(KEY, "secret");
		expect(a).toBe(await apiKeyFingerprint(KEY, "secret"));
		expect(a).toMatch(/^hmac:[0-9a-f]{64}$/);
		expect(a).not.toBe(await apiKeyFingerprint(KEY, "other-secret"));
		expect(a).not.toBe(await apiKeyFingerprint("sk-or-other", "secret"));
		expect(await apiKeyFingerprint(KEY, undefined)).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
	});
});

describe("createD1TraceStore", () => {
	const trace = { id: "rt_1", detail: "summary" } as RoutingTrace;

	test("stores, scopes by owner and expires traces", async () => {
		let now = 1000;
		const store = createD1TraceStore(createD1Shim(), {
			now: () => now,
			ttlMs: 100,
		});
		await store.put(trace, "owner-a");

		expect(await store.get("rt_1", "owner-a")).toEqual(trace);
		expect(await store.get("rt_1", "owner-b")).toBeUndefined();

		now = 1100;
		expect(await store.get("rt_1", "owner-a")).toBeUndefined();
		await store.deleteExpired(now);
	});
});
