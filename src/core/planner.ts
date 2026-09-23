import type { ModelProfile } from "../catalog/model-catalog";
import type { Capability, Requirement } from "./capabilities";
import {
	allowsAnyProvider,
	enforceRequireParameters,
	type ProviderPreferences,
} from "./provider";
import {
	SEMANTIC_REGISTRY,
	type ServerToolRequirement,
	STRUCTURAL_REGISTRY,
	type Support,
} from "./registry";
import type { RequestFeatures } from "./types";

export type RouteConflictCode =
	/** candidate model が semantic capability を提供できない。 */
	| "capability_unsupported"
	/** candidate model の semantic capability 対応が不明 (Hard Requirement では候補にしない)。 */
	| "capability_unknown"
	/** candidate model が request の structural requirement を失う。 */
	| "structural_unsupported"
	/** caller の tool parameter の意味を変えないと requirement を満たせない。 */
	| "tool_parameter_conflict"
	/** caller の provider 制約の下では requirement を満たす provider を使えない。 */
	| "provider_conflict";

export interface RouteConflict {
	code: RouteConflictCode;
	capability: string;
	message: string;
}

/** request 全体で1つに決まる tool / tool_choice / provider の patch。 */
export interface RequestPatch {
	/** 変更がある場合のみ設定される effective tools。 */
	tools?: unknown[];
	/** router が追加した server tool。 */
	injectedTools: unknown[];
	/** caller の server tool に補完した parameter。 */
	completedTools: unknown[];
	/** 変更がある場合のみ設定される effective tool_choice。 */
	toolChoice?: { value: unknown };
	/** 変更がある場合のみ設定される effective provider。 */
	provider?: ProviderPreferences;
	requireParametersOverridden: boolean;
	conflicts: RouteConflict[];
}

/** candidate model ごとの effective route。 */
export interface RoutePlan {
	model: string;
	effectiveTools: unknown[] | undefined;
	effectiveToolChoice?: unknown;
	effectiveProvider?: ProviderPreferences;
	/** 評価した Hard Requirements。 */
	requirements: Requirement[];
	support: { capability: string; support: Support }[];
	conflicts: RouteConflict[];
	patch: RequestPatch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toolType = (tool: unknown) =>
	isRecord(tool) && typeof tool.type === "string" ? tool.type : undefined;

const requiredServerTools = (requirements: readonly Requirement[]) => {
	const byType = new Map<
		string,
		{ capability: Capability; tool: ServerToolRequirement }[]
	>();
	for (const r of requirements) {
		if (r.kind !== "semantic") continue;
		const tool = SEMANTIC_REGISTRY[r.capability].serverTool;
		if (tool === undefined) continue;
		byType.set(tool.type, [
			...(byType.get(tool.type) ?? []),
			{ capability: r.capability, tool },
		]);
	}
	return byType;
};

const sameJson = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/**
 * required server tool の利用を現在の tool_choice が妨げているか。
 * `none` と、別の tool (function 等) を強制する指定は妨げる。`auto` / `required` / 未指定は妨げない。
 */
export const blocksServerTools = (
	toolChoice: unknown,
	requiredTypes: ReadonlySet<string>,
): boolean => {
	if (toolChoice === "none") return true;
	if (isRecord(toolChoice) && typeof toolChoice.type === "string") {
		return !requiredTypes.has(toolChoice.type);
	}
	return false;
};

/**
 * Hard Requirements を満たすための request-level patch を作る。
 * model に依存しないため、fallback chain の全 candidate で同じ patch を共有できる。
 *
 * - caller tools は削除・変更せず、required server tool のみ追加する
 * - 同一 server tool が既にあれば duplicate せず、不足 parameter だけ補完する
 * - caller parameter の意味を変えないと満たせない場合は conflict
 * - required tool を妨げる tool_choice だけを `auto` にする
 * - parameter support が必要な structural requirement があれば `require_parameters: true`
 */
export const buildRequestPatch = (
	requirements: readonly Requirement[],
	features: RequestFeatures,
	requireParameters: boolean,
): RequestPatch => {
	const conflicts: RouteConflict[] = [];
	const callerTools = features.tools ?? [];
	const effectiveTools = [...callerTools];
	const injectedTools: unknown[] = [];
	const completedTools: unknown[] = [];

	const required = requiredServerTools(requirements);
	for (const [type, entries] of required) {
		const index = effectiveTools.findIndex((t) => toolType(t) === type);
		const existing = index >= 0 ? effectiveTools[index] : undefined;
		const callerParameters =
			isRecord(existing) && isRecord(existing.parameters)
				? existing.parameters
				: {};

		const merged: Record<string, unknown> = { ...callerParameters };
		for (const { capability, tool } of entries) {
			for (const [key, merge] of Object.entries(tool.parameters)) {
				const result = merge(merged[key]);
				if ("conflict" in result) {
					conflicts.push({
						code: "tool_parameter_conflict",
						capability,
						message: result.conflict,
					});
				} else {
					merged[key] = result.value;
				}
			}
		}

		if (existing === undefined) {
			const tool =
				Object.keys(merged).length > 0
					? { type, parameters: merged }
					: { type };
			effectiveTools.push(tool);
			injectedTools.push(tool);
		} else if (!sameJson(merged, callerParameters)) {
			const tool = {
				...(existing as Record<string, unknown>),
				parameters: merged,
			};
			effectiveTools[index] = tool;
			completedTools.push(tool);
		}
	}

	const toolsChanged = injectedTools.length > 0 || completedTools.length > 0;
	const requiredTypes = new Set(required.keys());
	const toolChoiceBlocked =
		requiredTypes.size > 0 &&
		blocksServerTools(features.toolChoice, requiredTypes);

	const provider = requireParameters
		? enforceRequireParameters(features.provider)
		: undefined;

	return {
		...(toolsChanged ? { tools: effectiveTools } : {}),
		injectedTools,
		completedTools,
		...(toolChoiceBlocked ? { toolChoice: { value: "auto" } } : {}),
		...(provider?.overridden ? { provider: provider.provider } : {}),
		requireParametersOverridden: provider?.overridden ?? false,
		conflicts,
	};
};

/**
 * candidate model について effective route を評価する。
 * model 名だけでなく、tool merge / tool_choice / provider enforcement 後の route で判定する。
 */
export const buildRoutePlan = (input: {
	model: string;
	profile: ModelProfile | undefined;
	requirements: readonly Requirement[];
	features: RequestFeatures;
	patch: RequestPatch;
}): RoutePlan => {
	const { model, profile, requirements, features, patch } = input;
	const conflicts: RouteConflict[] = [...patch.conflicts];
	const support: RoutePlan["support"] = [];
	const effectiveProvider = patch.provider ?? features.provider;

	for (const r of requirements) {
		if (r.kind === "semantic") {
			const definition = SEMANTIC_REGISTRY[r.capability];
			const s = definition.support(model, profile);
			support.push({ capability: r.capability, support: s });
			if (s === "unsupported") {
				conflicts.push({
					code: "capability_unsupported",
					capability: r.capability,
					message: `${model} does not support ${r.capability}`,
				});
			} else if (s === "unknown") {
				conflicts.push({
					code: "capability_unknown",
					capability: r.capability,
					message: `${model} support for ${r.capability} is unknown`,
				});
			}
			if (
				definition.providers !== undefined &&
				!allowsAnyProvider(effectiveProvider, definition.providers)
			) {
				conflicts.push({
					code: "provider_conflict",
					capability: r.capability,
					message: `${r.capability} requires provider ${definition.providers.join(" or ")}, which the provider preferences exclude`,
				});
			}
		} else {
			const s = STRUCTURAL_REGISTRY[r.capability].support(model, profile);
			support.push({ capability: r.capability, support: s });
			// structural の unknown は許容し、provider.require_parameters で担保する。
			if (s === "unsupported") {
				conflicts.push({
					code: "structural_unsupported",
					capability: r.capability,
					message: `${model} does not support ${r.capability} (${r.source})`,
				});
			}
		}
	}

	const toolChoice =
		patch.toolChoice !== undefined
			? patch.toolChoice.value
			: features.toolChoice;
	return {
		model,
		effectiveTools: patch.tools ?? features.tools,
		...(toolChoice !== undefined ? { effectiveToolChoice: toolChoice } : {}),
		...(effectiveProvider !== undefined ? { effectiveProvider } : {}),
		requirements: [...requirements],
		support,
		conflicts,
		patch,
	};
};
