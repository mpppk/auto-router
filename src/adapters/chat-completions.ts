import { RouterError } from "../core/errors";
import {
	normalizeModelChain,
	type RequestedModelChain,
} from "../core/model-chain";
import type { ProviderPreferences } from "../core/provider";
import type { ContentPartRef, ConversationMessage } from "../core/types";
import type { EndpointAdapter } from "./endpoint-adapter";

/**
 * OpenAI Chat Completions 互換 + OpenRouter 拡張のrequest。
 * 未知のfieldを落とさないよう、既知fieldだけを型付けし残りは index signature で保持する。
 */
export type ChatCompletionsRequest = Record<string, unknown> & {
	model?: string;
	models?: string[];
	messages: unknown[];
	tools?: unknown[];
	provider?: ProviderPreferences;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string, param: string) =>
	new RouterError("invalid_router_request", message, { param });

/** message content (string または content part 配列) から自然言語テキストだけを取り出す。 */
export const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			isRecord(part) && part.type === "text" && typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
};

const sameChain = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((model, i) => model === b[i]);

export const chatCompletionsAdapter: EndpointAdapter<ChatCompletionsRequest> = {
	parseRequest(body) {
		if (!isRecord(body)) {
			throw invalid("Request body must be a JSON object.", "body");
		}
		const { model, models, messages } = body;
		if (model !== undefined && typeof model !== "string") {
			throw invalid("`model` must be a string.", "model");
		}
		if (
			models !== undefined &&
			!(
				Array.isArray(models) &&
				models.every((m): m is string => typeof m === "string")
			)
		) {
			throw invalid("`models` must be an array of strings.", "models");
		}
		if (!Array.isArray(messages)) {
			throw invalid("`messages` must be an array.", "messages");
		}
		if (body.tools !== undefined && !Array.isArray(body.tools)) {
			throw invalid("`tools` must be an array.", "tools");
		}
		if (body.provider !== undefined && !isRecord(body.provider)) {
			throw invalid("`provider` must be an object.", "provider");
		}
		return body as ChatCompletionsRequest;
	},

	extractRoutingContext(request) {
		const conversation: ConversationMessage[] = [];
		const instructions: string[] = [];
		const contentParts: ContentPartRef[] = [];
		for (const [i, message] of request.messages.entries()) {
			if (!isRecord(message)) continue;
			if (Array.isArray(message.content)) {
				for (const [j, part] of message.content.entries()) {
					if (
						isRecord(part) &&
						typeof part.type === "string" &&
						part.type !== "text"
					) {
						contentParts.push({
							type: part.type,
							path: `messages[${i}].content[${j}]`,
						});
					}
				}
			}
			const text = extractText(message.content).trim();
			if (text === "") continue;
			switch (message.role) {
				case "user":
				case "assistant":
					conversation.push({ role: message.role, text });
					break;
				case "system":
				case "developer":
					instructions.push(text);
					break;
				// tool / function 等の結果は semantic routing context に含めない。
			}
		}
		return {
			conversation,
			instructions,
			features: {
				contentParts,
				tools: request.tools,
				toolChoice: request.tool_choice,
				responseFormat: request.response_format,
				reasoning: request.reasoning,
				reasoningEffort: request.reasoning_effort,
				includeReasoning: request.include_reasoning,
				provider: request.provider,
			},
		};
	},

	getRequestedModelChain(request): RequestedModelChain {
		return normalizeModelChain(request.model, request.models);
	},

	applyRoutePlan(request, plan) {
		const patched: ChatCompletionsRequest = { ...request };

		if (!sameChain(plan.modelChain, this.getRequestedModelChain(request))) {
			const [primary, ...fallbacks] = plan.modelChain;
			if (primary === undefined) {
				delete patched.model;
			} else {
				patched.model = primary;
			}
			if (fallbacks.length > 0) {
				patched.models = fallbacks;
			} else {
				delete patched.models;
			}
		}
		if (plan.tools !== undefined) patched.tools = plan.tools;
		if (plan.toolChoice !== undefined) {
			patched.tool_choice = plan.toolChoice.value;
		}
		if (plan.provider !== undefined) patched.provider = plan.provider;

		return patched;
	},
};
