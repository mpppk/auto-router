import type { Capability } from "../src/core/capabilities";
import type { ConversationMessage } from "../src/core/types";

/**
 * Jev semantic detector 用の gold dataset。
 * `expected` は binary gold (必須 = true / 不要 = false)。省略した capability は評価しない。
 */
export interface SemanticGoldCase {
	id: string;
	tags: string[];
	conversation: ConversationMessage[];
	instructions?: string[];
	expected: Partial<Record<Capability, boolean>>;
}

const user = (text: string): ConversationMessage => ({ role: "user", text });
const assistant = (text: string): ConversationMessage => ({
	role: "assistant",
	text,
});

const X_SEARCH_TURN = [
	user("Xで今Claude Codeについてどんな反応がありますか？"),
	assistant(
		"X上の最近の投稿を検索しました。主な反応: (1) エージェント機能が便利という声、(2) 料金への不満、(3) 他ツールとの比較。@dev_a「Claude Codeでリファクタが一瞬」、@dev_b「使用量制限が厳しい」などの投稿が多く見られました。",
	),
];

export const SEMANTIC_GOLD_DATASET: SemanticGoldCase[] = [
	// --- social.x.search positive ---
	{
		id: "x-pos-reaction",
		tags: ["x"],
		conversation: [user("Xで今Claude Codeについてどんな反応がありますか？")],
		expected: { "social.x.search": true },
	},
	{
		id: "x-pos-trending-ai-news",
		tags: ["x"],
		conversation: [user("今日Xで話題になっているAIニュースを教えて")],
		expected: { "social.x.search": true },
	},
	{
		id: "x-pos-product-reaction",
		tags: ["x"],
		conversation: [user("この新製品についてXユーザーの反応をまとめて")],
		expected: { "social.x.search": true },
	},
	{
		id: "x-pos-twitter-evaluation",
		tags: ["x"],
		conversation: [user("Twitterではこの発表をどう評価していますか？")],
		expected: { "social.x.search": true },
	},
	{
		id: "x-pos-english",
		tags: ["x", "en"],
		conversation: [
			user("What are people on X saying about today's iPhone launch?"),
		],
		expected: { "social.x.search": true },
	},
	{
		id: "x-pos-latest-posts-of-account",
		tags: ["x"],
		conversation: [user("@OpenRouterAI の最新のポストを教えて")],
		expected: { "social.x.search": true },
	},

	// --- X mention only / negative ---
	{
		id: "x-neg-what-is-x",
		tags: ["x", "mention_only"],
		conversation: [user("XとはどんなSNSですか？")],
		expected: { "social.x.search": false },
	},
	{
		id: "x-neg-api",
		tags: ["x", "mention_only"],
		conversation: [user("X APIの仕組みを説明して")],
		expected: { "social.x.search": false },
	},
	{
		id: "x-neg-write-post",
		tags: ["x", "mention_only"],
		conversation: [user("Xに投稿する文章を考えて")],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "x-neg-x-vs-threads",
		tags: ["x", "mention_only"],
		conversation: [user("XとThreadsの違いを説明して")],
		expected: { "social.x.search": false },
	},
	{
		id: "x-neg-translate-tweet",
		tags: ["x", "mention_only"],
		conversation: [
			user("このツイートを英語に翻訳して: 「今日はいい天気なので散歩します」"),
		],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "x-neg-explicit-no-search",
		tags: ["x", "explicit_no_search"],
		conversation: [
			user(
				"Xの反応は検索しなくていいので、この種の発表が一般的にどう受け止められがちかだけ教えて",
			),
		],
		expected: { "social.x.search": false },
	},

	// --- web.search positive ---
	{
		id: "web-pos-weather",
		tags: ["web"],
		conversation: [user("今日の東京の天気は？")],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "web-pos-stock",
		tags: ["web"],
		conversation: [user("NVIDIAの現在の株価を教えて")],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "web-pos-recent-release",
		tags: ["web", "en"],
		conversation: [
			user("What's the latest TypeScript version released this month?"),
		],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "web-pos-match-result",
		tags: ["web"],
		conversation: [user("昨日のサッカー日本代表の試合結果は？")],
		expected: { "web.search": true, "social.x.search": false },
	},

	// --- web.search negative ---
	{
		id: "web-neg-code",
		tags: ["web"],
		conversation: [user("二分探索をPythonで書いて")],
		expected: { "web.search": false, "social.x.search": false },
	},
	{
		id: "web-neg-photosynthesis",
		tags: ["web"],
		conversation: [user("光合成の仕組みを簡単に説明して")],
		expected: { "web.search": false, "social.x.search": false },
	},
	{
		id: "web-neg-rewrite",
		tags: ["web"],
		conversation: [user("この文章を丁寧語に直して: 明日は行けない")],
		expected: { "web.search": false, "social.x.search": false },
	},
	{
		id: "web-neg-capital",
		tags: ["web"],
		conversation: [user("フランスの首都は？")],
		expected: { "web.search": false },
	},
	{
		id: "web-neg-haiku",
		tags: ["web", "en"],
		conversation: [user("Write a haiku about autumn.")],
		expected: { "web.search": false, "social.x.search": false },
	},

	// --- Places / Maps required ---
	{
		id: "places-google-maps-reviews",
		tags: ["places"],
		conversation: [user("Google Mapsの口コミでこの2店舗を比較して")],
		expected: {
			"source.google_maps": true,
			"places.reviews": true,
			"social.x.search": false,
		},
	},
	{
		id: "places-open-now-walking",
		tags: ["places"],
		conversation: [user("現在地から徒歩10分以内で今営業している店")],
		expected: {
			"places.search": true,
			"places.opening_hours": true,
			"geo.proximity": true,
			"social.x.search": false,
		},
	},
	{
		id: "places-which-is-closer",
		tags: ["places"],
		conversation: [user("A店とB店ならここからどちらが近い？")],
		expected: { "geo.proximity": true, "social.x.search": false },
	},
	{
		id: "places-ramen-shibuya",
		tags: ["places"],
		conversation: [user("渋谷駅周辺でおすすめのラーメン屋を探して")],
		expected: { "places.search": true, "social.x.search": false },
	},
	{
		id: "places-pharmacy-open",
		tags: ["places"],
		conversation: [user("近くの薬局は今開いてる？")],
		expected: {
			"places.opening_hours": true,
			"geo.proximity": true,
		},
	},

	// --- Places / Maps negative ---
	{
		id: "places-neg-maps-api-pricing",
		tags: ["places", "mention_only"],
		conversation: [
			user("Google Maps Platform APIの課金の仕組みを一般論として説明して"),
		],
		expected: {
			"source.google_maps": false,
			"places.search": false,
			"places.reviews": false,
		},
	},
	{
		id: "places-neg-ramen-recipe",
		tags: ["places"],
		conversation: [user("家で作れる醤油ラーメンのレシピを教えて")],
		expected: {
			"places.search": false,
			"places.opening_hours": false,
			"geo.proximity": false,
		},
	},
	{
		id: "places-neg-book-review",
		tags: ["places"],
		conversation: [user("『吾輩は猫である』の書評を400字で書いて")],
		expected: { "places.reviews": false, "source.google_maps": false },
	},

	// --- conversation-aware ---
	{
		id: "conv-x-continuation-ellipsis",
		tags: ["conversation", "continuation", "x"],
		conversation: [...X_SEARCH_TURN, user("Cursorは？")],
		expected: { "social.x.search": true },
	},
	{
		id: "conv-x-continuation-other-product",
		tags: ["conversation", "continuation", "x"],
		conversation: [
			user("Twitterで新しいPixelの評判を調べて"),
			assistant(
				"Twitterの投稿を確認しました。カメラ性能を評価する声が多い一方、バッテリー持ちへの不満も見られます。",
			),
			user("じゃあiPhoneの方は？"),
		],
		expected: { "social.x.search": true },
	},
	{
		id: "conv-x-topic-shift",
		tags: ["conversation", "topic_shift", "x"],
		conversation: [
			...X_SEARCH_TURN,
			user("ところで、Pythonでリストを降順にソートする方法を教えて"),
		],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "conv-x-summarize-results",
		tags: ["conversation", "search_reuse", "x"],
		conversation: [...X_SEARCH_TURN, user("今の結果を3行で要約して")],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "conv-x-reuse-results-table",
		tags: ["conversation", "search_reuse", "x"],
		conversation: [
			...X_SEARCH_TURN,
			user("さっきの反応を肯定・否定で表にまとめて"),
		],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "conv-x-explicit-no-search",
		tags: ["conversation", "explicit_no_search", "x"],
		conversation: [
			...X_SEARCH_TURN,
			user("今回は検索しないで、あなた自身の意見だけ聞かせて"),
		],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "conv-x-old-request-in-window",
		tags: ["conversation", "topic_shift", "x"],
		conversation: [
			...X_SEARCH_TURN,
			user("ありがとう。話は変わるけど、TypeScriptでdebounce関数を書いて"),
			assistant(
				"function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }",
			),
			user("型を厳密にして"),
			assistant(
				"function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) { ... }",
			),
			user("leading edgeのオプションも付けて"),
			assistant("leading オプションを追加した実装です: ..."),
			user("この関数のユニットテストを書いて"),
		],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "conv-web-continuation",
		tags: ["conversation", "continuation", "web"],
		conversation: [
			user("今日のドル円レートは？"),
			assistant("本日のドル円は1ドル=148.2円前後で推移しています。"),
			user("ユーロは？"),
		],
		expected: { "web.search": true },
	},
	{
		id: "conv-web-summarize-results",
		tags: ["conversation", "search_reuse", "web"],
		conversation: [
			user("今週発表されたAI関連のニュースを調べて"),
			assistant(
				"今週のAIニュース: 1) 新しいオープンモデルの公開 2) 大手クラウドの価格改定 3) 規制に関する政府発表。",
			),
			user("2番目についてもう少し詳しく、今の情報だけで説明して"),
		],
		expected: { "web.search": false, "social.x.search": false },
	},

	// --- English / 日英混在 (#27) ---
	{
		id: "en-x-pos-twitter-opinion",
		tags: ["x", "en"],
		conversation: [
			user("Can you check what people on Twitter think about the new Pixel?"),
		],
		expected: { "social.x.search": true },
	},
	{
		id: "en-x-neg-draft-tweet",
		tags: ["x", "en", "mention_only"],
		conversation: [
			user("Draft a tweet announcing our product launch next Monday."),
		],
		expected: { "social.x.search": false, "web.search": false },
	},
	{
		id: "en-web-pos-bitcoin-price",
		tags: ["web", "en"],
		conversation: [user("What's the current price of Bitcoin?")],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "en-web-neg-hash-map",
		tags: ["web", "en"],
		conversation: [user("Explain how a hash map handles collisions.")],
		expected: { "web.search": false, "social.x.search": false },
	},
	{
		id: "mixed-x-pos-reaction",
		tags: ["x", "mixed"],
		conversation: [
			user("Claude Codeのnew releaseについてXでのreactionをまとめて"),
		],
		expected: { "social.x.search": true },
	},
	{
		id: "mixed-web-pos-node-lts",
		tags: ["web", "mixed"],
		conversation: [user("latest Node.js LTS のバージョンは？")],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "en-places-pos-sushi-near",
		tags: ["places", "en"],
		conversation: [user("Find a good sushi place near Shinjuku station.")],
		expected: {
			"places.search": true,
			"geo.proximity": true,
			"source.google_maps": false,
		},
	},
	{
		id: "en-places-neg-sushi-history",
		tags: ["places", "en"],
		conversation: [user("What is the history of sushi?")],
		expected: {
			"places.search": false,
			"geo.proximity": false,
			"web.search": false,
		},
	},

	// --- 曖昧なケース (#27) ---
	{
		id: "ambiguous-recent-iphone",
		tags: ["ambiguous", "web"],
		conversation: [user("最近のiPhoneってどう？")],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "ambiguous-trending-ai-tools",
		tags: ["ambiguous", "web"],
		conversation: [user("話題の生成AIツールって何がある？")],
		expected: { "web.search": true, "social.x.search": false },
	},
	{
		id: "ambiguous-generic-advice",
		tags: ["ambiguous", "web"],
		conversation: [user("最近疲れやすいんだけど、どうしたらいい？")],
		expected: { "web.search": false, "social.x.search": false },
	},

	// --- 長い会話: 12 件の窓の境界 (#27) ---
	{
		id: "long-x-continuation-at-window-start",
		tags: ["conversation", "long", "continuation", "x"],
		conversation: [
			// 窓 (直近 12 件) の先頭に X 検索の依頼が入る
			...X_SEARCH_TURN,
			user("料金への不満はどんな内容？"),
			assistant("主に使用量制限と月額料金に関する投稿です。"),
			user("好意的な投稿はどれくらい？"),
			assistant("検索結果の約6割が好意的でした。"),
			user("比較されていたツールは？"),
			assistant("Cursor や Copilot との比較が多く見られました。"),
			user("Cursor との比較で多かった意見は？"),
			assistant(
				"補完の速さは Cursor、自律的な作業は Claude Code という意見です。",
			),
			user("じゃあ Cursor についても同じように X の反応を調べて"),
		],
		expected: { "social.x.search": true },
	},
	{
		id: "long-x-request-outside-window",
		tags: ["conversation", "long", "topic_shift", "x"],
		conversation: [
			...X_SEARCH_TURN,
			user("ありがとう。ところで Rust の所有権を説明して"),
			assistant("Rust では各値に所有者が1つあり..."),
			user("借用との違いは？"),
			assistant("借用は所有権を移さずに参照する仕組みで..."),
			user("ライフタイムは？"),
			assistant("ライフタイムは参照が有効な範囲を表し..."),
			user("例を書いて"),
			assistant("fn longest<'a>(x: &'a str, y: &'a str) -> &'a str { ... }"),
			user("'static の意味は？"),
			assistant("'static はプログラム全体の間有効な参照です。"),
			user(
				'じゃあこのコードのコンパイルエラーを直して: fn f() -> &str { "a" }',
			),
		],
		expected: { "social.x.search": false, "web.search": false },
	},

	// --- system prompt で検索を指示 / 禁止 (#27) ---
	{
		id: "system-forbids-search",
		tags: ["system", "explicit_no_search", "web"],
		instructions: [
			"You must never search the web or use external tools. Answer only from your own knowledge and say so if you are unsure.",
		],
		conversation: [user("今日の東京の天気は？")],
		expected: { "web.search": false },
	},
	{
		id: "system-forbids-x",
		tags: ["system", "explicit_no_search", "x"],
		instructions: ["Do not search X (Twitter) under any circumstances."],
		conversation: [user("Xで今Claude Codeについてどんな反応がありますか？")],
		expected: { "social.x.search": false },
	},
	{
		id: "system-x-analyst",
		tags: ["system", "x"],
		instructions: [
			"You are a social media analyst. You monitor posts on X (Twitter) and report current reactions.",
		],
		conversation: [user("今日発表された新しい Gemini への反応をまとめて")],
		expected: { "social.x.search": true },
	},
	{
		id: "system-always-verify-with-search",
		tags: ["system", "web"],
		instructions: [
			"Always search the web to verify facts and cite sources before answering any factual question.",
		],
		conversation: [user("日本で一番高い山の標高は？")],
		expected: { "web.search": true, "social.x.search": false },
	},
];
