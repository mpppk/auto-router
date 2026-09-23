import { describe, expect, test } from "bun:test";
import { createOpenRouterModelCatalogSource } from "../src/catalog/model-catalog";
import type { FetchLike } from "../src/upstream/openrouter";

const modelsResponse = () =>
	Response.json({
		data: [
			{
				id: "x-ai/grok-4.7",
				context_length: 500000,
				architecture: { input_modalities: ["text", "image"] },
				supported_parameters: ["tools"],
			},
		],
	});

describe("createOpenRouterModelCatalogSource", () => {
	test("loads and caches profiles", async () => {
		let calls = 0;
		const fetch: FetchLike = async (url) => {
			calls++;
			expect(url).toBe("https://or.test/api/v1/models");
			return modelsResponse();
		};
		const source = createOpenRouterModelCatalogSource({
			baseUrl: "https://or.test/api/v1",
			fetch,
		});

		const [a, b] = await Promise.all([source.load(), source.load()]);
		await source.load();

		expect(a.lookup("x-ai/grok-4.7")).toEqual({
			id: "x-ai/grok-4.7",
			inputModalities: ["text", "image"],
			supportedParameters: ["tools"],
			contextLength: 500000,
		});
		expect(b).toBe(a);
		expect(calls).toBe(1);
	});

	test("refreshes after ttl and keeps stale cache on failure", async () => {
		let now = 0;
		let fail = false;
		const source = createOpenRouterModelCatalogSource({
			baseUrl: "https://or.test/api/v1",
			fetch: async () =>
				fail ? new Response("", { status: 500 }) : modelsResponse(),
			ttlMs: 10,
			now: () => now,
		});
		const first = await source.load();
		now = 20;
		fail = true;
		const second = await source.load();
		expect(second).toBe(first);
	});

	test("returns an empty catalog when unavailable", async () => {
		const source = createOpenRouterModelCatalogSource({
			baseUrl: "https://or.test/api/v1",
			fetch: async () => {
				throw new Error("network");
			},
		});
		expect((await source.load()).lookup("x-ai/grok-4.7")).toBeUndefined();
	});
});
