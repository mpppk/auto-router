import type { RoutingTrace } from "./trace";

export const TRACE_ID_HEADER = "Auto-Router-Trace-Id";
export const DEGRADED_CAPABILITIES_HEADER = "Auto-Router-Degraded-Capabilities";

/**
 * 通常 response に付与する routing summary header。body / SSE は変更しない。
 * model chain は `,` 区切り (先頭が primary)。
 */
export const summaryHeaders = (
	trace: RoutingTrace,
): Record<string, string> => ({
	[TRACE_ID_HEADER]: trace.id,
	...(trace.requestedModelChain.length > 0
		? { "Auto-Router-Requested-Model": trace.requestedModelChain.join(",") }
		: {}),
	...(trace.effectiveModelChain.length > 0
		? { "Auto-Router-Selected-Model": trace.effectiveModelChain.join(",") }
		: {}),
	"Auto-Router-Route-Reason": trace.reason,
	"Auto-Router-Degraded": String(trace.degraded !== undefined),
	// caller が許可した capability degrade を適用した場合 (`from=to`、`,` 区切り)。silent にしない。
	...(trace.capabilityDegrades.length > 0
		? {
				[DEGRADED_CAPABILITIES_HEADER]: trace.capabilityDegrades
					.map((d) => `${d.from}=${d.to}`)
					.join(","),
			}
		: {}),
});
