export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface UpstreamConfig {
	/** 例: https://openrouter.ai/api/v1 */
	baseUrl: string;
	fetch: FetchLike;
}

/** upstream へ転送しないrequest header (hop-by-hop / 経路固有 / auto-router 独自)。 */
const DROPPED_REQUEST_HEADERS = new Set([
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-connection",
	"cookie",
	"origin",
	"accept-encoding",
	"x-real-ip",
	"true-client-ip",
	"cdn-loop",
]);

const DROPPED_REQUEST_HEADER_PREFIXES = ["auto-router-", "cf-", "x-forwarded-"];

/**
 * caller のrequest header から upstream OpenRouter へ送るheaderを作る。
 * Authorization (BYOK) と HTTP-Referer / X-Title 等の OpenRouter 向けheaderは透過し、
 * `Auto-Router-*` は送らない。
 */
export const buildUpstreamHeaders = (
	incoming: Headers,
	options: { json?: boolean } = { json: true },
): Headers => {
	const headers = new Headers();
	incoming.forEach((value, key) => {
		const name = key.toLowerCase();
		if (DROPPED_REQUEST_HEADERS.has(name)) return;
		if (DROPPED_REQUEST_HEADER_PREFIXES.some((p) => name.startsWith(p))) {
			return;
		}
		headers.set(key, value);
	});
	if (options.json) {
		headers.set("content-type", "application/json");
	} else {
		headers.delete("content-type");
	}
	return headers;
};

/** `Authorization: Bearer <key>` から key を取り出す。key自体は保存・ログしない。 */
export const getBearerToken = (headers: Headers): string | undefined => {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
	return match?.[1];
};

/**
 * OpenRouter へ native fetch() で転送する。
 * response body / SSE は解釈・再構築せず、stream のまま返す。
 */
export const forwardToOpenRouter = (
	config: UpstreamConfig,
	path: string,
	body: string,
	incomingHeaders: Headers,
	signal?: AbortSignal,
): Promise<Response> =>
	config.fetch(`${config.baseUrl}${path}`, {
		method: "POST",
		headers: buildUpstreamHeaders(incomingHeaders),
		body,
		signal,
	});

/**
 * body の無い GET request (`/models` 等) を OpenRouter へ透過する。
 * query string と Authorization 等の header はそのまま渡す。
 */
export const forwardGetToOpenRouter = (
	config: UpstreamConfig,
	path: string,
	search: string,
	incomingHeaders: Headers,
	signal?: AbortSignal,
): Promise<Response> =>
	config.fetch(`${config.baseUrl}${path}${search}`, {
		method: "GET",
		headers: buildUpstreamHeaders(incomingHeaders, { json: false }),
		signal,
	});

/** upstream response を body を触らずに client 向けresponseへ包み直す (header追加用)。 */
export const toClientResponse = (
	upstream: Response,
	extraHeaders: Record<string, string> = {},
): Response => {
	const headers = new Headers(upstream.headers);
	// OpenRouter ドメイン向けの cookie を caller に渡さない。
	headers.delete("set-cookie");
	for (const [key, value] of Object.entries(extraHeaders)) {
		headers.set(key, value);
	}
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
};
