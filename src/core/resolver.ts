import type { ModelCatalog } from "../catalog/model-catalog";
import {
	hardRequirements,
	type Requirement,
	SEMANTIC_CAPABILITIES,
	type SemanticRequirement,
} from "./capabilities";
import { RouterError } from "./errors";
import type { RequestedModelChain } from "./model-chain";
import {
	buildRequestPatch,
	buildRoutePlan,
	type RequestPatch,
	type RoutePlan,
} from "./planner";
import { SEMANTIC_REGISTRY } from "./registry";
import type { StructuralAnalysis } from "./structural";
import type { EffectiveRoutePlan, RequestFeatures } from "./types";

export type RouteReason =
	/** caller chain をそのまま使用。 */
	| "requested_model"
	/** caller chain から incompatible candidate を除外。 */
	| "filtered_fallback_chain"
	/** caller chain が全滅し capability default route に置換。 */
	| "capability_override"
	/** Hard Requirement を満たす route が無い。 */
	| "capability_not_supported"
	/** Jev 障害で semantic 判定なし。caller chain をそのまま使用。 */
	| "degraded";

export interface CandidateEvaluation {
	model: string;
	/** caller chain 由来か、capability default route 由来か。 */
	origin: "requested" | "default_route";
	accepted: boolean;
	plan: RoutePlan;
}

export interface RouteResolution {
	reason: RouteReason;
	requestedChain: RequestedModelChain;
	effectiveChain: RequestedModelChain;
	hardRequirements: Requirement[];
	candidates: CandidateEvaluation[];
	patch?: RequestPatch;
	/** upstream に適用する plan。error の場合は undefined。 */
	plan?: EffectiveRoutePlan;
	error?: RouterError;
}

export interface ResolveInput {
	requestedChain: RequestedModelChain;
	semanticRequirements: readonly SemanticRequirement[];
	semanticDegraded: boolean;
	structural: StructuralAnalysis;
	features: RequestFeatures;
	catalog: ModelCatalog;
	allowModelOverride: boolean;
}

/** model / models 未指定時の candidate 表示名。 */
export const ACCOUNT_DEFAULT_MODEL = "(account default)";

const sameChain = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((m, i) => m === b[i]);

/** Hard Requirement を持つ semantic capability の default route model (registry 順・重複なし)。 */
const defaultRouteModels = (requirements: readonly Requirement[]) => {
	const required = new Set(
		requirements.flatMap((r) => (r.kind === "semantic" ? [r.capability] : [])),
	);
	const models = SEMANTIC_CAPABILITIES.flatMap((c) => {
		const model = SEMANTIC_REGISTRY[c].defaultRoute?.model;
		return required.has(c) && model !== undefined ? [model] : [];
	});
	return [...new Set(models)];
};

/** caller の設定と両立しない conflict (model を変えても解消しない)。 */
const isCallerConflict = (plan: RoutePlan) =>
	plan.conflicts.some(
		(c) =>
			c.code === "tool_parameter_conflict" || c.code === "provider_conflict",
	);

const summarize = (candidates: readonly CandidateEvaluation[]) =>
	candidates.map((c) => ({
		model: c.model,
		origin: c.origin,
		conflicts: c.plan.conflicts.map((conflict) => ({
			code: conflict.code,
			capability: conflict.capability,
		})),
	}));

/**
 * caller の model chain を第一希望として尊重しつつ、Hard Requirements を満たす candidate だけを残す。
 *
 * The router MUST NOT allow any model/provider fallback path to successfully bypass a Hard Requirement.
 */
export const resolveRoute = (input: ResolveInput): RouteResolution => {
	const { requestedChain, structural, features, catalog } = input;
	const hard = hardRequirements([
		...input.semanticRequirements,
		...structural.requirements,
	]);

	if (hard.length === 0) {
		return {
			reason: input.semanticDegraded ? "degraded" : "requested_model",
			requestedChain,
			effectiveChain: requestedChain,
			hardRequirements: [],
			candidates: [],
			plan: { modelChain: requestedChain },
		};
	}

	const patch = buildRequestPatch(hard, features, structural.requireParameters);
	const evaluate = (
		model: string,
		origin: CandidateEvaluation["origin"],
	): CandidateEvaluation => {
		const plan = buildRoutePlan({
			model,
			profile: catalog.lookup(model),
			requirements: hard,
			features,
			patch,
		});
		return { model, origin, accepted: plan.conflicts.length === 0, plan };
	};

	const toResolution = (
		reason: RouteReason,
		candidates: CandidateEvaluation[],
		effectiveChain: RequestedModelChain,
	): RouteResolution => ({
		reason,
		requestedChain,
		effectiveChain,
		hardRequirements: hard,
		candidates,
		patch,
		plan: {
			modelChain: effectiveChain,
			...(patch.tools !== undefined ? { tools: patch.tools } : {}),
			...(patch.toolChoice !== undefined
				? { toolChoice: patch.toolChoice }
				: {}),
			...(patch.provider !== undefined ? { provider: patch.provider } : {}),
		},
	});

	// model / models 未指定の場合、OpenRouter は account の default model を使う。
	// model 不明として評価し (semantic は unknown で不可、structural は許容)、通れば未指定のまま送る。
	if (requestedChain.length === 0) {
		const accountDefault = evaluate(ACCOUNT_DEFAULT_MODEL, "requested");
		if (accountDefault.accepted) {
			return toResolution("requested_model", [accountDefault], []);
		}
	}

	// 1. caller chain の全 candidate について RoutePlan を作り、compatible なものだけを相対順序を保って残す。
	const requested = requestedChain.map((m) => evaluate(m, "requested"));
	const accepted = requested.filter((c) => c.accepted).map((c) => c.model);
	if (accepted.length > 0) {
		return toResolution(
			sameChain(accepted, requestedChain)
				? "requested_model"
				: "filtered_fallback_chain",
			requested,
			accepted,
		);
	}

	// 2. caller chain が全滅: override が許可されていれば capability default route に置換する。
	//    incompatible な caller model は fallback に残さない。
	const defaults = input.allowModelOverride
		? defaultRouteModels(hard).map((m) => evaluate(m, "default_route"))
		: [];
	const candidates = [...requested, ...defaults];
	const selected = defaults.find((c) => c.accepted);
	if (selected !== undefined) {
		return toResolution("capability_override", candidates, [selected.model]);
	}

	// 3. 単一 route で全 Hard Requirements を満たせない。
	const conflict =
		candidates.length > 0 && candidates.every((c) => isCallerConflict(c.plan));
	const capabilities = [...new Set(hard.map((r) => r.capability))];
	const error = conflict
		? new RouterError(
				"capability_conflict",
				"The request's tool or provider settings conflict with its required capabilities.",
				{
					required_capabilities: capabilities,
					candidates: summarize(candidates),
				},
			)
		: new RouterError(
				"capability_not_supported",
				input.allowModelOverride
					? "No single route can satisfy all required capabilities."
					: "No requested model can satisfy all required capabilities and model override is disabled.",
				{
					required_capabilities: capabilities,
					candidates: summarize(candidates),
				},
			);

	return {
		reason: "capability_not_supported",
		requestedChain,
		effectiveChain: [],
		hardRequirements: hard,
		candidates,
		patch,
		error,
	};
};
