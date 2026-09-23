import { RouterError } from "../core/errors";
import {
	normalizeModelChain,
	type RequestedModelChain,
} from "../core/model-chain";
import type { ProviderPreferences } from "../core/provider";
import type { ContentPartRef, ConversationMessage } from "../core/types";
import { applyCommonRoutePlan } from "./common";
import type { EndpointAdapter } from "./endpoint-adapter";

/**
 * Anthropic Messages API 互換 + OpenRouter 拡張 (`models` / `provider`) の request。
 * 未知のfieldを落とさないよう、既知fieldだけを型付けし残りは index signature で保持する。
 */
export type MessagesRequest = Record<string, unknown> & {
	model?: string;
	models?: string[];
	messages: unknown[];
	system?: string | unknown[];
	tools?: unknown[];
	provider?: ProviderPreferences;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string, param: string) =>
	new RouterError("invalid_router_request", message, { param });

/** content (string または content block 配列) から text block だけを取り出す。 */
const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
};

const hasBlock = (content: unknown, type: string) =>
	Array.isArray(content) &&
	content.some((block) => isRecord(block) && block.type === type);

/**
 * Anthropic の tool_choice を planner が解釈する Chat Completions の意味に揃える。
 * `{type: "auto"}` → `"auto"`、`{type: "any"}` → `"required"`、`{type: "none"}` → `"none"`、
 * `{type: "tool", name}` → 特定 function の強制。
 */
export const normalizeMessagesToolChoice = (toolChoice: unknown): unknown => {
	if (!isRecord(toolChoice)) return toolChoice;
	switch (toolChoice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return { type: "function", function: { name: toolChoice.name } };
		default:
			return toolChoice;
	}
};

/** planner の tool_choice ("auto") を Anthropic 形式に戻す。caller の他の field は保持する。 */
const toMessagesToolChoice = (value: unknown, original: unknown): unknown => {
	if (value !== "auto") return value;
	const { name: _, ...rest } = isRecord(original) ? original : {};
	return { ...rest, type: "auto" };
};

/** Anthropic の thinking 設定を reasoning requirement 判定用の形にする。 */
const toReasoning = (thinking: unknown) =>
	isRecord(thinking) ? { enabled: thinking.type !== "disabled" } : undefined;

export const messagesAdapter: EndpointAdapter<MessagesRequest> = {
	parseRequest(body) {
		if (!isRecord(body)) {
			throw invalid("Request body must be a JSON object.", "body");
		}
		const { model, models, messages, system } = body;
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
		if (
			system !== undefined &&
			typeof system !== "string" &&
			!Array.isArray(system)
		) {
			throw invalid("`system` must be a string or an array.", "system");
		}
		if (body.tools !== undefined && !Array.isArray(body.tools)) {
			throw invalid("`tools` must be an array.", "tools");
		}
		if (body.provider !== undefined && !isRecord(body.provider)) {
			throw invalid("`provider` must be an object.", "provider");
		}
		return body as MessagesRequest;
	},

	extractRoutingContext(request) {
		const conversation: ConversationMessage[] = [];
		const system = extractText(request.system).trim();
		const instructions = system === "" ? [] : [system];
		const contentParts: ContentPartRef[] = [];
		let agentLoopTurns = 0;

		for (const [i, message] of request.messages.entries()) {
			if (!isRecord(message)) continue;
			if (Array.isArray(message.content)) {
				for (const [j, block] of message.content.entries()) {
					if (
						isRecord(block) &&
						typeof block.type === "string" &&
						block.type !== "text"
					) {
						contentParts.push({
							type: block.type,
							path: `messages[${i}].content[${j}]`,
						});
					}
				}
			}
			const text = extractText(message.content).trim();
			if (message.role === "user") {
				// tool_result だけの user message は agent loop の途中 (新しい user turn ではない)。
				if (text !== "") agentLoopTurns = 0;
			} else if (
				message.role === "assistant" &&
				hasBlock(message.content, "tool_use")
			) {
				agentLoopTurns++;
			}
			if (text === "") continue;
			if (message.role === "user" || message.role === "assistant") {
				conversation.push({ role: message.role, text });
			}
		}

		const outputConfig = isRecord(request.output_config)
			? request.output_config
			: undefined;
		return {
			conversation,
			instructions,
			agentLoopTurns,
			features: {
				contentParts,
				tools: request.tools,
				toolChoice: normalizeMessagesToolChoice(request.tool_choice),
				responseFormat: outputConfig?.format ?? request.output_format,
				reasoning: toReasoning(request.thinking),
				provider: request.provider,
			},
		};
	},

	getRequestedModelChain(request): RequestedModelChain {
		return normalizeModelChain(request.model, request.models);
	},

	applyRoutePlan(request, plan) {
		return applyCommonRoutePlan(
			request,
			plan,
			this.getRequestedModelChain(request),
			toMessagesToolChoice,
		);
	},
};
