import type { Capability } from "../core/capabilities";
import type { NoulQuestion } from "./jev-client";

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
				"The latest message only mentions X/Twitter as a topic (what it is, how its API works, writing a post, comparing it with other services), asks to summarize or reformat results already in the conversation, changes the topic, or says not to search.",
		},
	},
	"web.search": {
		type: "noul",
		instructions:
			"To answer the latest user message correctly, must the assistant search the web right now?",
		criteria: {
			true: "The latest message needs current, recent, time-sensitive or specific external information (news, prices, releases, events, schedules, live data, or facts likely newer than the model's training data).",
			false:
				"The latest message can be answered from general knowledge, reasoning, writing, translation, coding, or from information already present in the conversation, or the user says not to search.",
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
