import type { RequestedModelChain } from "./model-chain";

/** semantic routing に利用する自然言語message。 */
export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
}

/**
 * endpoint 固有形式から抽出した、routing core 向けの入力。
 * core はこの型だけを見て判断し、Chat Completions 等の具体的なrequest形式には依存しない。
 */
export interface RoutingContext {
	/** user / assistant の自然言語message (古い順)。tool result 等は含まない。 */
	conversation: ConversationMessage[];
	/** system / developer 相当の指示 (古い順)。conversation とは別枠で扱う。 */
	instructions: string[];
}

/**
 * routing core が決定した、upstream へ送る effective route。
 * 各fieldが undefined の場合は caller の値をそのまま維持する。
 */
export interface EffectiveRoutePlan {
	modelChain: RequestedModelChain;
	tools?: unknown[];
	toolChoice?: { value: unknown };
	provider?: Record<string, unknown>;
}
