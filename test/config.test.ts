import { describe, expect, test } from "bun:test";
import { parseModelList } from "../src/config";
import { createTestApp } from "./helpers/app";

describe("parseModelList", () => {
	test("parses a comma-separated list", () => {
		expect(
			parseModelList("X", " x-ai/grok-4.7 , x-ai/grok-4.6,x-ai/grok-4.7"),
		).toEqual(["x-ai/grok-4.7", "x-ai/grok-4.6"]);
	});

	test.each([undefined, "", "  ", "a,,b", "a b"])(
		"%p → undefined (use the default)",
		(raw) => {
			expect(parseModelList("X", raw)).toBeUndefined();
		},
	);
});

describe("DEFAULT_ROUTE_MODELS Worker var", () => {
	const request = async (env: Record<string, unknown>) => {
		const { app, upstream } = createTestApp({
			semantic: { "social.x.search": 0.95 },
		});
		const res = await app.request(
			"/api/v1/chat/completions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer sk-or-test",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-sonnet-5",
					messages: [{ role: "user", content: "Xの反応は？" }],
				}),
			},
			env,
		);
		return {
			res,
			forwarded: JSON.parse(upstream.requests[0]?.body ?? "{}") as Record<
				string,
				unknown
			>,
		};
	};

	test("overrides the default route without code changes", async () => {
		const { res, forwarded } = await request({
			DEFAULT_ROUTE_MODELS: "x-ai/grok-4.6,x-ai/grok-3,x-ai/grok-4.7",
		});
		// grok-3 は X Search 非対応なので除外される
		expect(res.headers.get("Auto-Router-Selected-Model")).toBe(
			"x-ai/grok-4.6,x-ai/grok-4.7",
		);
		expect(forwarded.model).toBe("x-ai/grok-4.6");
		expect(forwarded.models).toEqual(["x-ai/grok-4.7"]);
	});

	test("invalid value falls back to the registry default", async () => {
		const { res } = await request({ DEFAULT_ROUTE_MODELS: "a,,b" });
		expect(res.headers.get("Auto-Router-Selected-Model")).toBe(
			"x-ai/grok-4.7,x-ai/grok-4.6",
		);
	});
});
