import { describe, expect, test } from "bun:test";
import {
	applyCapabilityDegrades,
	type SemanticRequirement,
} from "../src/core/capabilities";

describe("applyCapabilityDegrades", () => {
	const req = (
		capability: SemanticRequirement["capability"],
		p: number,
		decision: SemanticRequirement["decision"] = "required",
	): SemanticRequirement => ({
		kind: "semantic",
		capability,
		decision,
		requiredProbability: p,
	});

	test("replaces required capabilities with the target once", () => {
		const result = applyCapabilityDegrades(
			[
				req("places.search", 0.9),
				req("geo.proximity", 0.95),
				req("web.search", 0.5, "uncertain"),
			],
			[
				{ from: "places.search", to: "web.search" },
				{ from: "geo.proximity", to: "web.search" },
				{ from: "places.reviews", to: "web.search" },
			],
		);
		expect(result.requirements).toEqual([req("web.search", 0.95)]);
		expect(result.applied).toEqual([
			{ from: "places.search", to: "web.search" },
			{ from: "geo.proximity", to: "web.search" },
		]);
	});

	test("ignores non-required capabilities", () => {
		const input = [req("places.search", 0.5, "uncertain")];
		const result = applyCapabilityDegrades(input, [
			{ from: "places.search", to: "web.search" },
		]);
		expect(result).toEqual({ requirements: input, applied: [] });
	});
});
