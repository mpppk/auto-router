/**
 * Jev semantic detector を gold dataset で評価する (#8 Phase A)。
 *
 *   bun run eval:semantic                      # Jev を呼んで評価 (結果は cache)
 *   bun run eval:semantic --cached             # cache 済み probability だけで再評価
 *   bun run eval:semantic --threshold social.x.search=0.7,0.2
 *   bun run eval:semantic --sweep              # required threshold を変えて比較
 *   bun run eval:semantic --json report.json
 *   bun run eval:semantic --min-precision 0.9 --min-recall 0.7   # 下回る capability があれば exit 1
 *
 * OPENROUTER_API_KEY が必要 (.env から Bun が自動で読み込む)。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
	type Capability,
	SEMANTIC_CAPABILITIES,
} from "../src/core/capabilities";
import { buildSemanticContext, toJevState } from "../src/semantic/context";
import {
	DEFAULT_THRESHOLD,
	type Threshold,
	type ThresholdConfig,
	thresholdFor,
} from "../src/semantic/detector";
import { createJevClient } from "../src/semantic/jev-client";
import { CAPABILITY_QUESTIONS } from "../src/semantic/questions";
import { DEFAULT_OPENROUTER_BASE_URL } from "../src/upstream/openrouter";
import { computeMetrics, formatRate, type Observation } from "./metrics";
import { SEMANTIC_GOLD_DATASET } from "./semantic-dataset";
import { parseThresholds } from "./thresholds";

const CACHE_PATH = "eval/.cache/semantic-probabilities.json";

const { values } = parseArgs({
	options: {
		cached: { type: "boolean", default: false },
		sweep: { type: "boolean", default: false },
		threshold: { type: "string", multiple: true, default: [] },
		json: { type: "string" },
		concurrency: { type: "string", default: "4" },
		"min-precision": { type: "string" },
		"min-recall": { type: "string" },
	},
});

type Cache = Record<
	string,
	{ key: string; probabilities: Record<string, number> }
>;

const loadCache = async (): Promise<Cache> => {
	try {
		return JSON.parse(await readFile(CACHE_PATH, "utf8")) as Cache;
	} catch {
		return {};
	}
};

const questions = Object.fromEntries(
	SEMANTIC_CAPABILITIES.map((c) => [c, CAPABILITY_QUESTIONS[c]]),
);

const collectProbabilities = async (): Promise<Cache> => {
	const cache = await loadCache();
	const apiKey = process.env.OPENROUTER_API_KEY;
	const jev = createJevClient({
		baseUrl: DEFAULT_OPENROUTER_BASE_URL,
		fetch: (input, init) => fetch(input, init),
		timeoutMs: 15000,
	});

	const pending = SEMANTIC_GOLD_DATASET.map((c) => {
		const state = toJevState(
			buildSemanticContext({
				conversation: c.conversation,
				instructions: c.instructions ?? [],
			}),
		);
		// state と question 文面が変わったら再取得する。
		const key = String(Bun.hash(JSON.stringify({ state, questions })));
		return { c, state, key };
	}).filter(({ c, key }) => cache[c.id]?.key !== key);

	if (pending.length > 0 && values.cached) {
		throw new Error(
			`${pending.length} cases are not cached; run without --cached`,
		);
	}
	if (pending.length > 0 && !apiKey) {
		throw new Error("OPENROUTER_API_KEY is required");
	}

	const concurrency = Number(values.concurrency);
	for (let i = 0; i < pending.length; i += concurrency) {
		await Promise.all(
			pending.slice(i, i + concurrency).map(async ({ c, state, key }) => {
				const probabilities = await jev.noul(state, questions, {
					apiKey: apiKey ?? "",
				});
				cache[c.id] = { key, probabilities };
			}),
		);
		process.stderr.write(".");
	}
	if (pending.length > 0) {
		process.stderr.write("\n");
		await mkdir(dirname(CACHE_PATH), { recursive: true });
		await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, "\t")}\n`);
	}
	return cache;
};

const toObservations = (cache: Cache): Observation[] =>
	SEMANTIC_GOLD_DATASET.flatMap((c) =>
		Object.entries(c.expected).map(([capability, gold]) => ({
			caseId: c.id,
			capability: capability as Capability,
			gold: gold === true,
			probability: cache[c.id]?.probabilities[capability] ?? Number.NaN,
		})),
	);

const printTable = (
	observations: Observation[],
	thresholds: ThresholdConfig,
) => {
	console.log(
		"capability            thr(req/not)   n  TP FP TN FN  unc  prec  recall  FPR   FNR   unc%",
	);
	const reports = SEMANTIC_CAPABILITIES.map((capability) => {
		const threshold = thresholdFor(capability, thresholds);
		const m = computeMetrics(capability, observations, threshold);
		console.log(
			[
				capability.padEnd(21),
				`${threshold.required.toFixed(2)}/${threshold.notRequired.toFixed(2)}`.padEnd(
					13,
				),
				String(m.n).padStart(3),
				String(m.tp).padStart(3),
				String(m.fp).padStart(2),
				String(m.tn).padStart(2),
				String(m.fn).padStart(2),
				String(m.uncertain).padStart(4),
				formatRate(m.precision),
				` ${formatRate(m.recall)}`,
				formatRate(m.falsePositiveRate),
				formatRate(m.falseNegativeRate),
				formatRate(m.uncertainRate),
			].join(" "),
		);
		return { ...m, threshold };
	});
	const errors = reports.flatMap((r) =>
		r.errors.map((e) => ({ capability: r.capability, ...e })),
	);
	if (errors.length > 0) {
		console.log("\nmisclassified (including uncertain):");
		for (const e of errors) {
			console.log(
				`  ${e.capability.padEnd(21)} ${e.caseId.padEnd(36)} gold=${e.gold ? "required    " : "not_required"} p=${e.probability.toFixed(2)}`,
			);
		}
	}
	return reports;
};

const printSweep = (observations: Observation[]) => {
	const grid: Threshold[] = [0.5, 0.6, 0.7, 0.8, 0.9].map((required) => ({
		required,
		notRequired: DEFAULT_THRESHOLD.notRequired,
	}));
	console.log("\nthreshold sweep (notRequired fixed):");
	console.log("capability            req   prec  recall  FPR   FNR   unc%");
	for (const capability of SEMANTIC_CAPABILITIES) {
		for (const threshold of grid) {
			const m = computeMetrics(capability, observations, threshold);
			if (m.n === 0) continue;
			console.log(
				[
					capability.padEnd(21),
					threshold.required.toFixed(2),
					formatRate(m.precision),
					` ${formatRate(m.recall)}`,
					formatRate(m.falsePositiveRate),
					formatRate(m.falseNegativeRate),
					formatRate(m.uncertainRate),
				].join(" "),
			);
		}
	}
};

const thresholds = parseThresholds(values.threshold ?? []);
const cache = await collectProbabilities();
const observations = toObservations(cache);
const reports = printTable(observations, thresholds);
if (values.sweep) printSweep(observations);
if (values.json) {
	await writeFile(
		values.json,
		`${JSON.stringify({ thresholds, reports, observations }, null, "\t")}\n`,
	);
}

// 定期実行 (#27) 用の gate。Jev model (alias) の更新で判定傾向が変わったら失敗させる。
const minPrecision =
	values["min-precision"] === undefined
		? undefined
		: Number(values["min-precision"]);
const minRecall =
	values["min-recall"] === undefined ? undefined : Number(values["min-recall"]);
const gateFailures = reports.flatMap((r) => [
	...(minPrecision !== undefined &&
	!Number.isNaN(r.precision) &&
	r.precision < minPrecision
		? [`${r.capability} precision ${formatRate(r.precision)} < ${minPrecision}`]
		: []),
	...(minRecall !== undefined && !Number.isNaN(r.recall) && r.recall < minRecall
		? [`${r.capability} recall ${formatRate(r.recall)} < ${minRecall}`]
		: []),
]);
if (gateFailures.length > 0) {
	console.log("\ngate failures:");
	for (const f of gateFailures) console.log(`  ${f}`);
	process.exit(1);
}
