import type { RequestedModelChain } from "./model-chain";
import type { ProviderPreferences } from "./provider";

/** semantic routing に利用する自然言語message。 */
export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
}

/** message 内の非テキスト content part。 */
export interface ContentPartRef {
	type: string;
	/** 例: `messages[2].content[1]` */
	path: string;
}

/**
 * structural requirement 判定に使う request の特徴。
 * endpoint 固有の field 名は adapter 側で吸収する。
 */
export interface RequestFeatures {
	contentParts: ContentPartRef[];
	tools?: unknown[];
	toolChoice?: unknown;
	responseFormat?: unknown;
	reasoning?: unknown;
	reasoningEffort?: unknown;
	includeReasoning?: unknown;
	provider?: ProviderPreferences;
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
	/**
	 * 最新の user message より後にある assistant の tool call 数。
	 * 0 なら新しい user turn、1 以上なら同じ user message に対する agent loop の途中。
	 */
	agentLoopTurns: number;
	features: RequestFeatures;
}

/**
 * routing core が決定した、upstream へ送る effective route。
 * 各fieldが undefined の場合は caller の値をそのまま維持する。
 */
export interface EffectiveRoutePlan {
	modelChain: RequestedModelChain;
	tools?: unknown[];
	toolChoice?: { value: unknown };
	provider?: ProviderPreferences;
}
