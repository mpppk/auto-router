import { describe, expect, test } from "bun:test";
import { CLAUDE, GROK } from "../eval/routing-dataset";
import {
	checkForwardedRequest,
	EVAL_MODEL_PROFILES,
	runRoutingEval,
} from "../eval/routing-eval";
import { createStaticModelCatalog } from "../src/catalog/model-catalog";
import { required, structural } from "./helpers/requirements";

const catalog = createStaticModelCatalog(EVAL_MODEL_PROFILES);
const X_TOOL = {
	type: "openrouter:web_search",
	parameters: { engine: "native", x_search: {} },
};
const fn = { type: "function", function: { name: "f" } };

describe("routing eval (#8 Phase B)", () => {
	test("all gold cases pass with zero Hard Requirement violations", async () => {
		const report = await runRoutingEval();
		const failures = report.results.filter(
			(r) =>
				r.expectationFailures.length > 0 ||
				r.violations.length > 0 ||
				r.leakage.length > 0 ||
				r.toolPreservationFailures.length > 0 ||
				r.unnecessaryOverride,
		);
		expect(failures).toEqual([]);
		expect(report.metrics).toMatchObject({
			hardRequirementViolations: 0,
			incompatibleFallbackLeakage: 0,
			unnecessaryOverrides: 0,
			callerToolPreservationFailures: 0,
		});
	});

	test("changing thresholds changes decisions but never violates Hard Requirements", async () => {
		const report = await runRoutingEval({
			thresholds: {
				"social.x.search": { required: 0.99, notRequired: 0.2 },
				"web.search": { required: 0.99, notRequired: 0.2 },
			},
		});
		expect(report.metrics.expectationPassed).toBeLessThan(report.metrics.cases);
		expect(report.metrics.hardRequirementViolations).toBe(0);
		expect(report.metrics.incompatibleFallbackLeakage).toBe(0);
	});
});

describe("checkForwardedRequest detects", () => {
	const original = { model: CLAUDE, models: [GROK], messages: [], tools: [fn] };

	test("incompatible fallback leakage", () => {
		const check = checkForwardedRequest({
			original,
			forwarded: {
				...original,
				model: GROK,
				models: [CLAUDE],
				tools: [fn, X_TOOL],
			},
			hard: [required("social.x.search")],
			catalog,
		});
		expect(check.leakage).toEqual([
			`fallback ${CLAUDE} cannot satisfy social.x.search`,
		]);
	});

	test("missing tool, blocking tool_choice and missing require_parameters", () => {
		const check = checkForwardedRequest({
			original,
			forwarded: {
				...original,
				model: GROK,
				models: undefined,
				tool_choice: "none",
			},
			hard: [required("social.x.search"), structural("tools")],
			catalog,
		});
		expect(check.violations).toEqual([
			"required openrouter:web_search tool is missing",
			"X Search requires engine native and x_search",
			'tool_choice "none" blocks the required server tool',
			"provider.require_parameters must be true",
		]);
	});

	test("dropped structural fields, relaxed provider and lost caller tools", () => {
		const check = checkForwardedRequest({
			original: {
				...original,
				response_format: { type: "json_object" },
				provider: { only: ["xai"] },
			},
			forwarded: { model: GROK, messages: [], tools: [X_TOOL], provider: {} },
			hard: [required("social.x.search")],
			catalog,
		});
		expect(check.violations).toEqual([
			"provider.only was changed",
			"response_format was not preserved",
		]);
		expect(check.toolPreservationFailures).toHaveLength(1);
	});
});
