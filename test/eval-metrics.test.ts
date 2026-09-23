import { describe, expect, test } from "bun:test";
import { computeMetrics, type Observation } from "../eval/metrics";
import { SEMANTIC_GOLD_DATASET } from "../eval/semantic-dataset";

const obs = (
	caseId: string,
	gold: boolean,
	probability: number,
): Observation => ({
	caseId,
	capability: "social.x.search",
	gold,
	probability,
});

describe("computeMetrics", () => {
	test("computes confusion matrix, rates and uncertain rate", () => {
		const m = computeMetrics(
			"social.x.search",
			[
				obs("tp", true, 0.9),
				obs("fn-uncertain", true, 0.5),
				obs("fn", true, 0.1),
				obs("fp", false, 0.85),
				obs("tn", false, 0.05),
				obs("tn-uncertain", false, 0.3),
			],
			{ required: 0.8, notRequired: 0.2 },
		);
		expect(m).toMatchObject({
			n: 6,
			tp: 1,
			fn: 2,
			fp: 1,
			tn: 2,
			uncertain: 2,
			precision: 0.5,
			recall: 1 / 3,
			falsePositiveRate: 1 / 3,
			falseNegativeRate: 2 / 3,
			uncertainRate: 2 / 6,
		});
		expect(m.errors.map((e) => e.caseId)).toEqual([
			"fn-uncertain",
			"fn",
			"fp",
			"tn-uncertain",
		]);
	});
});

describe("SEMANTIC_GOLD_DATASET", () => {
	test("has unique ids", () => {
		const ids = SEMANTIC_GOLD_DATASET.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test.each([
		"continuation",
		"topic_shift",
		"search_reuse",
		"explicit_no_search",
		"mention_only",
		"places",
	])("covers %s cases", (tag) => {
		expect(SEMANTIC_GOLD_DATASET.some((c) => c.tags.includes(tag))).toBe(true);
	});

	test("includes Places / Maps required cases", () => {
		const capabilities = new Set(
			SEMANTIC_GOLD_DATASET.flatMap((c) =>
				Object.entries(c.expected)
					.filter(([, gold]) => gold)
					.map(([capability]) => capability),
			),
		);
		for (const capability of [
			"places.search",
			"places.opening_hours",
			"places.reviews",
			"geo.proximity",
			"source.google_maps",
		]) {
			expect(capabilities.has(capability)).toBe(true);
		}
	});
});
