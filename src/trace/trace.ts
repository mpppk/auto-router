import type { SemanticDecision } from "../core/capabilities";
import type { RouteConflictCode } from "../core/planner";
import type { ProviderPreferences } from "../core/provider";
import { WEB_SEARCH_TOOL_TYPE } from "../core/registry";
import type { RouteReason } from "../core/resolver";
import type { RoutingDecision } from "../routing/decide";
import type { JevFailureReason } from "../semantic/jev-client";

export interface ToolSummary {
	type: string;
	/** function tool の名前。parameter や description は保存しない。 */
	name?: string;
}

/**
 * routing decision の記録。raw Authorization / message 本文は含めない。
 * `detail: "summary"` (通常時) は最小限、`"full"` (Auto-Router-Debug: true / inspect) は詳細を含む。
 */
export interface RoutingTrace {
	id: string;
	createdAt: string;
	detail: "summary" | "full";

	requestedModelChain: string[];
	effectiveModelChain: string[];

	context: {
		conversationMessagesUsed: number;
	};

	semanticStatus: "ok" | "skipped" | "degraded" | "disabled";
	/** `Auto-Router-Capabilities` で判定対象を限定した場合のみ。 */
	semanticScope?: string[];
	semanticRequirements: Array<{
		capability: string;
		requiredProbability: number;
		decision: SemanticDecision;
	}>;

	structuralRequirements: Array<{
		capability: string;
		source?: string;
	}>;

	candidates: Array<{
		model: string;
		origin: "requested" | "default_route";
		accepted: boolean;
		conflicts: RouteConflictCode[];
		/** full のみ。 */
		conflictDetails?: Array<{
			code: RouteConflictCode;
			capability: string;
			message: string;
		}>;
		/** full のみ。capability ごとの support 判定。 */
		support?: Array<{ capability: string; support: string }>;
	}>;

	tools: {
		caller: ToolSummary[];
		injected: ToolSummary[];
		completed: ToolSummary[];
	};

	toolChoice: {
		/** full のみ。 */
		requested?: unknown;
		/** full のみ。 */
		effective?: unknown;
		overridden: boolean;
	};

	provider: {
		requireParametersOverridden: boolean;
		/** full のみ。 */
		effective?: ProviderPreferences;
	};

	/** routing によって caller の OpenRouter 課金が発生・増加しうる操作。 */
	billing: {
		/** caller の key で Jev (semantic detector) を呼んだか。 */
		jev: boolean;
		/** router が注入・補完して有効にした課金対象の server tool 機能。 */
		serverTools: BillableServerTool[];
	};

	reason: RouteReason;
	error?: { code: string; message: string };

	degraded?: {
		reason: JevFailureReason;
	};

	latencyMs: {
		jev?: number;
		routing: number;
		upstream?: number;
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `web_search`: openrouter:web_search の検索料金、`x_search`: xAI X Search の従量課金。 */
export type BillableServerTool = "web_search" | "x_search";

const hasXSearch = (tool: unknown) =>
	isRecord(tool) &&
	isRecord(tool.parameters) &&
	isRecord(tool.parameters.x_search);

/**
 * router が有効にした課金対象の server tool 機能。
 * caller が元から指定していた機能は caller の選択なので含めない。
 */
export const billableServerTools = (input: {
	callerTools: readonly unknown[];
	injectedTools: readonly unknown[];
	completedTools: readonly unknown[];
}): BillableServerTool[] => {
	const result = new Set<BillableServerTool>();
	const isWebSearch = (tool: unknown) =>
		isRecord(tool) && tool.type === WEB_SEARCH_TOOL_TYPE;
	for (const tool of input.injectedTools.filter(isWebSearch)) {
		result.add("web_search");
		if (hasXSearch(tool)) result.add("x_search");
	}
	const callerXSearch = input.callerTools.some(
		(t) => isWebSearch(t) && hasXSearch(t),
	);
	for (const tool of input.completedTools.filter(isWebSearch)) {
		if (hasXSearch(tool) && !callerXSearch) result.add("x_search");
	}
	return [...result];
};

export const summarizeTool = (tool: unknown): ToolSummary => {
	if (!isRecord(tool)) return { type: "unknown" };
	const type = typeof tool.type === "string" ? tool.type : "unknown";
	const fn = isRecord(tool.function) ? tool.function : undefined;
	return typeof fn?.name === "string" ? { type, name: fn.name } : { type };
};

/** `rt_` + 32 hex。 */
export const newTraceId = () => `rt_${crypto.randomUUID().replaceAll("-", "")}`;

export const buildRoutingTrace = (input: {
	id: string;
	decision: RoutingDecision;
	detail: RoutingTrace["detail"];
	now?: Date;
}): RoutingTrace => {
	const { decision, detail } = input;
	const { resolution, semantic, structural } = decision;
	const full = detail === "full";
	const features = decision.features;
	const patch = resolution.patch;
	const requestedToolChoice = features.toolChoice;
	const effectiveToolChoice =
		patch?.toolChoice !== undefined
			? patch.toolChoice.value
			: requestedToolChoice;

	return {
		id: input.id,
		createdAt: (input.now ?? new Date()).toISOString(),
		detail,
		requestedModelChain: resolution.requestedChain,
		effectiveModelChain: resolution.effectiveChain,
		context: { conversationMessagesUsed: semantic.messagesUsed },
		semanticStatus: semantic.status,
		...(decision.semanticScope
			? { semanticScope: decision.semanticScope }
			: {}),
		semanticRequirements: semantic.requirements.map((r) => ({
			capability: r.capability,
			requiredProbability: r.requiredProbability,
			decision: r.decision,
		})),
		structuralRequirements: structural.requirements.map((r) =>
			full
				? { capability: r.capability, source: r.source }
				: { capability: r.capability },
		),
		candidates: resolution.candidates.map((c) => ({
			model: c.model,
			origin: c.origin,
			accepted: c.accepted,
			conflicts: c.plan.conflicts.map((conflict) => conflict.code),
			...(full
				? { conflictDetails: c.plan.conflicts, support: c.plan.support }
				: {}),
		})),
		tools: {
			caller: (features.tools ?? []).map(summarizeTool),
			injected: (patch?.injectedTools ?? []).map(summarizeTool),
			completed: (patch?.completedTools ?? []).map(summarizeTool),
		},
		toolChoice: {
			...(full && requestedToolChoice !== undefined
				? { requested: requestedToolChoice }
				: {}),
			...(full && effectiveToolChoice !== undefined
				? { effective: effectiveToolChoice }
				: {}),
			overridden: patch?.toolChoice !== undefined,
		},
		provider: {
			requireParametersOverridden: patch?.requireParametersOverridden ?? false,
			...(full && resolution.plan?.provider !== undefined
				? { effective: resolution.plan.provider }
				: full && features.provider !== undefined
					? { effective: features.provider }
					: {}),
		},
		billing: {
			jev: semantic.status === "ok" || semantic.status === "degraded",
			// error で upstream に送らない場合は server tool も実行されない。
			serverTools:
				resolution.plan === undefined
					? []
					: billableServerTools({
							callerTools: features.tools ?? [],
							injectedTools: patch?.injectedTools ?? [],
							completedTools: patch?.completedTools ?? [],
						}),
		},
		reason: resolution.reason,
		...(resolution.error
			? {
					error: {
						code: resolution.error.code,
						message: resolution.error.message,
					},
				}
			: {}),
		...(semantic.status === "degraded"
			? { degraded: { reason: semantic.reason } }
			: {}),
		latencyMs: { ...decision.latencyMs },
	};
};
