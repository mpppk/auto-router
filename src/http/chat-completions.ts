import { chatCompletionsAdapter } from "../adapters/chat-completions";
import { RouterError } from "../core/errors";
import type { EffectiveRoutePlan } from "../core/types";
import {
	forwardToOpenRouter,
	getBearerToken,
	toClientResponse,
	type UpstreamConfig,
} from "../upstream/openrouter";
import { parseRouterOptions } from "./router-options";

export interface ChatCompletionsDeps {
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

/**
 * `POST /api/v1/chat/completions` (と `/v1/chat/completions`) の handler。
 * Hono の Context には依存せず、Web Standard の Request / Response で完結させる。
 */
export const handleChatCompletions = async (
	request: Request,
	deps: ChatCompletionsDeps,
): Promise<Response> => {
	if (getBearerToken(request.headers) === undefined) {
		throw new RouterError(
			"missing_authorization",
			"`Authorization: Bearer <OpenRouter API key>` header is required.",
		);
	}
	parseRouterOptions(request.headers);

	const adapter = chatCompletionsAdapter;
	const { raw, json } = await readJson(request);
	const parsed = adapter.parseRequest(json);
	const requestedChain = adapter.getRequestedModelChain(parsed);

	// capability-aware routing は後続Issueで実装する。現時点では caller chain をそのまま使う。
	const plan: EffectiveRoutePlan = { modelChain: requestedChain };

	// 変更が無い場合は caller の raw body をそのまま転送し、再serializeによる差分も生じさせない。
	const body = isUnchanged(plan, requestedChain)
		? raw
		: JSON.stringify(adapter.applyRoutePlan(parsed, plan));

	const upstream = await forwardToOpenRouter(
		deps.upstream,
		"/chat/completions",
		body,
		request.headers,
		request.signal,
	);
	return toClientResponse(upstream);
};
