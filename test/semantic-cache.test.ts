import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createStaticModelCatalog } from "../src/catalog/model-catalog";
import type { ConversationMessage } from "../src/core/types";
import {
	createCacheApiSemanticCache,
	createMemorySemanticCache,
	semanticCacheKey,
} from "../src/semantic/cache";
import { createSemanticDetector } from "../src/semantic/detector";
import { type JevClient, JevError } from "../src/semantic/jev-client";
import { CAPABILITY_QUESTIONS } from "../src/semantic/questions";
import { createMemoryTraceStore } from "../src/trace/store";
import type { RoutingTrace } from "../src/trace/trace";
import { MODEL_PROFILES } from "./helpers/app";
import { createFakeUpstream } from "./helpers/fake-upstream";

const SECRET_TEXT = "Xで今Claude Codeの反応を調べて";
const KEY = "sk-or-cache-key";
const conversation: ConversationMessage[] = [
	{ role: "user", text: SECRET_TEXT },
];

const countingJev = (p = 0.95): JevClient & { calls: number } => {
	const jev = {
		calls: 0,
		async noul(_state: unknown, questions: Record<string, unknown>) {
			jev.calls++;
			return Object.fromEntries(Object.keys(questions).map((id) => [id, p]));
		},
	};
	return jev;
};

const detect = (
	detector: ReturnType<typeof createSemanticDetector>,
	messages: ConversationMessage[] = conversation,
	apiKey = KEY,
) => detector.detect({ conversation: messages, instructions: [] }, { apiKey });

describe("semantic detection cache", () => {
	test("same context → Jev is called once", async () => {
		const jev = countingJev();
		const detector = createSemanticDetector({
			jev,
			cache: { store: createMemorySemanticCache() },
		});
		const first = await detect(detector);
		const second = await detect(detector);
		expect(jev.calls).toBe(1);
		expect(first.cache).toBe("miss");
		expect(second.cache).toBe("hit");
		expect(second.requirements).toEqual(first.requirements);
	});

	test("agent loop turns reuse the decision", async () => {
		const jev = countingJev();
		const detector = createSemanticDetector({
			jev,
			cache: { store: createMemorySemanticCache() },
		});
		await detect(detector);
		const loop = await detect(detector, [
			...conversation,
			{ role: "assistant", text: "検索します" },
		]);
		expect(loop.cache).toBe("hit");
		expect(jev.calls).toBe(1);
	});

	test("different API key, new user message or scope → miss", async () => {
		const jev = countingJev();
		const detector = createSemanticDetector({
			jev,
			cache: { store: createMemorySemanticCache() },
		});
		await detect(detector);
		await detect(detector, conversation, "sk-or-other");
		await detect(detector, [...conversation, { role: "user", text: "次" }]);
		await detector.detect(
			{ conversation, instructions: [] },
			{ apiKey: KEY, capabilities: ["web.search"] },
		);
		expect(jev.calls).toBe(4);
	});

	test("threshold changes re-classify cached probabilities", async () => {
		const store = createMemorySemanticCache();
		const jev = countingJev(0.85);
		await detect(createSemanticDetector({ jev, cache: { store } }));
		const strict = await detect(
			createSemanticDetector({
				jev,
				cache: { store },
				thresholds: { "social.x.search": { required: 0.9, notRequired: 0.2 } },
			}),
		);
		expect(jev.calls).toBe(1);
		expect(strict.cache).toBe("hit");
		expect(
			strict.requirements.find((r) => r.capability === "social.x.search")
				?.decision,
		).toBe("uncertain");
	});

	test("question wording and Jev model are part of the key", async () => {
		const base = {
			ownerFingerprint: "fp",
			model: "~typesafe/jev-latest",
			state: { a: 1 },
			questions: { "web.search": CAPABILITY_QUESTIONS["web.search"] },
		};
		const key = await semanticCacheKey(base);
		expect(await semanticCacheKey({ ...base })).toBe(key);
		expect(
			await semanticCacheKey({
				...base,
				questions: {
					"web.search": {
						...CAPABILITY_QUESTIONS["web.search"],
						instructions: "changed",
					},
				},
			}),
		).not.toBe(key);
		expect(await semanticCacheKey({ ...base, model: "other" })).not.toBe(key);
	});

	test("degraded results are not cached; cache failures fall back to Jev", async () => {
		let fail = true;
		const jev: JevClient & { calls: number } = {
			calls: 0,
			async noul(_s, questions) {
				jev.calls++;
				if (fail) throw new JevError("jev_timeout", "t");
				return Object.fromEntries(Object.keys(questions).map((id) => [id, 0]));
			},
		};
		const store = createMemorySemanticCache();
		const detector = createSemanticDetector({ jev, cache: { store } });
		expect((await detect(detector)).status).toBe("degraded");
		expect(store.size()).toBe(0);
		fail = false;
		expect((await detect(detector)).cache).toBe("miss");

		const broken = createSemanticDetector({
			jev,
			cache: {
				store: {
					get: async () => {
						throw new Error("cache down");
					},
					put: async () => {
						throw new Error("cache down");
					},
				},
			},
		});
		expect((await detect(broken)).status).toBe("ok");
	});

	test("Cache API store keeps only probabilities keyed by a hash", async () => {
		const puts: { url: string; body: string; cacheControl: string | null }[] =
			[];
		const responses = new Map<string, string>();
		const cache = {
			async match(url: string) {
				const body = responses.get(url);
				return body === undefined ? undefined : new Response(body);
			},
			async put(url: string, res: Response) {
				const body = await res.text();
				responses.set(url, body);
				puts.push({
					url,
					body,
					cacheControl: res.headers.get("cache-control"),
				});
			},
		} as unknown as Cache;
		const jev = countingJev();
		const detector = createSemanticDetector({
			jev,
			cache: { store: createCacheApiSemanticCache(cache) },
		});
		await detect(detector);
		expect((await detect(detector)).cache).toBe("hit");
		expect(jev.calls).toBe(1);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toMatch(
			/^https:\/\/jev-cache\.auto-router\.internal\/[0-9a-f]{64}$/,
		);
		expect(puts[0]?.cacheControl).toBe("max-age=300");
		const stored = JSON.stringify(puts);
		expect(stored).not.toContain(SECRET_TEXT);
		expect(stored).not.toContain(KEY);
	});
});

describe("cache through the app", () => {
	test("second request of the same context skips Jev and is traced", async () => {
		const upstream = createFakeUpstream((req) =>
			req.url.endsWith("/systemone")
				? Response.json({
						answers: Object.fromEntries(
							Object.keys(JSON.parse(req.body).questions).map((id) => [
								id,
								{ type: "noul", noul: id === "web.search" ? 0.9 : 0.05 },
							]),
						),
					})
				: Response.json({ id: "gen", choices: [] }),
		);
		const app = createApp({
			upstream: { baseUrl: "https://or.test/api/v1", fetch: upstream.fetch },
			catalog: { load: async () => createStaticModelCatalog(MODEL_PROFILES) },
			traceStore: createMemoryTraceStore(),
			semanticCache: createMemorySemanticCache(),
		});
		const send = () =>
			app.request("/api/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-sonnet-5",
					messages: [{ role: "user", content: SECRET_TEXT }],
				}),
			});
		const traceOf = async (res: Response) =>
			(await (
				await app.request(
					`/api/v1/auto-router/traces/${res.headers.get("Auto-Router-Trace-Id")}`,
					{ headers: { authorization: `Bearer ${KEY}` } },
				)
			).json()) as RoutingTrace;

		const first = await traceOf(await send());
		const second = await traceOf(await send());

		expect(
			upstream.requests.filter((r) => r.url.endsWith("/systemone")),
		).toHaveLength(1);
		expect(first).toMatchObject({
			semanticCache: "miss",
			billing: { jev: true },
		});
		expect(second).toMatchObject({
			semanticCache: "hit",
			billing: { jev: false, serverTools: ["web_search"] },
		});
		expect(second.semanticRequirements).toEqual(first.semanticRequirements);
	});
});
