import { chatCompletionsAdapter } from "../adapters/chat-completions";
import { RouterError } from "../core/errors";
import type { EffectiveRoutePlan } from "../core/types";
import { decideRoute, type RoutingDeps } from "../routing/decide";
import { apiKeyFingerprint } from "../trace/fingerprint";
import { summaryHeaders } from "../trace/headers";
import type { TraceStore } from "../trace/store";
import {
	buildRoutingTrace,
	newTraceId,
	type RoutingTrace,
} from "../trace/trace";
import {
	forwardToOpenRouter,
	getBearerToken,
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

export interface ChatCompletionsDeps extends RoutingDeps {
	upstream: UpstreamConfig;
	trace: TraceDeps;
}

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
	const apiKey = getBearerToken(headers);
	if (apiKey === undefined) {
		throw new RouterError(
			"missing_authorization",
			"`Authorization: Bearer <OpenRouter API key>` header is required.",
		);
	}
	return apiKey;
};

/** Chat Completions 互換 request を parse し、routing 判断に必要な情報を揃える。 */
export const prepareChatCompletions = async (request: Request) => {
	const apiKey = requireApiKey(request.headers);
	const options = parseRouterOptions(request.headers);
	const adapter = chatCompletionsAdapter;
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
 * `POST /api/v1/chat/completions` (と `/v1/chat/completions`) の handler。
 * Hono の Context には依存せず、Web Standard の Request / Response で完結させる。
 */
export const handleChatCompletions = async (
	request: Request,
	deps: ChatCompletionsDeps,
): Promise<Response> => {
	const prepared = await prepareChatCompletions(request);
	const { adapter, parsed, requestedChain } = prepared;

	const decision = await decideRoute(
		{
			context: prepared.context,
			requestedChain,
			allowModelOverride: prepared.options.allowModelOverride,
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
		"/chat/completions",
		body,
		request.headers,
		request.signal,
	);
	trace.latencyMs.upstream = Date.now() - started;
	await persistTrace(deps.trace, trace, prepared.apiKey);

	return toClientResponse(upstream, summaryHeaders(trace));
};
