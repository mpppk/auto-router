import type { RoutingTrace } from "./trace";

export const TRACE_ID_HEADER = "Auto-Router-Trace-Id";

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
});
