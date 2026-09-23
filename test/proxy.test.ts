import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createApp } from "../src/app";
import { createFakeUpstream, sseResponse } from "./helpers/fake-upstream";

const BASE = "https://openrouter.test/api/v1";

const post = (
	app: ReturnType<typeof createApp>,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	app.request(path, {
		method: "POST",
		headers: {
			authorization: "Bearer sk-or-test",
			"content-type": "application/json",
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

describe("POST /api/v1/chat/completions", () => {
	test("forwards the raw body, BYOK Authorization and OpenRouter headers", async () => {
		const upstream = createFakeUpstream();
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});
		const raw = `{"model":"openai/gpt-5","messages":[{"role":"user","content":"hi"}],"unknown_ext":{"a":1},"big":12345678901234567890}`;

		const res = await post(app, "/api/v1/chat/completions", raw, {
			"HTTP-Referer": "https://example.com",
			"X-Title": "Example",
			"Auto-Router-Allow-Model-Override": "false",
			"Auto-Router-Debug": "true",
			cookie: "session=1",
		});

		expect(res.status).toBe(200);
		const [req] = upstream.requests;
		expect(req?.url).toBe(`${BASE}/chat/completions`);
		expect(req?.method).toBe("POST");
		expect(req?.body).toBe(raw);
		expect(req?.headers.get("authorization")).toBe("Bearer sk-or-test");
		expect(req?.headers.get("http-referer")).toBe("https://example.com");
		expect(req?.headers.get("x-title")).toBe("Example");
		expect(req?.headers.get("auto-router-allow-model-override")).toBeNull();
		expect(req?.headers.get("auto-router-debug")).toBeNull();
		expect(req?.headers.get("cookie")).toBeNull();
	});

	test("forwards a non-stream response without rebuilding the body", async () => {
		const upstreamBody = `{"id":"gen-1", "choices":[],   "extra":"kept"}`;
		const upstream = createFakeUpstream(
			() =>
				new Response(upstreamBody, {
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-upstream": "1",
						"set-cookie": "__cf_bm=1; Domain=openrouter.ai",
					},
				}),
		);
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await post(app, "/api/v1/chat/completions", {
			model: "a",
			messages: [],
		});

		expect(await res.text()).toBe(upstreamBody);
		expect(res.headers.get("x-upstream")).toBe("1");
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	test("forwards SSE stream chunks as-is", async () => {
		const chunks = [
			": OPENROUTER PROCESSING\n\n",
			'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
			"data: [DONE]\n\n",
		];
		const upstream = createFakeUpstream(() => sseResponse(chunks));
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await post(app, "/api/v1/chat/completions", {
			model: "a",
			stream: true,
			messages: [],
		});

		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(await res.text()).toBe(chunks.join(""));
	});

	test("forwards upstream errors with their status", async () => {
		const upstream = createFakeUpstream(() =>
			Response.json(
				{ error: { code: 402, message: "no credits" } },
				{ status: 402 },
			),
		);
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await post(app, "/api/v1/chat/completions", {
			model: "a",
			messages: [],
		});

		expect(res.status).toBe(402);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: { code: 402, message: "no credits" } });
	});

	test("/v1/chat/completions uses the same handler", async () => {
		const upstream = createFakeUpstream();
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await post(app, "/v1/chat/completions", {
			model: "a",
			messages: [],
		});

		expect(res.status).toBe(200);
		expect(upstream.requests[0]?.url).toBe(`${BASE}/chat/completions`);
	});

	test("requires Authorization", async () => {
		const upstream = createFakeUpstream();
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await app.request("/api/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "a", messages: [] }),
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: { code: "missing_authorization" },
		});
		expect(upstream.requests).toHaveLength(0);
	});

	test.each([
		["invalid JSON", "{", {}],
		["invalid model", { model: 1, messages: [] }, {}],
		[
			"invalid router header",
			{ model: "a", messages: [] },
			{ "Auto-Router-Debug": "yes" },
		],
	])("returns invalid_router_request for %s", async (_, body, headers) => {
		const upstream = createFakeUpstream();
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await post(app, "/api/v1/chat/completions", body, headers);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: { code: "invalid_router_request", type: "invalid_router_request" },
		});
		expect(upstream.requests).toHaveLength(0);
	});
});

describe("unsupported endpoints", () => {
	test.each([
		["POST", "/api/v1/responses"],
		["POST", "/api/v1/messages"],
		["POST", "/v1/completions"],
		["POST", "/v1/embeddings"],
		["GET", "/api/v1/chat/completions"],
	])("%s %s returns unsupported_endpoint", async (method, path) => {
		const upstream = createFakeUpstream();
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await app.request(path, {
			method,
			headers: { authorization: "Bearer sk-or-test" },
			...(method === "POST" ? { body: "{}" } : {}),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({
			error: { code: "unsupported_endpoint" },
		});
		expect(upstream.requests).toHaveLength(0);
	});
});

describe("CORS", () => {
	test("exposes Auto-Router headers", async () => {
		const upstream = createFakeUpstream();
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});

		const res = await post(
			app,
			"/api/v1/chat/completions",
			{ model: "a", messages: [] },
			{ origin: "https://app.example" },
		);

		expect(res.headers.get("access-control-expose-headers")).toContain(
			"Auto-Router-Trace-Id",
		);
	});
});

describe("OpenAI SDK compatibility", () => {
	const createClient = (upstream: ReturnType<typeof createFakeUpstream>) => {
		const app = createApp({
			upstream: { baseUrl: BASE, fetch: upstream.fetch },
		});
		return new OpenAI({
			baseURL: "https://auto-router.test/api/v1",
			apiKey: "sk-or-test",
			fetch: async (input, init) => app.fetch(new Request(input, init)),
		});
	};

	test("chat.completions.create works by swapping baseURL and apiKey", async () => {
		const upstream = createFakeUpstream(() =>
			Response.json({
				id: "gen-1",
				object: "chat.completion",
				created: 0,
				model: "openai/gpt-5",
				choices: [
					{
						index: 0,
						finish_reason: "stop",
						message: { role: "assistant", content: "hello" },
					},
				],
			}),
		);
		const client = createClient(upstream);

		const completion = await client.chat.completions.create({
			model: "openai/gpt-5",
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.2,
		});

		expect(completion.choices[0]?.message.content).toBe("hello");
		expect(upstream.requests[0]?.headers.get("authorization")).toBe(
			"Bearer sk-or-test",
		);
		expect(JSON.parse(upstream.requests[0]?.body ?? "")).toMatchObject({
			model: "openai/gpt-5",
			temperature: 0.2,
		});
	});

	test("streaming works", async () => {
		const upstream = createFakeUpstream(() =>
			sseResponse([
				'data: {"id":"gen-1","object":"chat.completion.chunk","created":0,"model":"a","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n',
				'data: {"id":"gen-1","object":"chat.completion.chunk","created":0,"model":"a","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const client = createClient(upstream);

		const stream = await client.chat.completions.create({
			model: "a",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		let text = "";
		for await (const chunk of stream)
			text += chunk.choices[0]?.delta.content ?? "";

		expect(text).toBe("hello");
	});
});
