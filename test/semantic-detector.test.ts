import { describe, expect, test } from "bun:test";
import { SEMANTIC_CAPABILITIES } from "../src/core/capabilities";
import type { ConversationMessage } from "../src/core/types";
import {
	buildSemanticContext,
	MAX_MESSAGE_CHARS,
	ROUTING_CONTEXT_MESSAGES,
	toJevState,
} from "../src/semantic/context";
import {
	classify,
	createSemanticDetector,
	DEFAULT_THRESHOLD,
	toRequirements,
} from "../src/semantic/detector";
import { type JevClient, JevError } from "../src/semantic/jev-client";

const messages = (n: number): ConversationMessage[] =>
	Array.from({ length: n }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		text: `m${i}`,
	}));

describe("buildSemanticContext", () => {
	test(`uses the latest ${ROUTING_CONTEXT_MESSAGES} user/assistant messages`, () => {
		const context = buildSemanticContext({
			conversation: messages(20),
			instructions: ["sys"],
		});
		expect(context.conversation).toHaveLength(12);
		expect(context.conversation[0]?.text).toBe("m8");
		expect(context.latestUserMessage).toBe("m18");
		// system / developer は別枠
		expect(context.instructions).toEqual(["sys"]);
	});

	test("truncates huge messages in the middle", () => {
		const huge = `${"a".repeat(5000)}END`;
		const context = buildSemanticContext({
			conversation: [{ role: "user", text: huge }],
			instructions: [],
		});
		const text = context.conversation[0]?.text ?? "";
		expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
		expect(text.endsWith("END")).toBe(true);
	});

	test("no user message → no latestUserMessage", () => {
		const context = buildSemanticContext({
			conversation: [{ role: "assistant", text: "hi" }],
			instructions: [],
		});
		expect(context.latestUserMessage).toBeUndefined();
	});

	test("Jev state marks the latest user message", () => {
		const state = toJevState(
			buildSemanticContext({ conversation: messages(3), instructions: [] }),
		);
		expect(state.latest_user_message).toBe("m2");
		expect(state.conversation).toEqual([
			{ role: "user", content: "m0" },
			{ role: "assistant", content: "m1" },
			{ role: "user", content: "m2" },
		]);
		expect("system_instructions" in state).toBe(false);
	});
});

describe("classify", () => {
	test.each([
		[0.8, "required"],
		[0.95, "required"],
		[0.79, "uncertain"],
		[0.5, "uncertain"],
		[0.21, "uncertain"],
		[0.2, "not_required"],
		[0, "not_required"],
	] as const)("%p → %s", (p, decision) => {
		expect(classify(p, DEFAULT_THRESHOLD)).toBe(decision);
	});

	test("never yields preferred", () => {
		for (let p = 0; p <= 1; p += 0.01) {
			expect(["required", "uncertain", "not_required"]).toContain(
				classify(p, DEFAULT_THRESHOLD),
			);
		}
	});
});

describe("toRequirements", () => {
	test("thresholds can be changed per capability", () => {
		const requirements = toRequirements(
			{ "social.x.search": 0.7, "web.search": 0.7 },
			{ "social.x.search": { required: 0.6, notRequired: 0.1 } },
		);
		expect(requirements).toEqual([
			{
				kind: "semantic",
				capability: "social.x.search",
				requiredProbability: 0.7,
				decision: "required",
			},
			{
				kind: "semantic",
				capability: "web.search",
				requiredProbability: 0.7,
				decision: "uncertain",
			},
		]);
	});
});

const fakeJev = (impl: JevClient["noul"]): JevClient & { calls: unknown[] } => {
	const calls: unknown[] = [];
	return {
		calls,
		noul: (state, questions, options) => {
			calls.push({ state, questions, options });
			return impl(state, questions, options);
		},
	};
};

const conversation = {
	conversation: [
		{ role: "user" as const, text: "Google Mapsの口コミでこの2店舗を比較して" },
	],
	instructions: [],
};

describe("createSemanticDetector", () => {
	test("asks every semantic capability and classifies the answers", async () => {
		const jev = fakeJev(async (_state, questions) =>
			Object.fromEntries(
				Object.keys(questions).map((id) => [
					id,
					id.startsWith("places") || id === "source.google_maps" ? 0.95 : 0.05,
				]),
			),
		);
		const detector = createSemanticDetector({ jev });

		const result = await detector.detect(conversation, { apiKey: "k" });

		expect(result.status).toBe("ok");
		expect(result.messagesUsed).toBe(1);
		expect(result.requirements.map((r) => r.capability)).toEqual([
			...SEMANTIC_CAPABILITIES,
		]);
		const required = result.requirements
			.filter((r) => r.decision === "required")
			.map((r) => r.capability);
		expect(required).toEqual([
			"places.search",
			"places.opening_hours",
			"places.reviews",
			"source.google_maps",
		]);
	});

	test("skips Jev when there is no user message", async () => {
		const jev = fakeJev(async () => ({}));
		const detector = createSemanticDetector({ jev });

		const result = await detector.detect(
			{ conversation: [], instructions: ["sys"] },
			{ apiKey: "k" },
		);

		expect(result).toEqual({
			status: "skipped",
			requirements: [],
			messagesUsed: 0,
		});
		expect(jev.calls).toHaveLength(0);
	});

	test.each(["jev_timeout", "jev_error", "jev_invalid_response"] as const)(
		"%s → degraded without requirements",
		async (reason) => {
			const jev = fakeJev(async () => {
				throw new JevError(reason, "x");
			});
			const detector = createSemanticDetector({ jev });

			const result = await detector.detect(conversation, { apiKey: "k" });

			expect(result.status).toBe("degraded");
			expect(result).toMatchObject({ reason, requirements: [] });
		},
	);

	test("unexpected errors are degraded as jev_error", async () => {
		const jev = fakeJev(async () => {
			throw new Error("boom");
		});
		const result = await createSemanticDetector({ jev }).detect(conversation, {
			apiKey: "k",
		});
		expect(result).toMatchObject({ status: "degraded", reason: "jev_error" });
	});
});
