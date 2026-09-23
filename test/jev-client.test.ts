import { describe, expect, test } from "bun:test";
import {
	createJevClient,
	JEV_MODEL,
	JevError,
	type JevFailureReason,
	type NoulQuestion,
} from "../src/semantic/jev-client";
import type { FetchLike } from "../src/upstream/openrouter";

const questions: Record<string, NoulQuestion> = {
	a: { type: "noul", instructions: "A?" },
	b: { type: "noul", instructions: "B?" },
};

const client = (fetch: FetchLike, timeoutMs = 1000) =>
	createJevClient({ baseUrl: "https://or.test/api/v1", fetch, timeoutMs });

const expectReason = async (
	promise: Promise<unknown>,
	reason: JevFailureReason,
) => {
	const err = await promise.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(JevError);
	expect((err as JevError).reason).toBe(reason);
};

describe("createJevClient", () => {
	test("calls OpenRouter System One with the caller key and returns probabilities", async () => {
		let captured: { url: string; init: RequestInit | undefined } | undefined;
		const jev = client(async (url, init) => {
			captured = { url, init };
			return Response.json({
				answers: {
					a: { type: "noul", noul: 0.9 },
					b: { type: "noul", noul: 0 },
				},
			});
		});

		const result = await jev.noul({ s: 1 }, questions, { apiKey: "sk-or-x" });

		expect(result).toEqual({ a: 0.9, b: 0 });
		expect(captured?.url).toBe("https://or.test/api/v1/systemone");
		expect(new Headers(captured?.init?.headers).get("authorization")).toBe(
			"Bearer sk-or-x",
		);
		expect(JSON.parse(String(captured?.init?.body))).toEqual({
			model: JEV_MODEL,
			state: { s: 1 },
			questions,
		});
	});

	test("timeout → jev_timeout", async () => {
		const jev = client(
			(_url, init) =>
				new Promise((_, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("timeout", "TimeoutError")),
					);
				}),
			10,
		);
		await expectReason(
			jev.noul("s", questions, { apiKey: "k" }),
			"jev_timeout",
		);
	});

	test("5xx → jev_error", async () => {
		const jev = client(async () => new Response("oops", { status: 503 }));
		await expectReason(jev.noul("s", questions, { apiKey: "k" }), "jev_error");
	});

	test("401 → jev_unauthorized", async () => {
		const jev = client(
			async () => new Response("unauthorized", { status: 401 }),
		);
		await expectReason(
			jev.noul("s", questions, { apiKey: "k" }),
			"jev_unauthorized",
		);
	});

	test("403 (e.g. key restrictions) stays jev_error", async () => {
		const jev = client(async () => new Response("forbidden", { status: 403 }));
		await expectReason(jev.noul("s", questions, { apiKey: "k" }), "jev_error");
	});

	test("network error → jev_error", async () => {
		const jev = client(async () => {
			throw new TypeError("fetch failed");
		});
		await expectReason(jev.noul("s", questions, { apiKey: "k" }), "jev_error");
	});

	test.each([
		["non-JSON", () => new Response("<html>")],
		["no answers", () => Response.json({})],
		["missing answer", () => Response.json({ answers: { a: { noul: 0.5 } } })],
		[
			"out of range",
			() => Response.json({ answers: { a: { noul: 0.5 }, b: { noul: 1.5 } } }),
		],
		[
			"non-number",
			() => Response.json({ answers: { a: { noul: 0.5 }, b: { noul: "x" } } }),
		],
	])("%s → jev_invalid_response", async (_, respond) => {
		const jev = client(async () => respond());
		await expectReason(
			jev.noul("s", questions, { apiKey: "k" }),
			"jev_invalid_response",
		);
	});
});
