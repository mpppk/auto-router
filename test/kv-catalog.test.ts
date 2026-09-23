import { describe, expect, test } from "bun:test";
import {
	CATALOG_KV_KEY,
	type CatalogKV,
	createKvModelCatalogSource,
	fromCompactCatalog,
	refreshCatalogKv,
	toCompactCatalog,
} from "../src/catalog/kv-catalog";
import type { ModelProfile } from "../src/catalog/model-catalog";
import { CATALOG_REFRESH_CRON, runScheduled } from "../src/scheduled";
import type { FetchLike } from "../src/upstream/openrouter";

const PROFILES: ModelProfile[] = [
	{
		id: "x-ai/grok-4.7",
		inputModalities: ["text", "image"],
		supportedParameters: ["tools", "reasoning"],
		contextLength: 500000,
	},
	{
		id: "text/no-tools",
		inputModalities: ["text"],
		supportedParameters: ["temperature"],
	},
];

const modelsResponse = () =>
	Response.json({
		data: PROFILES.map((p) => ({
			id: p.id,
			architecture: { input_modalities: p.inputModalities, extra: "x" },
			supported_parameters: p.supportedParameters,
			description: "long description ".repeat(50),
			pricing: { prompt: "0.000001" },
			...(p.contextLength ? { context_length: p.contextLength } : {}),
		})),
	});

const fakeKv = (initial?: string) => {
	const store = new Map<string, string>(
		initial === undefined ? [] : [[CATALOG_KV_KEY, initial]],
	);
	const kv = {
		store,
		gets: 0,
		fail: false,
		async get(key: string) {
			kv.gets++;
			if (kv.fail) throw new Error("kv down");
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
	};
	return kv as typeof kv & CatalogKV;
};

const countingFetch = (respond: () => Response = modelsResponse) => {
	const calls: string[] = [];
	const fetch: FetchLike = async (url) => {
		calls.push(url);
		return respond();
	};
	return { fetch, calls };
};

const BASE = "https://or.test/api/v1";

describe("compact catalog", () => {
	test("round-trips the routing fields", () => {
		const compact = toCompactCatalog(PROFILES, 123);
		expect(compact.fetchedAt).toBe(123);
		expect(compact.parameters).toEqual(["tools", "reasoning", "temperature"]);
		expect(fromCompactCatalog(JSON.parse(JSON.stringify(compact)))).toEqual(
			PROFILES,
		);
	});

	test.each([
		null,
		{ v: 2, modalities: [], parameters: [], models: [] },
		{ v: 1, modalities: ["text"], parameters: [], models: [["a", [3], []]] },
	])("rejects invalid data %#", (json) => {
		expect(() => fromCompactCatalog(json)).toThrow();
	});
});

describe("refreshCatalogKv", () => {
	test("stores only the reduced catalog", async () => {
		const kv = fakeKv();
		const { fetch, calls } = countingFetch();
		await refreshCatalogKv({ kv, baseUrl: BASE, fetch, now: () => 42 });
		expect(calls).toEqual([`${BASE}/models`]);
		const stored = kv.store.get(CATALOG_KV_KEY) ?? "";
		expect(stored).not.toContain("description");
		expect(stored).not.toContain("pricing");
		expect(fromCompactCatalog(JSON.parse(stored))).toEqual(PROFILES);
	});

	test("keeps the previous value when OpenRouter fails", async () => {
		const kv = fakeKv("previous");
		const { fetch } = countingFetch(() => new Response("", { status: 503 }));
		await expect(
			refreshCatalogKv({ kv, baseUrl: BASE, fetch }),
		).rejects.toThrow();
		expect(kv.store.get(CATALOG_KV_KEY)).toBe("previous");
	});

	test("scheduled handler refreshes the catalog on the catalog cron", async () => {
		const kv = fakeKv();
		const { fetch, calls } = countingFetch();
		await runScheduled(
			CATALOG_REFRESH_CRON,
			{ CATALOG_KV: kv as unknown as KVNamespace, TRACES_DB: {} as D1Database },
			{ fetch },
		);
		expect(calls).toHaveLength(1);
		expect(kv.store.has(CATALOG_KV_KEY)).toBe(true);
	});
});

describe("createKvModelCatalogSource", () => {
	test("reads the reduced catalog from KV without fetching /models", async () => {
		const kv = fakeKv(JSON.stringify(toCompactCatalog(PROFILES, 1)));
		const { fetch, calls } = countingFetch();
		let now = 0;
		const source = createKvModelCatalogSource({
			kv,
			baseUrl: BASE,
			fetch,
			ttlMs: 10,
			now: () => now,
		});

		const [a, b] = await Promise.all([source.load(), source.load()]);
		expect(a.lookup("x-ai/grok-4.7:nitro")).toEqual(PROFILES[0]);
		expect(b).toBe(a);
		expect(kv.gets).toBe(1);
		now = 20;
		await source.load();
		expect(kv.gets).toBe(2);
		expect(calls).toHaveLength(0);
	});

	test("fills KV from OpenRouter only when KV is empty", async () => {
		const kv = fakeKv();
		const { fetch, calls } = countingFetch();
		const catalog = await createKvModelCatalogSource({
			kv,
			baseUrl: BASE,
			fetch,
		}).load();
		expect(catalog.lookup("text/no-tools")).toEqual(PROFILES[1]);
		expect(calls).toHaveLength(1);
		expect(kv.store.has(CATALOG_KV_KEY)).toBe(true);

		// 別 isolate は KV から読む
		await createKvModelCatalogSource({ kv, baseUrl: BASE, fetch }).load();
		expect(calls).toHaveLength(1);
	});

	test("KV failure → stale isolate cache → empty catalog", async () => {
		const kv = fakeKv(JSON.stringify(toCompactCatalog(PROFILES, 1)));
		let now = 0;
		const source = createKvModelCatalogSource({
			kv,
			baseUrl: BASE,
			fetch: countingFetch().fetch,
			ttlMs: 10,
			now: () => now,
		});
		const first = await source.load();
		kv.fail = true;
		now = 20;
		expect(await source.load()).toBe(first);

		const cold = createKvModelCatalogSource({
			kv,
			baseUrl: BASE,
			fetch: countingFetch().fetch,
		});
		expect((await cold.load()).lookup("x-ai/grok-4.7")).toBeUndefined();
	});

	test("empty KV and OpenRouter failure → empty catalog", async () => {
		const catalog = await createKvModelCatalogSource({
			kv: fakeKv(),
			baseUrl: BASE,
			fetch: async () => {
				throw new Error("network");
			},
		}).load();
		expect(catalog.lookup("x-ai/grok-4.7")).toBeUndefined();
	});
});
