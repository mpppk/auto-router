import type { FetchLike } from "../upstream/openrouter";

/** OpenRouter 経由で呼ぶ Jev の model id (常に最新版)。 */
export const JEV_MODEL = "~typesafe/jev-latest";

export interface NoulQuestion {
	type: "noul";
	instructions: string | Record<string, unknown>;
	criteria?: { true: string; false: string };
}

export type JevFailureReason =
	| "jev_timeout"
	| "jev_error"
	| "jev_invalid_response"
	/** OpenRouter が caller の API key を拒否した (401)。 */
	| "jev_unauthorized";

export class JevError extends Error {
	readonly reason: JevFailureReason;

	constructor(reason: JevFailureReason, message: string) {
		super(message);
		this.name = "JevError";
		this.reason = reason;
	}
}

export interface JevClient {
	/**
	 * Noul question 群を評価し、question id → Yes probability (0..1) を返す。
	 * timeout / 非2xx / 不正な response は JevError を投げる。
	 */
	noul(
		state: unknown,
		questions: Record<string, NoulQuestion>,
		options: { apiKey: string; signal?: AbortSignal },
	): Promise<Record<string, number>>;
}

export interface JevClientConfig {
	/** 例: https://openrouter.ai/api/v1 */
	baseUrl: string;
	fetch: FetchLike;
	timeoutMs?: number;
	model?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isTimeout = (err: unknown) =>
	err instanceof Error &&
	(err.name === "TimeoutError" || err.name === "AbortError");

/**
 * OpenRouter System One API (`POST /systemone`) 経由の Jev client。
 * 認証には caller の OpenRouter API key を使う (auto-router 自身は key を持たない)。
 */
export const createJevClient = (config: JevClientConfig): JevClient => ({
	async noul(state, questions, { apiKey, signal }) {
		const timeout = AbortSignal.timeout(config.timeoutMs ?? 3000);
		let res: Response;
		try {
			res = await config.fetch(`${config.baseUrl}/systemone`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: config.model ?? JEV_MODEL,
					state,
					questions,
				}),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (err) {
			if (timeout.aborted || isTimeout(err)) {
				throw new JevError("jev_timeout", "Jev request timed out");
			}
			throw new JevError(
				"jev_error",
				`Jev request failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (res.status === 401) {
			throw new JevError("jev_unauthorized", "Jev rejected the API key");
		}
		if (!res.ok) {
			throw new JevError("jev_error", `Jev returned status ${res.status}`);
		}

		let json: unknown;
		try {
			json = await res.json();
		} catch {
			throw new JevError("jev_invalid_response", "Jev returned invalid JSON");
		}
		const answers = isRecord(json) ? json.answers : undefined;
		if (!isRecord(answers)) {
			throw new JevError("jev_invalid_response", "Jev response has no answers");
		}

		const probabilities: Record<string, number> = {};
		for (const id of Object.keys(questions)) {
			const answer = answers[id];
			const p = isRecord(answer) ? answer.noul : undefined;
			if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
				throw new JevError(
					"jev_invalid_response",
					`Jev answer for "${id}" is not a probability`,
				);
			}
			probabilities[id] = p;
		}
		return probabilities;
	},
});
