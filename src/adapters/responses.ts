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
 * OpenAI Responses API 互換 + OpenRouter 拡張 (`models` / `provider`) の request。
 * 未知のfieldを落とさないよう、既知fieldだけを型付けし残りは index signature で保持する。
 */
export type ResponsesRequest = Record<string, unknown> & {
	model?: string;
	models?: string[];
	input: string | unknown[];
	instructions?: string;
	tools?: unknown[];
	provider?: ProviderPreferences;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string, param: string) =>
	new RouterError("invalid_router_request", message, { param });

/** 自然言語テキストとして扱う content part。 */
const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			isRecord(part) &&
			typeof part.type === "string" &&
			TEXT_PART_TYPES.has(part.type) &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
};

export const responsesAdapter: EndpointAdapter<ResponsesRequest> = {
	parseRequest(body) {
		if (!isRecord(body)) {
			throw invalid("Request body must be a JSON object.", "body");
		}
		const { model, models, input, instructions } = body;
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
		if (typeof input !== "string" && !Array.isArray(input)) {
			throw invalid("`input` must be a string or an array.", "input");
		}
		if (instructions !== undefined && instructions !== null) {
			if (typeof instructions !== "string") {
				throw invalid("`instructions` must be a string.", "instructions");
			}
		}
		if (body.tools !== undefined && !Array.isArray(body.tools)) {
			throw invalid("`tools` must be an array.", "tools");
		}
		if (body.provider !== undefined && !isRecord(body.provider)) {
			throw invalid("`provider` must be an object.", "provider");
		}
		return body as ResponsesRequest;
	},

	extractRoutingContext(request) {
		const conversation: ConversationMessage[] = [];
		const instructions: string[] =
			typeof request.instructions === "string" &&
			request.instructions.trim() !== ""
				? [request.instructions.trim()]
				: [];
		const contentParts: ContentPartRef[] = [];
		let agentLoopTurns = 0;
		let previousWasCall = false;

		const items =
			typeof request.input === "string"
				? [{ role: "user", content: request.input }]
				: request.input;
		for (const [i, item] of items.entries()) {
			if (!isRecord(item)) continue;
			const type = typeof item.type === "string" ? item.type : "message";
			// 並列 function call (連続する function_call item) は1ターンとして数える。
			const isCall = type === "function_call";
			if (isCall && !previousWasCall) agentLoopTurns++;
			previousWasCall = isCall;
			// function_call_output / reasoning 等は semantic routing context に含めない。
			if (type !== "message") continue;

			if (Array.isArray(item.content)) {
				for (const [j, part] of item.content.entries()) {
					if (
						isRecord(part) &&
						typeof part.type === "string" &&
						!TEXT_PART_TYPES.has(part.type)
					) {
						contentParts.push({
							type: part.type,
							path:
								typeof request.input === "string"
									? "input"
									: `input[${i}].content[${j}]`,
						});
					}
				}
			}
			const text = extractText(item.content).trim();
			if (item.role === "user" && text !== "") agentLoopTurns = 0;
			if (text === "") continue;
			switch (item.role) {
				case "user":
				case "assistant":
					conversation.push({ role: item.role, text });
					break;
				case "system":
				case "developer":
					instructions.push(text);
					break;
			}
		}

		const text = isRecord(request.text) ? request.text : undefined;
		return {
			conversation,
			instructions,
			agentLoopTurns,
			features: {
				contentParts,
				tools: request.tools,
				// Responses の tool_choice ("none" / "auto" / "required" / {type, name}) は
				// Chat Completions と同じ意味で planner が解釈できる。
				toolChoice: request.tool_choice,
				responseFormat: text?.format,
				reasoning: request.reasoning,
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
			(value) => value,
		);
	},
};
