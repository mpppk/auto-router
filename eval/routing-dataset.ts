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
	expected:
		| { effectiveChain: string[]; reason: RouteReason }
		| { error: RouterErrorCode };
}

export const CLAUDE = "anthropic/claude-sonnet-5";
export const GPT = "openai/gpt-5";
export const GROK = "x-ai/grok-4.7";
export const GROK_OLD = "x-ai/grok-4.5";
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
		expected: { effectiveChain: [GROK], reason: "capability_override" },
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
		expected: { effectiveChain: [GROK], reason: "capability_override" },
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
		expected: { effectiveChain: [GROK], reason: "capability_override" },
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
		expected: { effectiveChain: [GROK], reason: "capability_override" },
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
		expected: { effectiveChain: [GROK], reason: "capability_override" },
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
];
