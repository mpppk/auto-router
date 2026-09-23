import { chatCompletionsAdapter } from "../adapters/chat-completions";
import type { EndpointAdapter } from "../adapters/endpoint-adapter";
import { messagesAdapter } from "../adapters/messages";
import { responsesAdapter } from "../adapters/responses";
import { RouterError } from "../core/errors";
import type { EffectiveRoutePlan } from "../core/types";
import { decideRoute, type RoutingDeps } from "../routing/decide";
import { apiKeyFingerprint } from "../trace/fingerprint";
import { summaryHeaders, TRACE_ID_HEADER } from "../trace/headers";
import { logRouterEvent, routingDecisionLog } from "../trace/log";
import type { TraceStore } from "../trace/store";
import {
	buildRoutingTrace,
	newTraceId,
	type RoutingTrace,
} from "../trace/trace";
import {
	forwardToOpenRouter,
	getApiKey,
	toClientResponse,
	type UpstreamConfig,
} from "../upstream/openrouter";
import { parseRouterOptions } from "./router-options";

/** request ごとに決まる trace 永続化の依存。 */
export interface TraceDeps {
	store: TraceStore;
	fingerprintSecret?: string;
	/** response 返却後に trace を書き込むための waitUntil。無ければ await する。 */
	waitUntil?: (promise: Promise<unknown>) => void;
}

export interface GenerationDeps extends RoutingDeps {
	upstream: UpstreamConfig;
	trace: TraceDeps;
}

/** capability-aware routing を行う generation endpoint。 */
export interface GenerationEndpoint<TRequest> {
	name: "chat_completions" | "responses" | "messages";
	/** OpenRouter 側の path (`/chat/completions` 等)。 */
	upstreamPath: string;
	adapter: EndpointAdapter<TRequest>;
}

export const CHAT_COMPLETIONS_ENDPOINT = {
	name: "chat_completions",
	upstreamPath: "/chat/completions",
	adapter: chatCompletionsAdapter,
} as const satisfies GenerationEndpoint<unknown>;

/** OpenAI Responses API 互換 (#30)。 */
export const RESPONSES_ENDPOINT = {
	name: "responses",
	upstreamPath: "/responses",
	adapter: responsesAdapter,
} as const satisfies GenerationEndpoint<unknown>;

/** Anthropic Messages API 互換 (#30)。 */
export const MESSAGES_ENDPOINT = {
	name: "messages",
	upstreamPath: "/messages",
	adapter: messagesAdapter,
} as const satisfies GenerationEndpoint<unknown>;

export const GENERATION_ENDPOINTS = [
	CHAT_COMPLETIONS_ENDPOINT,
	RESPONSES_ENDPOINT,
	MESSAGES_ENDPOINT,
] as const;

const readJson = async (
	request: Request,
): Promise<{ raw: string; json: unknown }> => {
	const raw = await request.text();
	try {
		return { raw, json: JSON.parse(raw) };
	} catch {
		throw new RouterError(
			"invalid_router_request",
			"Request body must be valid JSON.",
			{ param: "body" },
		);
	}
};

const isUnchanged = (plan: EffectiveRoutePlan, requested: readonly string[]) =>
	plan.tools === undefined &&
	plan.toolChoice === undefined &&
	plan.provider === undefined &&
	plan.modelChain.length === requested.length &&
	plan.modelChain.every((m, i) => m === requested[i]);

export const requireApiKey = (headers: Headers): string => {
	const apiKey = getApiKey(headers);
	if (apiKey === undefined) {
		throw new RouterError(
			"missing_authorization",
			"`Authorization: Bearer <OpenRouter API key>` (or `x-api-key`) header is required.",
		);
	}
	return apiKey;
};

/** endpoint 固有形式の request を parse し、routing 判断に必要な情報を揃える。 */
export const prepareRequest = async <TRequest>(
	request: Request,
	adapter: EndpointAdapter<TRequest>,
) => {
	const apiKey = requireApiKey(request.headers);
	const options = parseRouterOptions(request.headers);
	const { raw, json } = await readJson(request);
	const parsed = adapter.parseRequest(json);
	return {
		apiKey,
		options,
		adapter,
		raw,
		parsed,
		context: adapter.extractRoutingContext(parsed),
		requestedChain: adapter.getRequestedModelChain(parsed),
	};
};

const persistTrace = (deps: TraceDeps, trace: RoutingTrace, apiKey: string) => {
	const write = apiKeyFingerprint(apiKey, deps.fingerprintSecret)
		.then((owner) => deps.store.put(trace, owner))
		.catch((err: unknown) => {
			// trace の保存失敗で request を失敗させない。
			console.warn(
				"failed to persist routing trace",
				err instanceof Error ? err.message : err,
			);
		});
	if (deps.waitUntil) {
		deps.waitUntil(write);
		return Promise.resolve();
	}
	return write;
};

/**
 * `POST /api/v1/chat/completions` / `/responses` / `/messages` (と `/v1/*`) の handler。
 * endpoint 固有形式は adapter が吸収し、routing core は共通。
 * Hono の Context には依存せず、Web Standard の Request / Response で完結させる。
 */
export const handleGeneration = async <TRequest>(
	request: Request,
	deps: GenerationDeps,
	endpoint: GenerationEndpoint<TRequest>,
): Promise<Response> => {
	const prepared = await prepareRequest(request, endpoint.adapter);
	const { adapter, parsed, requestedChain } = prepared;

	const decision = await decideRoute(
		{
			context: prepared.context,
			requestedChain,
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
		detail: prepared.options.debug ? "full" : "summary",
	});

	const { resolution } = decision;
	if (resolution.error !== undefined || resolution.plan === undefined) {
		logRouterEvent({
			event: "routing_decision",
			...routingDecisionLog(trace, { endpoint: endpoint.name }),
		});
		await persistTrace(deps.trace, trace, prepared.apiKey);
		const error =
			resolution.error ??
			new RouterError("capability_not_supported", "No route available.");
		return error.toResponse(summaryHeaders(trace));
	}

	// 変更が無い場合は caller の raw body をそのまま転送し、再serializeによる差分も生じさせない。
	const body = isUnchanged(resolution.plan, requestedChain)
		? prepared.raw
		: JSON.stringify(adapter.applyRoutePlan(parsed, resolution.plan));

	const started = Date.now();
	const upstream = await forwardToOpenRouter(
		deps.upstream,
		endpoint.upstreamPath,
		body,
		request.headers,
		request.signal,
	);
	trace.latencyMs.upstream = Date.now() - started;
	logRouterEvent({
		event: "routing_decision",
		...routingDecisionLog(trace, {
			endpoint: endpoint.name,
			upstreamStatus: upstream.status,
		}),
	});

	// 不正な API key の request は trace を保存しない (D1 書き込みの abuse 抑止)。
	if (upstream.status === 401) {
		logRouterEvent({ event: "invalid_api_key", source: "upstream" });
		const { [TRACE_ID_HEADER]: _, ...headers } = summaryHeaders(trace);
		return toClientResponse(upstream, headers);
	}
	await persistTrace(deps.trace, trace, prepared.apiKey);

	return toClientResponse(upstream, summaryHeaders(trace));
};
