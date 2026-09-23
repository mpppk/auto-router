/**
 * end-to-end routing eval (#8 Phase B)。
 *
 *   bun run eval:routing                                  # 固定 probability で評価 (API 呼び出しなし)
 *   bun run eval:routing --threshold social.x.search=0.95 # threshold を変えて比較
 *   bun run eval:routing --live                           # semantic 判定に実 Jev を使う (要 OPENROUTER_API_KEY)
 *   bun run eval:routing --json report.json
 *   bun run eval:routing --live --strict                  # 期待値の不一致でも失敗 (定期実行用)
 *
 * Hard Requirement violation / incompatible fallback leakage / caller tool preservation failure が
 * 1件でもあれば exit code 1。
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createSemanticDetector } from "../src/semantic/detector";
import { createJevClient } from "../src/semantic/jev-client";
import { DEFAULT_OPENROUTER_BASE_URL } from "../src/upstream/openrouter";
import { ROUTING_GOLD_DATASET } from "./routing-dataset";
import { runRoutingEval } from "./routing-eval";
import { parseThresholds } from "./thresholds";

const { values } = parseArgs({
	options: {
		threshold: { type: "string", multiple: true, default: [] },
		live: { type: "boolean", default: false },
		/** 期待値 (effective chain / route reason / error) の不一致でも exit 1 にする。 */
		strict: { type: "boolean", default: false },
		json: { type: "string" },
	},
});

const thresholds = parseThresholds(values.threshold ?? []);
const apiKey = process.env.OPENROUTER_API_KEY;
if (values.live && !apiKey)
	throw new Error("OPENROUTER_API_KEY is required for --live");

const report = await runRoutingEval({
	thresholds,
	// Jev 障害 / 中間確率を模擬する case は実 Jev では再現できないため除外する。
	...(values.live
		? {
				cases: ROUTING_GOLD_DATASET.filter(
					(c) => !c.tags.includes("simulated_semantic"),
				),
			}
		: {}),
	...(values.live && apiKey
		? {
				live: {
					apiKey,
					detector: createSemanticDetector({
						jev: createJevClient({
							baseUrl: DEFAULT_OPENROUTER_BASE_URL,
							fetch: (input, init) => fetch(input, init),
							timeoutMs: 15000,
						}),
						thresholds,
					}),
				},
			}
		: {}),
});

for (const r of report.results) {
	const problems = [
		...r.expectationFailures.map((m) => `expectation: ${m}`),
		...r.violations.map((m) => `VIOLATION: ${m}`),
		...r.leakage.map((m) => `LEAKAGE: ${m}`),
		...r.toolPreservationFailures.map((m) => `TOOL: ${m}`),
		...(r.unnecessaryOverride ? ["unnecessary override"] : []),
	];
	const mark = problems.length === 0 ? "ok  " : "FAIL";
	console.log(
		`${mark} ${r.id.padEnd(48)} ${String(r.status).padEnd(4)} ${(r.reason ?? "").padEnd(24)} ${r.effectiveChain.join(",") || r.errorCode || ""}`,
	);
	for (const p of problems) console.log(`       - ${p}`);
}

const m = report.metrics;
console.log(`
cases                              ${m.cases}
expectation passed                 ${m.expectationPassed}/${m.cases}
Hard Requirement violations        ${m.hardRequirementViolations}
incompatible fallback leakage      ${m.incompatibleFallbackLeakage}
unnecessary model override rate    ${(m.unnecessaryOverrideRate * 100).toFixed(1)}% (${m.unnecessaryOverrides})
caller tool preservation failures  ${m.callerToolPreservationFailures}`);

if (values.json) {
	await writeFile(
		values.json,
		`${JSON.stringify({ thresholds, ...report }, null, "\t")}\n`,
	);
}
if (
	m.hardRequirementViolations > 0 ||
	m.incompatibleFallbackLeakage > 0 ||
	m.callerToolPreservationFailures > 0 ||
	(values.strict && m.expectationPassed < m.cases)
) {
	process.exit(1);
}
