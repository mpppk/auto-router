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
	| "trace_not_found";

const STATUS_BY_CODE: Record<RouterErrorCode, number> = {
	unsupported_endpoint: 404,
	capability_not_supported: 422,
	capability_conflict: 422,
	invalid_router_request: 400,
	missing_authorization: 401,
	trace_not_found: 404,
};

export class RouterError extends Error {
	readonly code: RouterErrorCode;
	readonly status: number;
	readonly metadata: Record<string, unknown> | undefined;

	constructor(
		code: RouterErrorCode,
		message: string,
		metadata?: Record<string, unknown>,
	) {
		super(message);
		this.name = "RouterError";
		this.code = code;
		this.status = STATUS_BY_CODE[code];
		this.metadata = metadata;
	}

	toResponse(headers: Record<string, string> = {}): Response {
		return Response.json(this.toBody(), { status: this.status, headers });
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
