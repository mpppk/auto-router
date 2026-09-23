/**
 * auto-router 独自のエラーコード。
 * OpenRouter / OpenAI 互換クライアントが `error.message` / `error.code` / `error.type` を読めるよう、
 * レスポンスは `{ error: { message, type, code, metadata? } }` 形式で返す。
 */
export type RouterErrorCode =
	| "unsupported_endpoint"
	| "capability_not_supported"
	| "capability_conflict"
	| "invalid_router_request"
	| "missing_authorization"
	| "invalid_api_key"
	| "trace_not_found"
	| "rate_limited";

const STATUS_BY_CODE: Record<RouterErrorCode, number> = {
	unsupported_endpoint: 404,
	capability_not_supported: 422,
	capability_conflict: 422,
	invalid_router_request: 400,
	missing_authorization: 401,
	invalid_api_key: 401,
	trace_not_found: 404,
	rate_limited: 429,
};

export class RouterError extends Error {
	readonly code: RouterErrorCode;
	readonly status: number;
	readonly metadata: Record<string, unknown> | undefined;
	/** error response に付与する header (例: `Retry-After`)。 */
	readonly headers: Record<string, string>;

	constructor(
		code: RouterErrorCode,
		message: string,
		metadata?: Record<string, unknown>,
		headers: Record<string, string> = {},
	) {
		super(message);
		this.name = "RouterError";
		this.code = code;
		this.status = STATUS_BY_CODE[code];
		this.metadata = metadata;
		this.headers = headers;
	}

	toResponse(headers: Record<string, string> = {}): Response {
		return Response.json(this.toBody(), {
			status: this.status,
			headers: { ...this.headers, ...headers },
		});
	}

	toBody() {
		return {
			error: {
				message: this.message,
				type: this.code,
				code: this.code,
				...(this.metadata ? { metadata: this.metadata } : {}),
			},
		};
	}
}
