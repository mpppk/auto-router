import type { SemanticDecision } from "../core/capabilities";
import type { RouteConflictCode } from "../core/planner";
import type { ProviderPreferences } from "../core/provider";
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

	semanticStatus: "ok" | "skipped" | "degraded";
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
