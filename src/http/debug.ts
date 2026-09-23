import { RouterError } from "../core/errors";
import { decideRoute, type RoutingDeps } from "../routing/decide";
import { apiKeyFingerprint } from "../trace/fingerprint";
import { summaryHeaders } from "../trace/headers";
import { logRouterEvent, routingDecisionLog } from "../trace/log";
import { buildRoutingTrace, newTraceId } from "../trace/trace";
import {
	CHAT_COMPLETIONS_ENDPOINT,
	GENERATION_ENDPOINTS,
	type GenerationEndpoint,
	prepareRequest,
	requireApiKey,
	type TraceDeps,
} from "./generation";

/** `?endpoint=` query から inspect 対象の endpoint 形式を選ぶ (既定は chat_completions)。 */
export const inspectEndpoint = (
	name: string | undefined,
): GenerationEndpoint<unknown> => {
	if (name === undefined) return CHAT_COMPLETIONS_ENDPOINT;
	const endpoint = GENERATION_ENDPOINTS.find((e) => e.name === name);
	if (endpoint === undefined) {
		throw new RouterError(
			"invalid_router_request",
			`Query \`endpoint\` must be one of ${GENERATION_ENDPOINTS.map((e) => e.name).join(", ")}.`,
			{ param: "endpoint" },
		);
	}
	return endpoint as GenerationEndpoint<unknown>;
};

/**
 * `POST /api/v1/auto-router/inspect[?endpoint=chat_completions|responses|messages]`
 * 同じ形式の request の routing decision を返す。upstream LLM は呼ばない。
 */
export const handleInspect = async (
	request: Request,
	deps: RoutingDeps,
	endpoint: GenerationEndpoint<unknown> = CHAT_COMPLETIONS_ENDPOINT,
): Promise<Response> => {
	const prepared = await prepareRequest(request, endpoint.adapter);
	const decision = await decideRoute(
		{
			context: prepared.context,
			requestedChain: prepared.requestedChain,
			allowModelOverride: prepared.options.allowModelOverride,
			semantic: prepared.options.semantic,
			capabilityDegrades: prepared.options.capabilityDegrades,
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
	logRouterEvent({
		event: "routing_decision",
		...routingDecisionLog(trace, { endpoint: "inspect" }),
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
					) as Record<string, unknown>;
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
