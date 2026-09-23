import { RouterError } from "../core/errors";
import { decideRoute, type RoutingDeps } from "../routing/decide";
import { apiKeyFingerprint } from "../trace/fingerprint";
import { summaryHeaders } from "../trace/headers";
import { buildRoutingTrace, newTraceId } from "../trace/trace";
import {
	prepareChatCompletions,
	requireApiKey,
	type TraceDeps,
} from "./chat-completions";

/**
 * `POST /api/v1/auto-router/inspect`
 * Chat Completions 互換 request の routing decision を返す。upstream LLM は呼ばない。
 */
export const handleInspect = async (
	request: Request,
	deps: RoutingDeps,
): Promise<Response> => {
	const prepared = await prepareChatCompletions(request);
	const decision = await decideRoute(
		{
			context: prepared.context,
			requestedChain: prepared.requestedChain,
			allowModelOverride: prepared.options.allowModelOverride,
			apiKey: prepared.apiKey,
			signal: request.signal,
		},
		deps,
	);
	const trace = buildRoutingTrace({
		id: newTraceId(),
		decision,
		detail: "full",
	});
	const { resolution } = decision;

	// message 本文は返さず、routing で変わりうる field だけを示す。
	const effectiveRequest =
		resolution.plan === undefined
			? undefined
			: (() => {
					const patched = prepared.adapter.applyRoutePlan(
						prepared.parsed,
						resolution.plan,
					);
					return {
						model: patched.model,
						models: patched.models,
						tools: patched.tools,
						tool_choice: patched.tool_choice,
						provider: patched.provider,
					};
				})();

	return Response.json(
		{
			trace,
			...(effectiveRequest ? { effective_request: effectiveRequest } : {}),
			...(resolution.error ? resolution.error.toBody() : {}),
		},
		{ headers: summaryHeaders(trace) },
	);
};

/** `GET /api/v1/auto-router/traces/:traceId` — caller 自身の trace だけを返す。 */
export const handleGetTrace = async (
	request: Request,
	traceId: string,
	deps: TraceDeps,
): Promise<Response> => {
	const apiKey = requireApiKey(request.headers);
	const owner = await apiKeyFingerprint(apiKey, deps.fingerprintSecret);
	const trace = await deps.store.get(traceId, owner);
	if (trace === undefined) {
		throw new RouterError("trace_not_found", `Trace ${traceId} was not found.`);
	}
	return Response.json(trace);
};
