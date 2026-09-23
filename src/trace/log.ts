import type { RoutingTrace } from "./trace";

/**
 * 構造化ログ (1 request 1 行の JSON)。Workers Observability が JSON の field を index するため、
 * `$metadata` ではなく field 単位で集計・filter できる (#29)。
 * message 本文・raw API key・key fingerprint・trace id 以外の識別子は出力しない。
 */
export type RouterLogEvent =
	| ({ event: "routing_decision" } & RoutingDecisionLog)
	| { event: "rate_limited"; scope: "ip" | "key" }
	| { event: "invalid_api_key"; source: "jev" | "upstream" };

export interface RoutingDecisionLog {
	endpoint: "chat_completions" | "inspect";
	traceId: string;
	reason: RoutingTrace["reason"];
	/** requested chain に無い model に置き換えたか。 */
	overridden: boolean;
	semanticStatus: RoutingTrace["semanticStatus"];
	degradedReason?: string;
	semanticCache?: "hit" | "miss";
	requiredCapabilities: string[];
	structuralCapabilities: string[];
	capabilityDegrades: string[];
	requestedModel?: string;
	requestedChainLength: number;
	effectiveModel?: string;
	effectiveChainLength: number;
	candidates: number;
	rejectedCandidates: number;
	agentLoopTurns: number;
	injectedServerTools: string[];
	jevCalled: boolean;
	errorCode?: string;
	upstreamStatus?: number;
	latencyMs: { jev?: number; routing: number; upstream?: number };
}

export const logRouterEvent = (event: RouterLogEvent) => {
	console.log(JSON.stringify({ source: "auto-router", ...event }));
};

export const routingDecisionLog = (
	trace: RoutingTrace,
	input: {
		endpoint: RoutingDecisionLog["endpoint"];
		upstreamStatus?: number;
	},
): RoutingDecisionLog => ({
	endpoint: input.endpoint,
	traceId: trace.id,
	reason: trace.reason,
	overridden: trace.effectiveModelChain.some(
		(m) => !trace.requestedModelChain.includes(m),
	),
	semanticStatus: trace.semanticStatus,
	...(trace.degraded ? { degradedReason: trace.degraded.reason } : {}),
	...(trace.semanticCache ? { semanticCache: trace.semanticCache } : {}),
	requiredCapabilities: trace.semanticRequirements
		.filter((r) => r.decision === "required")
		.map((r) => r.capability),
	structuralCapabilities: trace.structuralRequirements.map((r) => r.capability),
	capabilityDegrades: trace.capabilityDegrades.map((d) => `${d.from}=${d.to}`),
	...(trace.requestedModelChain[0] !== undefined
		? { requestedModel: trace.requestedModelChain[0] }
		: {}),
	requestedChainLength: trace.requestedModelChain.length,
	...(trace.effectiveModelChain[0] !== undefined
		? { effectiveModel: trace.effectiveModelChain[0] }
		: {}),
	effectiveChainLength: trace.effectiveModelChain.length,
	candidates: trace.candidates.length,
	rejectedCandidates: trace.candidates.filter((c) => !c.accepted).length,
	agentLoopTurns: trace.context.agentLoopTurns,
	injectedServerTools: trace.billing.serverTools,
	jevCalled: trace.billing.jev,
	...(trace.error ? { errorCode: trace.error.code } : {}),
	...(input.upstreamStatus !== undefined
		? { upstreamStatus: input.upstreamStatus }
		: {}),
	latencyMs: { ...trace.latencyMs },
});
