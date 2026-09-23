import { RouterError } from "../core/errors";
import { apiKeyFingerprint } from "../trace/fingerprint";
import { logRouterEvent } from "../trace/log";
import { getBearerToken } from "../upstream/openrouter";

/** Workers Rate Limiting binding の必要部分。 */
export interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitDeps {
	/** client IP 単位の limiter。 */
	ip?: RateLimiter;
	/** API key fingerprint 単位の limiter。 */
	key?: RateLimiter;
	fingerprintSecret?: string;
	/** limiter の period (秒)。`Retry-After` に使う。 */
	periodSeconds: number;
}

const rateLimited = (scope: "ip" | "key", periodSeconds: number) => {
	logRouterEvent({ event: "rate_limited", scope });
	return new RouterError(
		"rate_limited",
		scope === "ip"
			? "Too many requests from this IP address. Please retry later."
			: "Too many requests for this API key. Please retry later.",
		{ scope },
		{ "Retry-After": String(periodSeconds) },
	);
};

/**
 * IP / API key fingerprint 単位の rate limit。超過時は 429 (`rate_limited`) を投げる。
 * Jev 呼び出し・D1 への trace 書き込みの前に実行する。binding が無い環境では何もしない。
 * raw key は limiter に渡さず fingerprint だけを使う。
 */
export const enforceRateLimit = async (
	request: Request,
	deps: RateLimitDeps,
): Promise<void> => {
	const ip = request.headers.get("cf-connecting-ip");
	const apiKey = getBearerToken(request.headers);
	const [ipOutcome, keyOutcome] = await Promise.all([
		deps.ip && ip ? deps.ip.limit({ key: `ip:${ip}` }) : undefined,
		deps.key && apiKey !== undefined
			? apiKeyFingerprint(apiKey, deps.fingerprintSecret).then((fp) =>
					deps.key?.limit({ key: `key:${fp}` }),
				)
			: undefined,
	]);
	if (ipOutcome?.success === false) throw rateLimited("ip", deps.periodSeconds);
	if (keyOutcome?.success === false) {
		throw rateLimited("key", deps.periodSeconds);
	}
};
