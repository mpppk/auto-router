import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

describe("GET /health", () => {
	test("returns ok", async () => {
		const res = await createApp().request("/health");
		const body: unknown = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual({ status: "ok" });
	});
});
