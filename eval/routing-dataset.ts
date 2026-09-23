import type { Capability } from "../src/core/capabilities";
import type { RouterErrorCode } from "../src/core/errors";
import type { RouteReason } from "../src/core/resolver";
import type { JevFailureReason } from "../src/semantic/jev-client";

/**
 * end-to-end routing eval case (#8 Phase B)。
 * `semantic` は Jev の Yes probability (固定値) または障害。threshold を変えると判定も変わる。
 * `simulated_semantic` tag の case は Jev 障害や中間確率を模擬するもので、実 Jev を使う `--live` では除外する。
 */
export interface RoutingGoldCase {
	id: string;
	tags: string[];
	request: Record<string, unknown>;
	semantic:
		| Partial<Record<Capability, number>>
		| { degraded: JevFailureReason };
	allowModelOverride?: boolean;
	/** `Auto-Router-*` 等の追加 request header。 */
	headers?: Record<string, string>;
	/** request の形式 (#30)。未指定なら Chat Completions。 */
	endpoint?: "chat_completions" | "responses" | "messages";
	/** Worker var `DEFAULT_ROUTE_MODELS` の設定値。未指定なら registry の既定値。 */
	defaultRouteModels?: string[];
	expected:
		| { effectiveChain: string[]; reason: RouteReason }
		| { error: RouterErrorCode };
}

export const CLAUDE = "anthropic/claude-sonnet-5";
export const GPT = "openai/gpt-5";
export const GROK = "x-ai/grok-4.7";
export const GROK_OLD = "x-ai/grok-4.5";
/** registry の既定 default route の fallback。 */
export const GROK_FALLBACK = "x-ai/grok-4.6";
/** registry の既定 default route (DEFAULT_GROK_MODELS)。 */
const DEFAULT_ROUTE = [GROK, GROK_FALLBACK];
export const TEXT_ONLY = "text/no-tools";

const X_QUESTION = [
	{ role: "user", content: "Xで今Claude Codeについてどんな反応がありますか？" },
];
const IMAGE_QUESTION = [
	{
		role: "user",
		content: [
			{ type: "text", text: "この画像の製品についてXでの反応を調べて" },
			{ type: "image_url", image_url: { url: "https://example.com/p.png" } },
		],
	},
];
const X = { "social.x.search": 0.95, "web.search": 0.9 };

// --- agent loop (#21): 元 model 固有の field を含む会話履歴 ---
const X_TASK = {
	role: "user",
	content:
		"Xで今Claude Codeについてどんな反応があるか調べて、要点をメモに保存して",
};
const saveNoteCall = (id: string) => ({
	id,
	type: "function",
	function: { name: "save_note", arguments: '{"text":"start"}' },
});
const CLAUDE_TOOL_TURN = {
	role: "assistant",
	content: "まずメモを作成します。",
	tool_calls: [saveNoteCall("toolu_01GGgByN7jEjYfiS8yXEpMWx")],
	reasoning_details: [
		{
			type: "reasoning.text",
			format: "anthropic-claude-v1",
			index: 0,
			text: "The user wants me to call save_note first.",
			signature: "EqoBCkgIBxABGAIiQL2...",
		},
	],
};
const GPT_TOOL_TURN = {
	role: "assistant",
	content: null,
	tool_calls: [saveNoteCall("call_9nxzin2m6gjgzKOQnNcHBSA9")],
	reasoning_details: [
		{
			type: "reasoning.encrypted",
			format: "openai-responses-v1",
			index: 0,
			id: "rs_0a1b2c",
			data: "gAAAAABo...",
		},
	],
};
const GROK_TOOL_TURN = {
	role: "assistant",
	content: null,
	tool_calls: [saveNoteCall("call-2d78829e-07d5-47ac-ae7e-cafcc7240d5c-7")],
	reasoning_details: [
		{
			type: "reasoning.encrypted",
			format: "xai-responses-v1",
			index: 0,
			data: "eyJ4YWkiOi...",
		},
	],
};
const toolResult = (turn: { tool_calls: { id: string }[] }) => ({
	role: "tool",
	tool_call_id: turn.tool_calls[0]?.id,
	content: "saved",
});
const fn = (name: string) => ({
	type: "function",
	function: { name, parameters: { type: "object", properties: {} } },
});

export const ROUTING_GOLD_DATASET: RoutingGoldCase[] = [
	// --- structural preservation ---
	{
		id: "structural-image-x-search",
		tags: ["structural"],
		request: { model: CLAUDE, messages: IMAGE_QUESTION },
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "structural-json-schema-x-search",
		tags: ["structural"],
		request: {
			model: CLAUDE,
			messages: X_QUESTION,
			response_format: {
				type: "json_schema",
				json_schema: { name: "r", schema: { type: "object" } },
			},
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "structural-function-tools-x-search",
		tags: ["structural", "tools"],
		request: { model: GROK, messages: X_QUESTION, tools: [fn("save_note")] },
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "structural-reasoning-override",
		tags: ["structural"],
		request: {
			model: GPT,
			messages: X_QUESTION,
			reasoning: { effort: "high" },
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "structural-provider-restrictions-kept",
		tags: ["structural", "provider"],
		request: {
			model: CLAUDE,
			messages: X_QUESTION,
			tools: [fn("save_note")],
			provider: {
				order: ["xai"],
				zdr: true,
				data_collection: "deny",
				quantizations: ["bf16"],
			},
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "structural-require-parameters-strengthened",
		tags: ["structural", "provider"],
		request: {
			model: GPT,
			messages: [{ role: "user", content: "JSONで返して" }],
			response_format: { type: "json_object" },
			provider: { require_parameters: false, only: ["openai"] },
		},
		semantic: {},
		expected: { effectiveChain: [GPT], reason: "requested_model" },
	},
	{
		id: "structural-provider-excludes-xai",
		tags: ["structural", "provider"],
		request: {
			model: GROK,
			messages: X_QUESTION,
			provider: { ignore: ["xai"] },
		},
		semantic: X,
		expected: { error: "capability_conflict" },
	},

	// --- model / models fallback ---
	{
		id: "chain-model-only-compatible",
		tags: ["chain"],
		request: { model: GROK, messages: X_QUESTION },
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "chain-models-only",
		tags: ["chain"],
		request: { models: [CLAUDE, GROK], messages: X_QUESTION },
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "filtered_fallback_chain" },
	},
	{
		id: "chain-model-and-models",
		tags: ["chain"],
		request: { model: CLAUDE, models: [GPT, GROK], messages: X_QUESTION },
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "filtered_fallback_chain" },
	},
	{
		id: "chain-primary-incompatible-fallback-compatible",
		tags: ["chain"],
		request: { model: GPT, models: [GROK_OLD], messages: X_QUESTION },
		semantic: X,
		expected: { effectiveChain: [GROK_OLD], reason: "filtered_fallback_chain" },
	},
	{
		id: "chain-primary-compatible-fallback-incompatible",
		tags: ["chain"],
		request: { model: GROK, models: [CLAUDE], messages: X_QUESTION },
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "filtered_fallback_chain" },
	},
	{
		id: "chain-partial-fallbacks",
		tags: ["chain"],
		request: {
			model: CLAUDE,
			models: [GROK, GPT, GROK_OLD],
			messages: X_QUESTION,
		},
		semantic: X,
		expected: {
			effectiveChain: [GROK, GROK_OLD],
			reason: "filtered_fallback_chain",
		},
	},
	{
		id: "chain-wiped-override-true",
		tags: ["chain", "override"],
		request: { model: CLAUDE, models: [GPT], messages: X_QUESTION },
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "chain-wiped-override-false",
		tags: ["chain", "override"],
		request: { model: CLAUDE, models: [GPT], messages: X_QUESTION },
		semantic: X,
		allowModelOverride: false,
		expected: { error: "capability_not_supported" },
	},
	{
		id: "chain-web-search-tool-injection-no-override",
		tags: ["chain", "tools"],
		request: {
			model: CLAUDE,
			messages: [{ role: "user", content: "今日のNVIDIAの株価は？" }],
		},
		semantic: { "web.search": 0.95 },
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},

	// --- tool merge / tool_choice ---
	{
		id: "tools-caller-function-preserved",
		tags: ["tools"],
		request: {
			model: CLAUDE,
			messages: [{ role: "user", content: "今日のニュースを調べてメモして" }],
			tools: [fn("save_note"), fn("send_mail")],
		},
		semantic: { "web.search": 0.95 },
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},
	{
		id: "tools-existing-server-tool-completed",
		tags: ["tools"],
		request: {
			model: GROK,
			messages: X_QUESTION,
			tools: [
				{
					type: "openrouter:web_search",
					parameters: {
						max_results: 3,
						x_search: { allowed_x_handles: ["AnthropicAI"] },
					},
				},
			],
		},
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "tools-x-search-present-tool-choice-none",
		tags: ["tools", "tool_choice"],
		request: {
			model: GROK,
			messages: X_QUESTION,
			tools: [
				{
					type: "openrouter:web_search",
					parameters: { engine: "native", x_search: {} },
				},
			],
			tool_choice: "none",
		},
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "tools-unrelated-function-forced",
		tags: ["tools", "tool_choice"],
		request: {
			model: GROK,
			messages: X_QUESTION,
			tools: [fn("save_note")],
			tool_choice: { type: "function", function: { name: "save_note" } },
		},
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "tools-caller-parameter-conflict",
		tags: ["tools"],
		request: {
			model: GROK,
			messages: X_QUESTION,
			tools: [{ type: "openrouter:web_search", parameters: { engine: "exa" } }],
		},
		semantic: X,
		expected: { error: "capability_conflict" },
	},
	{
		id: "tools-tool-choice-auto-kept",
		tags: ["tools", "tool_choice"],
		request: {
			model: GROK,
			messages: X_QUESTION,
			tools: [fn("save_note")],
			tool_choice: "auto",
		},
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "tools-tool-choice-none-without-requirement-kept",
		tags: ["tools", "tool_choice"],
		request: {
			model: CLAUDE,
			messages: [{ role: "user", content: "二分探索を書いて" }],
			tools: [fn("save_note")],
			tool_choice: "none",
		},
		semantic: {},
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},

	// --- degraded ---
	{
		id: "degraded-jev-timeout",
		tags: ["simulated_semantic", "degraded"],
		request: { model: CLAUDE, models: [GPT], messages: X_QUESTION },
		semantic: { degraded: "jev_timeout" },
		expected: { effectiveChain: [CLAUDE, GPT], reason: "degraded" },
	},
	{
		id: "degraded-jev-5xx",
		tags: ["simulated_semantic", "degraded"],
		request: { model: CLAUDE, messages: X_QUESTION },
		semantic: { degraded: "jev_error" },
		expected: { effectiveChain: [CLAUDE], reason: "degraded" },
	},
	{
		id: "degraded-jev-invalid-response",
		tags: ["simulated_semantic", "degraded"],
		request: { model: CLAUDE, messages: X_QUESTION },
		semantic: { degraded: "jev_invalid_response" },
		expected: { effectiveChain: [CLAUDE], reason: "degraded" },
	},
	{
		id: "degraded-structural-still-enforced",
		tags: ["simulated_semantic", "degraded", "structural"],
		request: {
			model: TEXT_ONLY,
			models: [CLAUDE],
			messages: X_QUESTION,
			tools: [fn("save_note")],
		},
		semantic: { degraded: "jev_timeout" },
		expected: { effectiveChain: [CLAUDE], reason: "filtered_fallback_chain" },
	},

	// --- misc ---
	{
		id: "no-requirement-passthrough",
		tags: ["passthrough"],
		request: {
			model: CLAUDE,
			models: [GPT],
			messages: [{ role: "user", content: "俳句を詠んで" }],
			temperature: 0.7,
			some_extension: { a: 1 },
		},
		semantic: {},
		expected: { effectiveChain: [CLAUDE, GPT], reason: "requested_model" },
	},
	{
		id: "uncertain-does-not-override",
		tags: ["simulated_semantic", "passthrough"],
		request: { model: CLAUDE, messages: X_QUESTION },
		semantic: { "social.x.search": 0.6 },
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},
	{
		id: "places-not-supported",
		tags: ["places"],
		request: {
			model: GROK,
			messages: [
				{ role: "user", content: "Google Mapsの口コミでこの2店舗を比較して" },
			],
		},
		semantic: {
			"source.google_maps": 0.95,
			"places.reviews": 0.95,
			"web.search": 0.9,
		},
		expected: { error: "capability_not_supported" },
	},

	// --- semantic routing control headers (#22) ---
	{
		id: "semantic-off-keeps-caller-chain",
		tags: ["semantic_control", "passthrough"],
		request: { model: CLAUDE, models: [GPT], messages: X_QUESTION },
		semantic: X,
		headers: { "Auto-Router-Semantic": "off" },
		expected: { effectiveChain: [CLAUDE, GPT], reason: "requested_model" },
	},
	{
		id: "semantic-off-structural-still-enforced",
		tags: ["semantic_control", "structural"],
		request: {
			model: TEXT_ONLY,
			models: [CLAUDE],
			messages: IMAGE_QUESTION,
			tools: [fn("save_note")],
		},
		semantic: X,
		headers: { "Auto-Router-Semantic": "off" },
		expected: { effectiveChain: [CLAUDE], reason: "filtered_fallback_chain" },
	},
	{
		id: "capabilities-scope-web-search-only",
		tags: ["semantic_control", "tools"],
		request: { model: CLAUDE, messages: X_QUESTION },
		semantic: X,
		headers: { "Auto-Router-Capabilities": "web.search" },
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},
	{
		id: "capabilities-scope-invalid",
		tags: ["semantic_control"],
		request: { model: CLAUDE, messages: X_QUESTION },
		semantic: X,
		headers: { "Auto-Router-Capabilities": "x.search" },
		expected: { error: "invalid_router_request" },
	},

	// --- agent loop (#21) ---
	{
		id: "agent-loop-claude-history-override-to-grok",
		tags: ["agent_loop", "tools"],
		request: {
			model: CLAUDE,
			messages: [X_TASK, CLAUDE_TOOL_TURN, toolResult(CLAUDE_TOOL_TURN)],
			tools: [fn("save_note")],
			reasoning: { max_tokens: 1024 },
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "agent-loop-gpt-history-override-to-grok",
		tags: ["agent_loop", "tools"],
		request: {
			model: GPT,
			messages: [
				X_TASK,
				GPT_TOOL_TURN,
				toolResult(GPT_TOOL_TURN),
				{ role: "assistant", content: "Xを検索します。" },
			],
			tools: [fn("save_note")],
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "agent-loop-grok-history-stays-on-grok",
		tags: ["agent_loop", "tools"],
		request: {
			model: GROK,
			messages: [X_TASK, GROK_TOOL_TURN, toolResult(GROK_TOOL_TURN)],
			tools: [fn("save_note")],
		},
		semantic: X,
		expected: { effectiveChain: [GROK], reason: "requested_model" },
	},
	{
		id: "agent-loop-new-user-turn-returns-to-caller-model",
		tags: ["agent_loop", "passthrough"],
		request: {
			model: CLAUDE,
			messages: [
				X_TASK,
				GROK_TOOL_TURN,
				toolResult(GROK_TOOL_TURN),
				{ role: "assistant", content: "X上では好意的な反応が多いです。" },
				{ role: "user", content: "ありがとう。今の要約を英語に翻訳して" },
			],
			tools: [fn("save_note")],
		},
		semantic: {},
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},

	// --- configured default route (#24) ---
	{
		id: "default-route-config-drops-incompatible-candidates",
		tags: ["default_route", "structural"],
		request: { model: CLAUDE, messages: IMAGE_QUESTION },
		semantic: X,
		// grok-3 は X Search 非対応、text-only は image 非対応
		defaultRouteModels: ["x-ai/grok-3", GROK_FALLBACK, TEXT_ONLY, GROK],
		expected: {
			effectiveChain: [GROK_FALLBACK, GROK],
			reason: "capability_override",
		},
	},
	{
		id: "default-route-config-web-search-needs-tools",
		tags: ["default_route", "tools"],
		request: {
			model: TEXT_ONLY,
			messages: [{ role: "user", content: "今日のニュースを教えて" }],
		},
		semantic: { "web.search": 0.95 },
		defaultRouteModels: [TEXT_ONLY, GROK_OLD, GROK],
		expected: {
			effectiveChain: [GROK_OLD, GROK],
			reason: "capability_override",
		},
	},
	{
		id: "default-route-config-no-compatible-model",
		tags: ["default_route"],
		request: { model: CLAUDE, messages: X_QUESTION },
		semantic: X,
		defaultRouteModels: ["x-ai/grok-3", TEXT_ONLY],
		expected: { error: "capability_not_supported" },
	},

	// --- Places degrade opt-in (#25) ---
	{
		id: "places-degrade-opt-in-web-search",
		tags: ["places", "degrade"],
		request: {
			model: CLAUDE,
			messages: [
				{ role: "user", content: "渋谷駅周辺でおすすめのラーメン屋を探して" },
			],
		},
		semantic: { "places.search": 0.95, "geo.proximity": 0.9 },
		headers: {
			"Auto-Router-Allow-Capability-Degrade":
				"places.search=web.search,geo.proximity=web.search",
		},
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},
	{
		id: "places-degrade-without-tools-overrides",
		tags: ["places", "degrade"],
		request: {
			model: TEXT_ONLY,
			messages: [{ role: "user", content: "新宿で今開いているカフェを教えて" }],
		},
		semantic: { "places.search": 0.95, "places.opening_hours": 0.95 },
		headers: {
			"Auto-Router-Allow-Capability-Degrade":
				"places.search=web.search,places.opening_hours=web.search",
		},
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "places-degrade-partial-opt-in-not-supported",
		tags: ["places", "degrade"],
		request: {
			model: CLAUDE,
			messages: [{ role: "user", content: "新宿で今開いているカフェを教えて" }],
		},
		semantic: { "places.search": 0.95, "places.opening_hours": 0.95 },
		headers: {
			"Auto-Router-Allow-Capability-Degrade": "places.search=web.search",
		},
		expected: { error: "capability_not_supported" },
	},
	{
		id: "places-degrade-google-maps-source-not-degraded",
		tags: ["places", "degrade"],
		request: {
			model: CLAUDE,
			messages: [
				{ role: "user", content: "Google Mapsの口コミでこの2店舗を比較して" },
			],
		},
		semantic: { "source.google_maps": 0.95, "places.reviews": 0.95 },
		headers: {
			"Auto-Router-Allow-Capability-Degrade": "places.reviews=web.search",
		},
		expected: { error: "capability_not_supported" },
	},

	// --- 複数 structural requirement の組み合わせ (#27) ---
	{
		id: "combo-image-json-schema-x-search",
		tags: ["structural", "combo"],
		request: {
			model: CLAUDE,
			models: [TEXT_ONLY],
			messages: IMAGE_QUESTION,
			response_format: {
				type: "json_schema",
				json_schema: { name: "r", schema: { type: "object" } },
			},
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "combo-audio-x-search-not-supported",
		tags: ["structural", "combo"],
		request: {
			model: CLAUDE,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "この音声で紹介している製品について、Xでの反応を調べて",
						},
						{
							type: "input_audio",
							input_audio: { data: "AAAA", format: "wav" },
						},
					],
				},
			],
		},
		semantic: X,
		expected: { error: "capability_not_supported" },
	},
	{
		id: "combo-file-web-search-tool-injection",
		tags: ["structural", "combo", "tools"],
		request: {
			model: CLAUDE,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "このPDFに載っている製品の今日の最新価格をWebで調べて",
						},
						{
							type: "file",
							file: {
								filename: "a.pdf",
								file_data: "data:application/pdf;base64,AAAA",
							},
						},
					],
				},
			],
		},
		semantic: { "web.search": 0.95 },
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},
	{
		id: "combo-reasoning-tools-web-search-filters-text-only",
		tags: ["structural", "combo", "tools"],
		request: {
			model: TEXT_ONLY,
			models: [CLAUDE, GPT],
			messages: [
				{ role: "user", content: "今日の日経平均の終値を調べてメモして" },
			],
			tools: [fn("save_note")],
			reasoning: { effort: "low" },
		},
		semantic: { "web.search": 0.95 },
		expected: {
			effectiveChain: [CLAUDE, GPT],
			reason: "filtered_fallback_chain",
		},
	},

	// --- Responses API (#30) ---
	{
		id: "responses-x-search-override",
		tags: ["endpoint", "responses", "tools"],
		endpoint: "responses",
		request: {
			model: CLAUDE,
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: X_QUESTION[0]?.content }],
				},
			],
			instructions: "簡潔に答えてください",
			tools: [{ type: "function", name: "save_note", parameters: {} }],
			tool_choice: { type: "function", name: "save_note" },
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "responses-web-search-tool-injection",
		tags: ["endpoint", "responses", "tools"],
		endpoint: "responses",
		request: { model: CLAUDE, input: "今日の主要なニュースを教えて" },
		semantic: { "web.search": 0.95 },
		expected: { effectiveChain: [CLAUDE], reason: "requested_model" },
	},
	{
		id: "responses-structured-output-filters-text-only",
		tags: ["endpoint", "responses", "structural"],
		endpoint: "responses",
		request: {
			model: TEXT_ONLY,
			models: [GPT],
			input: "今日のドル円レートをJSONで",
			text: { format: { type: "json_schema", name: "r", schema: {} } },
		},
		semantic: { "web.search": 0.95 },
		expected: { effectiveChain: [GPT], reason: "filtered_fallback_chain" },
	},

	// --- Anthropic Messages API (#30) ---
	{
		id: "messages-x-search-override-tool-choice",
		tags: ["endpoint", "messages", "tools", "tool_choice"],
		endpoint: "messages",
		request: {
			model: CLAUDE,
			max_tokens: 1024,
			system: "簡潔に答えてください",
			messages: X_QUESTION,
			tools: [{ name: "save_note", input_schema: { type: "object" } }],
			tool_choice: { type: "tool", name: "save_note" },
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "messages-agent-loop-tool-result",
		tags: ["endpoint", "messages", "agent_loop"],
		endpoint: "messages",
		request: {
			model: CLAUDE,
			max_tokens: 1024,
			messages: [
				{ role: "user", content: X_TASK.content },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "save first", signature: "EqoB..." },
						{
							type: "tool_use",
							id: "toolu_01",
							name: "save_note",
							input: { text: "start" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_01", content: "saved" },
					],
				},
			],
			tools: [{ name: "save_note", input_schema: { type: "object" } }],
			thinking: { type: "enabled", budget_tokens: 1024 },
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
	{
		id: "messages-image-x-search",
		tags: ["endpoint", "messages", "structural"],
		endpoint: "messages",
		request: {
			model: CLAUDE,
			models: [TEXT_ONLY],
			max_tokens: 1024,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "この画像の製品についてXでの反応を調べて" },
						{
							type: "image",
							source: { type: "url", url: "https://example.com/p.png" },
						},
					],
				},
			],
		},
		semantic: X,
		expected: { effectiveChain: DEFAULT_ROUTE, reason: "capability_override" },
	},
];
