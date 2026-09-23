import { chatCompletionsAdapter } from "../src/adapters/chat-completions";
import { createApp } from "../src/app";
import {
	createStaticModelCatalog,
	type ModelCatalog,
	type ModelProfile,
} from "../src/catalog/model-catalog";
import {
	type Requirement,
	SEMANTIC_CAPABILITIES,
} from "../src/core/capabilities";
import { normalizeModelChain } from "../src/core/model-chain";
import { allowsAnyProvider } from "../src/core/provider";
import { SEMANTIC_REGISTRY, STRUCTURAL_REGISTRY } from "../src/core/registry";
import { detectStructuralRequirements } from "../src/core/structural";
import {
	type SemanticDetector,
	type ThresholdConfig,
	toRequirements,
} from "../src/semantic/detector";
import { createMemoryTraceStore } from "../src/trace/store";
import type { RoutingTrace } from "../src/trace/trace";
import {
	CLAUDE,
	GPT,
	GROK,
	GROK_OLD,
	ROUTING_GOLD_DATASET,
	type RoutingGoldCase,
	TEXT_ONLY,
} from "./routing-dataset";

const FULL_PARAMS = [
	"tools",
	"tool_choice",
	"structured_outputs",
	"response_format",
	"reasoning",
];

/** eval 用の固定 model catalog。 */
export const EVAL_MODEL_PROFILES: ModelProfile[] = [
	{
		id: GROK,
		inputModalities: ["text", "image", "file"],
		supportedParameters: FULL_PARAMS,
	},
	{
		id: GROK_OLD,
		inputModalities: ["text", "image", "file"],
		supportedParameters: FULL_PARAMS,
	},
	{
		id: CLAUDE,
		inputModalities: ["text", "image", "file"],
		supportedParameters: FULL_PARAMS,
	},
	{
		id: GPT,
		inputModalities: ["text", "image", "file"],
		supportedParameters: FULL_PARAMS,
	},
	{
		id: TEXT_ONLY,
		inputModalities: ["text"],
		supportedParameters: ["temperature"],
	},
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/** routing で変更してよい field。それ以外は caller の値がそのまま残っていなければならない。 */
const ROUTABLE_FIELDS = new Set([
	"model",
	"models",
	"tools",
	"tool_choice",
	"provider",
]);

const PARAMETER_CAPABILITIES = new Set([
	"tools",
	"structured_output",
	"json_output",
	"reasoning",
]);

const WEB_SEARCH = "openrouter:web_search";

/**
 * forwarded request が Hard Requirements を満たしているかを、resolver とは独立に検査する。
 * registry の support 定義と model catalog を ground truth とする。
 */
export const checkForwardedRequest = (input: {
	original: Record<string, unknown>;
	forwarded: Record<string, unknown>;
	hard: readonly Requirement[];
	catalog: ModelCatalog;
}) => {
	const { original, forwarded, hard, catalog } = input;
	const violations: string[] = [];
	const leakage: string[] = [];
	const toolPreservationFailures: string[] = [];

	const chain = normalizeModelChain(
		typeof forwarded.model === "string" ? forwarded.model : undefined,
		Array.isArray(forwarded.models)
			? (forwarded.models as string[])
			: undefined,
	);
	const provider = isRecord(forwarded.provider)
		? forwarded.provider
		: undefined;

	const unsatisfied = (model: string) =>
		hard.flatMap((r) => {
			const profile = catalog.lookup(model);
			if (r.kind === "semantic") {
				const definition = SEMANTIC_REGISTRY[r.capability];
				if (definition.support(model, profile) !== "supported")
					return [r.capability];
				if (
					definition.providers &&
					!allowsAnyProvider(provider, definition.providers)
				) {
					return [`${r.capability}(provider)`];
				}
				return [];
			}
			return STRUCTURAL_REGISTRY[r.capability].support(model, profile) ===
				"unsupported"
				? [r.capability]
				: [];
		});

	chain.forEach((model, i) => {
		const missing = unsatisfied(model);
		if (missing.length === 0) return;
		const message = `${model} cannot satisfy ${missing.join(", ")}`;
		if (i === 0) violations.push(`primary ${message}`);
		else leakage.push(`fallback ${message}`);
	});

	// required server tool と tool_choice
	const tools = Array.isArray(forwarded.tools) ? forwarded.tools : [];
	const webSearch = tools.find((t) => isRecord(t) && t.type === WEB_SEARCH);
	const params =
		isRecord(webSearch) && isRecord(webSearch.parameters)
			? webSearch.parameters
			: {};
	const semantic = new Set(
		hard.flatMap((r) => (r.kind === "semantic" ? [r.capability] : [])),
	);
	if (
		(semantic.has("web.search") || semantic.has("social.x.search")) &&
		!webSearch
	) {
		violations.push("required openrouter:web_search tool is missing");
	}
	if (
		semantic.has("social.x.search") &&
		(params.engine !== "native" || !isRecord(params.x_search))
	) {
		violations.push("X Search requires engine native and x_search");
	}
	if (semantic.has("web.search") || semantic.has("social.x.search")) {
		const choice = forwarded.tool_choice;
		if (choice === "none" || (isRecord(choice) && choice.type !== WEB_SEARCH)) {
			violations.push(
				`tool_choice ${JSON.stringify(choice)} blocks the required server tool`,
			);
		}
	}

	// provider parameter enforcement と caller provider 制約の保持
	if (
		hard.some((r) => PARAMETER_CAPABILITIES.has(r.capability)) &&
		provider?.require_parameters !== true
	) {
		violations.push("provider.require_parameters must be true");
	}
	if (isRecord(original.provider)) {
		for (const [key, value] of Object.entries(original.provider)) {
			if (key === "require_parameters") continue;
			if (!same(provider?.[key], value))
				violations.push(`provider.${key} was changed`);
		}
	}

	// structural / 未知 field の保持
	for (const [key, value] of Object.entries(original)) {
		if (ROUTABLE_FIELDS.has(key)) continue;
		if (!same(forwarded[key], value))
			violations.push(`${key} was not preserved`);
	}

	// caller tool の保持
	for (const tool of Array.isArray(original.tools) ? original.tools : []) {
		if (
			isRecord(tool) &&
			typeof tool.type === "string" &&
			tool.type !== "function"
		) {
			const kept = tools.find((t) => isRecord(t) && t.type === tool.type);
			const callerParams = isRecord(tool.parameters) ? tool.parameters : {};
			const keptParams =
				isRecord(kept) && isRecord(kept.parameters) ? kept.parameters : {};
			const preserved =
				kept !== undefined &&
				Object.entries(callerParams).every(
					([k, v]) =>
						same(keptParams[k], v) || (k === "engine" && v === "auto"),
				);
			if (!preserved)
				toolPreservationFailures.push(`${tool.type} was not preserved`);
		} else if (!tools.some((t) => same(t, tool))) {
			toolPreservationFailures.push(
				`${JSON.stringify(tool)} was not preserved`,
			);
		}
	}

	return { chain, violations, leakage, toolPreservationFailures, unsatisfied };
};

export interface RoutingCaseResult {
	id: string;
	tags: string[];
	status: number;
	reason?: string;
	effectiveChain: string[];
	errorCode?: string;
	expectationFailures: string[];
	violations: string[];
	leakage: string[];
	toolPreservationFailures: string[];
	unnecessaryOverride: boolean;
	overridden: boolean;
}

export interface RoutingEvalReport {
	results: RoutingCaseResult[];
	metrics: {
		cases: number;
		expectationPassed: number;
		hardRequirementViolations: number;
		incompatibleFallbackLeakage: number;
		unnecessaryOverrides: number;
		unnecessaryOverrideRate: number;
		callerToolPreservationFailures: number;
	};
}

const fixedDetector = (
	semantic: RoutingGoldCase["semantic"],
	thresholds: ThresholdConfig,
): SemanticDetector => ({
	async detect(context) {
		const messagesUsed = Math.min(context.conversation.length, 12);
		if ("degraded" in semantic && typeof semantic.degraded === "string") {
			return {
				status: "degraded",
				reason: semantic.degraded,
				requirements: [],
				messagesUsed,
			};
		}
		const probabilities = semantic as Partial<Record<string, number>>;
		return {
			status: "ok",
			requirements: toRequirements(
				Object.fromEntries(
					SEMANTIC_CAPABILITIES.flatMap((c) =>
						probabilities[c] !== undefined ? [[c, probabilities[c]]] : [],
					),
				),
				thresholds,
			),
			messagesUsed,
		};
	},
});

const API_KEY = "sk-or-eval";

export const runRoutingEval = async (
	options: {
		thresholds?: ThresholdConfig;
		cases?: RoutingGoldCase[];
		/** 実 Jev で semantic 判定する場合の detector と API key。 */
		live?: { detector: SemanticDetector; apiKey: string };
	} = {},
): Promise<RoutingEvalReport> => {
	const thresholds = options.thresholds ?? {};
	const catalog = createStaticModelCatalog(EVAL_MODEL_PROFILES);
	const results: RoutingCaseResult[] = [];

	for (const c of options.cases ?? ROUTING_GOLD_DATASET) {
		const forwardedBodies: Record<string, unknown>[] = [];
		const traceStore = createMemoryTraceStore();
		const app = createApp({
			upstream: {
				baseUrl: "https://openrouter.eval/api/v1",
				fetch: async (_url, init) => {
					forwardedBodies.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>,
					);
					return Response.json({ id: "gen-eval", choices: [] });
				},
			},
			detector: options.live?.detector ?? fixedDetector(c.semantic, thresholds),
			catalog: { load: async () => catalog },
			traceStore,
		});
		const apiKey = options.live?.apiKey ?? API_KEY;
		const res = await app.request("/api/v1/chat/completions", {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				"Auto-Router-Allow-Model-Override": String(
					c.allowModelOverride ?? true,
				),
			},
			body: JSON.stringify(c.request),
		});
		const traceRes = await app.request(
			`/api/v1/auto-router/traces/${res.headers.get("Auto-Router-Trace-Id")}`,
			{ headers: { authorization: `Bearer ${apiKey}` } },
		);
		const trace = (await traceRes.json()) as RoutingTrace;
		const body =
			res.status === 200
				? undefined
				: ((await res.json()) as { error?: { code?: string } });
		const forwarded = forwardedBodies[0];

		const parsed = chatCompletionsAdapter.parseRequest(c.request);
		const context = chatCompletionsAdapter.extractRoutingContext(parsed);
		const requestedChain =
			chatCompletionsAdapter.getRequestedModelChain(parsed);
		const hard: Requirement[] = [
			...trace.semanticRequirements.flatMap((r) =>
				r.decision === "required"
					? [
							{
								kind: "semantic" as const,
								capability: r.capability as never,
								decision: r.decision,
								requiredProbability: r.requiredProbability,
							},
						]
					: [],
			),
			...detectStructuralRequirements(context.features).requirements,
		];

		const result: RoutingCaseResult = {
			id: c.id,
			tags: c.tags,
			status: res.status,
			reason: trace.reason,
			effectiveChain: trace.effectiveModelChain,
			...(body?.error?.code ? { errorCode: body.error.code } : {}),
			expectationFailures: [],
			violations: [],
			leakage: [],
			toolPreservationFailures: [],
			unnecessaryOverride: false,
			overridden: false,
		};

		if (forwarded) {
			const check = checkForwardedRequest({
				original: c.request,
				forwarded,
				hard,
				catalog,
			});
			result.violations = check.violations;
			result.leakage = check.leakage;
			result.toolPreservationFailures = check.toolPreservationFailures;
			result.overridden = check.chain.some((m) => !requestedChain.includes(m));
			const compatibleRequested = requestedChain.filter(
				(m) => check.unsatisfied(m).length === 0,
			);
			// Hard Requirement が無いのに chain を変えた、または caller chain に compatible な候補があるのに置換した。
			result.unnecessaryOverride =
				(hard.length === 0 && !same(check.chain, requestedChain)) ||
				(compatibleRequested.length > 0 && result.overridden);
		}

		const expected = c.expected;
		if ("error" in expected) {
			if (result.errorCode !== expected.error) {
				result.expectationFailures.push(
					`expected error ${expected.error}, got ${result.errorCode ?? res.status}`,
				);
			}
			if (forwarded)
				result.expectationFailures.push("upstream must not be called");
		} else {
			if (res.status !== 200) {
				result.expectationFailures.push(
					`expected 200, got ${res.status} ${result.errorCode ?? ""}`,
				);
			}
			if (!same(trace.effectiveModelChain, expected.effectiveChain)) {
				result.expectationFailures.push(
					`expected chain ${expected.effectiveChain.join(",")}, got ${trace.effectiveModelChain.join(",")}`,
				);
			}
			if (trace.reason !== expected.reason) {
				result.expectationFailures.push(
					`expected reason ${expected.reason}, got ${trace.reason}`,
				);
			}
		}
		results.push(result);
	}

	const forwardedCount = results.filter((r) => r.status === 200).length;
	const unnecessaryOverrides = results.filter(
		(r) => r.unnecessaryOverride,
	).length;
	return {
		results,
		metrics: {
			cases: results.length,
			expectationPassed: results.filter(
				(r) => r.expectationFailures.length === 0,
			).length,
			hardRequirementViolations: results.reduce(
				(n, r) => n + r.violations.length,
				0,
			),
			incompatibleFallbackLeakage: results.reduce(
				(n, r) => n + r.leakage.length,
				0,
			),
			unnecessaryOverrides,
			unnecessaryOverrideRate:
				forwardedCount === 0 ? 0 : unnecessaryOverrides / forwardedCount,
			callerToolPreservationFailures: results.reduce(
				(n, r) => n + r.toolPreservationFailures.length,
				0,
			),
		},
	};
};
