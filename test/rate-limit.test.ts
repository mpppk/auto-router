import { describe, expect, test } from "bun:test";
import { createSemanticDetector } from "../src/semantic/detector";
import { JevError } from "../src/semantic/jev-client";
import { apiKeyFingerprint } from "../src/trace/fingerprint";
import { createTestApp } from "./helpers/app";

const KEY = "sk-or-rate-limit";
const messages = [{ role: "user", content: "Xで今Claude Codeの反応は？" }];

/** limit 回までは成功し、以降は失敗する fake limiter。 */
const fakeLimiter = (limit: number) => {
	const keys: string[] = [];
	return {
		keys,
		async limit({ key }: { key: string }) {
			keys.push(key);
			return { success: keys.filter((k) => k === key).length <= limit };
		},
	};
};

const post = (
	app: ReturnType<typeof createTestApp>["app"],
	path = "/api/v1/chat/completions",
	headers: Record<string, string> = {},
) =>
	app.request(path, {
		method: "POST",
		headers: {
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
			"cf-connecting-ip": "203.0.113.7",
			...headers,
		},
		body: JSON.stringify({ model: "openai/gpt-5", messages }),
	});

describe("rate limit", () => {
	test("API key limit → OpenRouter compatible 429 before Jev / trace", async () => {
		const key = fakeLimiter(1);
		const { app, detector, upstream, traceStore } = createTestApp({
			rateLimiters: { key },
		});

		expect((await post(app)).status).toBe(200);
		const res = await post(app);

		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
		expect((await res.json()) as unknown).toEqual({
			error: {
				message: "Too many requests for this API key. Please retry later.",
				type: "rate_limited",
				code: "rate_limited",
				metadata: { scope: "key" },
			},
		});
		expect(detector.calls).toBe(1);
		expect(upstream.requests).toHaveLength(1);
		expect(traceStore.size()).toBe(1);
		// raw key ではなく fingerprint で limit する
		expect(key.keys[0]).toBe(`key:${await apiKeyFingerprint(KEY, undefined)}`);
		expect(key.keys.join()).not.toContain(KEY);
	});

	test("IP limit uses CF-Connecting-IP", async () => {
		const ip = fakeLimiter(1);
		const { app } = createTestApp({ rateLimiters: { ip } });

		expect((await post(app)).status).toBe(200);
		const limited = await post(app, "/v1/chat/completions");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({
			error: { metadata: { scope: "ip" } },
		});
		// 別 IP は影響を受けない
		expect(
			(await post(app, undefined, { "cf-connecting-ip": "198.51.100.1" }))
				.status,
		).toBe(200);
		expect(ip.keys).toEqual([
			"ip:203.0.113.7",
			"ip:203.0.113.7",
			"ip:198.51.100.1",
		]);
	});

	test("inspect and trace APIs are rate limited too", async () => {
		const { app } = createTestApp({ rateLimiters: { key: fakeLimiter(0) } });
		expect((await post(app, "/api/v1/auto-router/inspect")).status).toBe(429);
		const trace = await app.request("/api/v1/auto-router/traces/rt_x", {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(trace.status).toBe(429);
	});

	test("health check is not rate limited", async () => {
		const { app } = createTestApp({
			rateLimiters: { ip: fakeLimiter(0), key: fakeLimiter(0) },
		});
		const res = await app.request("/health", {
			headers: { "cf-connecting-ip": "203.0.113.7" },
		});
		expect(res.status).toBe(200);
	});
});

describe("invalid API key", () => {
	test("Jev 401 → 401 invalid_api_key without upstream call or trace", async () => {
		const detector = createSemanticDetector({
			jev: {
				noul: async () => {
					throw new JevError("jev_unauthorized", "unauthorized");
				},
			},
		});
		const { app, upstream, traceStore } = createTestApp({ detector });

		const res = await post(app);

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: { code: "invalid_api_key" },
		});
		expect(upstream.requests).toHaveLength(0);
		expect(traceStore.size()).toBe(0);
	});

	test("upstream 401 is forwarded but the trace is not stored", async () => {
		const { app, traceStore } = createTestApp({
			respond: () =>
				Response.json(
					{ error: { message: "No auth credentials found", code: 401 } },
					{ status: 401 },
				),
		});

		const res = await post(app, undefined, { "Auto-Router-Semantic": "off" });

		expect(res.status).toBe(401);
		expect((await res.json()) as unknown).toEqual({
			error: { message: "No auth credentials found", code: 401 },
		});
		expect(res.headers.get("Auto-Router-Trace-Id")).toBeNull();
		expect(res.headers.get("Auto-Router-Route-Reason")).toBe("requested_model");
		expect(traceStore.size()).toBe(0);
	});

	test("other upstream errors still store the trace", async () => {
		const { app, traceStore } = createTestApp({
			respond: () => Response.json({ error: { code: 402 } }, { status: 402 }),
		});
		const res = await post(app);
		expect(res.status).toBe(402);
		expect(res.headers.get("Auto-Router-Trace-Id")).toMatch(/^rt_/);
		expect(traceStore.size()).toBe(1);
	});
});
