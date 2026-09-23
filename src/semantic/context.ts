import type { ConversationMessage, RoutingContext } from "../core/types";

/** semantic detector に渡す直近の user / assistant message 数。 */
export const ROUTING_CONTEXT_MESSAGES = 12;

/** 1 message あたりの最大文字数。超えた分は先頭と末尾を残して省略する。 */
export const MAX_MESSAGE_CHARS = 3000;

/** system / developer 指示の最大文字数 (合計)。 */
export const MAX_INSTRUCTION_CHARS = 3000;

const truncateMiddle = (text: string, max: number): string => {
	if (text.length <= max) return text;
	const half = Math.floor((max - 20) / 2);
	return `${text.slice(0, half)}\n…(truncated)…\n${text.slice(-half)}`;
};

export interface SemanticContext {
	/** 直近の user / assistant message (古い順)。 */
	conversation: ConversationMessage[];
	/** system / developer 指示。直近 message 数とは別枠。 */
	instructions: string[];
	/** 最新の user message。無ければ semantic detection は行わない。 */
	latestUserMessage?: string;
}

/**
 * routing context から semantic detection 用の context を作る。
 * tool result 等は adapter の時点で除外済み。巨大な message は中間を省略する。
 */
export const buildSemanticContext = (
	context: Pick<RoutingContext, "conversation" | "instructions">,
	limit = ROUTING_CONTEXT_MESSAGES,
): SemanticContext => {
	const conversation = context.conversation.slice(-limit).map((m) => ({
		role: m.role,
		text: truncateMiddle(m.text, MAX_MESSAGE_CHARS),
	}));

	const instructions: string[] = [];
	let remaining = MAX_INSTRUCTION_CHARS;
	for (const text of context.instructions) {
		if (remaining <= 0) break;
		const clipped = truncateMiddle(text, remaining);
		instructions.push(clipped);
		remaining -= clipped.length;
	}

	const latestUserMessage = conversation.findLast(
		(m) => m.role === "user",
	)?.text;
	return {
		conversation,
		instructions,
		...(latestUserMessage !== undefined ? { latestUserMessage } : {}),
	};
};

/** Jev に渡す state。最新 user message を明示し、過去 message は文脈として扱わせる。 */
export const toJevState = (context: SemanticContext) => ({
	task: "Decide what the assistant needs in order to answer the LATEST user message. Earlier messages are context only: a capability needed for an earlier turn is not needed now unless the latest message still asks for it.",
	...(context.instructions.length > 0
		? { system_instructions: context.instructions }
		: {}),
	conversation: context.conversation.map((m) => ({
		role: m.role,
		content: m.text,
	})),
	latest_user_message: context.latestUserMessage,
});
