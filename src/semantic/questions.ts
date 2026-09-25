import type { Capability } from "../core/capabilities";
import type { NoulQuestion } from "./jev-client";

/**
 * 最新メッセージ中心の再判定用 question の id suffix。
 * 同一 Jev call で context-aware 版と併用する (#44)。
 */
export const FOCUSED_QUESTION_SUFFIX = ":focused";

export const focusedQuestionId = (capability: Capability): string =>
	`${capability}${FOCUSED_QUESTION_SUFFIX}`;

/**
 * capability ごとの Noul question。
 * 「その capability が最新の要求に答えるために必須か」の Yes probability を尋ねる。
 */
export const CAPABILITY_QUESTIONS: Record<Capability, NoulQuestion> = {
	"social.x.search": {
		type: "noul",
		instructions:
			"To answer the latest user message, must the assistant search and read actual posts on X (formerly Twitter) right now?",
		criteria: {
			true: "The latest message asks for current reactions, opinions, trends, discussions or specific posts on X/Twitter, explicitly or by clearly continuing an earlier X search request (e.g. 'what about product B?').",
			false:
				"The latest message only mentions X/Twitter as a topic (what it is, how its API works, writing a post, comparing it with other services), asks to summarize or reformat results already in the conversation, changes the topic, or the user or the system instructions say not to search X or not to search at all.",
		},
	},
	"web.search": {
		type: "noul",
		instructions:
			"To answer the latest user message correctly, must the assistant search the web right now?",
		criteria: {
			true: "The latest message needs current, recent, time-sensitive or specific external information (news, prices, releases, events, schedules, live data, or facts likely newer than the model's training data), or the system instructions require searching the web before answering.",
			false:
				"The latest message can be answered from general knowledge, reasoning, writing, translation, coding, or from information already present in the conversation, or the user or the system instructions say not to search.",
		},
	},
	"places.search": {
		type: "noul",
		instructions:
			"To answer the latest user message, must the assistant look up specific real-world places such as shops, restaurants or facilities?",
		criteria: {
			true: "The user wants to find, list or compare concrete places or businesses (e.g. nearby cafes, specific stores).",
			false:
				"No concrete place lookup is needed (general questions, writing, coding, or places only mentioned in passing).",
		},
	},
	"places.opening_hours": {
		type: "noul",
		instructions:
			"Does answering the latest user message require current opening hours of places or whether they are open now?",
		criteria: {
			true: "The user asks what is open now, business hours, or availability of a place at a time.",
			false: "Opening hours are not needed.",
		},
	},
	"places.reviews": {
		type: "noul",
		instructions:
			"Does answering the latest user message require reading reviews or ratings of specific places or businesses?",
		criteria: {
			true: "The user asks about reviews, ratings or reputation of specific shops, restaurants or other places.",
			false:
				"Reviews of places are not needed (including reviews of products, books or software).",
		},
	},
	"geo.proximity": {
		type: "noul",
		instructions:
			"Does answering the latest user message require distance, travel time or proximity relative to the user's current location or a specific location?",
		criteria: {
			true: "The user asks what is near, within walking distance, closer, or how far places are from a location.",
			false: "No location-relative distance or proximity is needed.",
		},
	},
	"source.google_maps": {
		type: "noul",
		instructions:
			"Does the latest user message explicitly require Google Maps data (listings, reviews, ratings or routes on Google Maps) as the source?",
		criteria: {
			true: "The user explicitly names Google Maps (or Google reviews of places) as the data source.",
			false: "Google Maps is not required as the source.",
		},
	},
};

/**
 * 最新メッセージ中心の再判定用 question (#44)。
 * caller の長い system prompt が state に混ざると context-aware 版の確率が希釈され
 * threshold (0.8) を割り込むことがあるため、同一 call でこちらも評価する。
 * state 自体は変えられない (1 call = 1 state) ので、question 文面で分離する:
 * 会話は参照解決 (同種の要求の継続か・結果が既出か) のためだけに使い、
 * system_instructions は検索の明示的な要求・禁止の有無の確認にだけ使い、それ以外は無視する。
 * detector は context-aware 版が uncertain の枠だけこの判定で上書きする
 * (required / not_required が確定した枠は触らない)。
 */
const FOCUSED_PREAMBLE =
	"Consider ONLY the latest_user_message in the state above. " +
	"Use earlier conversation solely to resolve references " +
	"(for example, whether the message continues an earlier request of the same kind, " +
	"or whether the requested information is already present in the conversation). " +
	"Read system_instructions ONLY to check for an explicit rule that requires or forbids " +
	"searching the web or X (Twitter); ignore every other instruction entirely. ";

export const FOCUSED_QUESTIONS: Record<Capability, NoulQuestion> = {
	"social.x.search": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Must the assistant search and read actual posts on X (formerly Twitter) right now to answer the latest message?`,
		criteria: {
			true: "The latest message asks for current reactions, opinions, trends, discussions or specific posts on X/Twitter (including clear continuations such as 'what about product B?'), and no explicit rule forbids it.",
			false:
				"The latest message only mentions X/Twitter as a topic (what it is, how its API works, writing a post, comparing services), asks to summarize or reformat information already present in the conversation, changes the topic, says not to search, or an explicit system rule forbids searching X or the web.",
		},
	},
	"web.search": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Must the assistant search the web right now to answer the latest message correctly?`,
		criteria: {
			true: "The latest message needs current, recent, time-sensitive or specific external information (news, prices, releases, events, schedules, live data, or facts likely newer than the model's training data), or an explicit system rule requires searching the web before answering.",
			false:
				"The latest message can be answered from general knowledge, reasoning, writing, translation, coding, or information already present in the conversation, the message says not to search, or an explicit system rule forbids searching.",
		},
	},
	"places.search": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Must the assistant look up specific real-world places such as shops, restaurants or facilities to answer the latest message?`,
		criteria: {
			true: "The latest message wants to find, list or compare concrete places or businesses (e.g. nearby cafes, specific stores).",
			false:
				"No concrete place lookup is needed (general questions, writing, coding, or places only mentioned in passing), or an explicit system rule forbids it.",
		},
	},
	"places.opening_hours": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Does answering the latest message require current opening hours of places or whether they are open now?`,
		criteria: {
			true: "The latest message asks what is open now, business hours, or availability of a place at a time.",
			false:
				"Opening hours are not needed, or an explicit system rule forbids searching.",
		},
	},
	"places.reviews": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Does answering the latest message require reading reviews or ratings of specific places or businesses?`,
		criteria: {
			true: "The latest message asks about reviews, ratings or reputation of specific shops, restaurants or other places.",
			false:
				"Reviews of places are not needed (including reviews of products, books or software), or an explicit system rule forbids searching.",
		},
	},
	"geo.proximity": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Does answering the latest message require distance, travel time or proximity relative to the user's current location or a specific location?`,
		criteria: {
			true: "The latest message asks what is near, within walking distance, closer, or how far places are from a location.",
			false:
				"No location-relative distance or proximity is needed, or an explicit system rule forbids searching.",
		},
	},
	"source.google_maps": {
		type: "noul",
		instructions: `${FOCUSED_PREAMBLE}Does the latest message explicitly require Google Maps data (listings, reviews, ratings or routes on Google Maps) as the source?`,
		criteria: {
			true: "The latest message explicitly names Google Maps (or Google reviews of places) as the data source.",
			false:
				"Google Maps is not required as the source, or an explicit system rule forbids searching.",
		},
	},
};
