import { chatCompletionsAdapter } from "../adapters/chat-completions";
import { RouterError } from "../core/errors";
import type { EffectiveRoutePlan } from "../core/types";
import { decideRoute, type RoutingDeps } from "../routing/decide";
import {
	forwardToOpenRouter,
	getBearerToken,
	toClientResponse,
	type UpstreamConfig,
} from "../upstream/openrouter";
import { parseRouterOptions } from "./router-options";

export interface ChatCompletionsDeps extends RoutingDeps {
	upstream: UpstreamConfig;
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

/** Chat Completions 互換 request を parse し、routing 判断に必要な情報を揃える。 */
export const prepareChatCompletions = async (request: Request) => {
	const apiKey = getBearerToken(request.headers);
	if (apiKey === undefined) {
		throw new RouterError(
			"missing_authorization",
			"`Authorization: Bearer <OpenRouter API key>` header is required.",
		);
	}
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
	const { resolution } = decision;
	if (resolution.error !== undefined || resolution.plan === undefined) {
		throw (
			resolution.error ??
			new RouterError("capability_not_supported", "No route available.")
		);
	}

	// 変更が無い場合は caller の raw body をそのまま転送し、再serializeによる差分も生じさせない。
	const body = isUnchanged(resolution.plan, requestedChain)
		? prepared.raw
		: JSON.stringify(adapter.applyRoutePlan(parsed, resolution.plan));

	const upstream = await forwardToOpenRouter(
		deps.upstream,
		"/chat/completions",
		body,
		request.headers,
		request.signal,
	);
	return toClientResponse(upstream);
};
