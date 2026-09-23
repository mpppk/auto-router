import type { NoulQuestion } from "./jev-client";

/**
 * Jev の判定結果 (question id → Yes probability) の短期 cache。
 * 値には probability だけを保存し、message 本文や raw API key は保存しない。
 */
export interface SemanticCache {
	get(key: string): Promise<Record<string, number> | undefined>;
	put(key: string, probabilities: Record<string, number>): Promise<void>;
}

/** 既定の TTL。agent loop の連続 request を想定し数分程度にする。 */
export const SEMANTIC_CACHE_TTL_SECONDS = 300;

/** cache 形式・key の作り方を変えたら上げる。 */
const CACHE_VERSION = 1;

const toHex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/**
 * cache key = SHA-256(version, API key fingerprint, Jev model, Jev state, question 定義)。
 * question 文面や state (直近の会話・instructions) が変われば別の key になる。
 * threshold は取得後に適用するため key に含めない (threshold を変えても古い probability で正しく再判定できる)。
 */
export const semanticCacheKey = async (input: {
	ownerFingerprint: string;
	model: string;
	state: unknown;
	questions: Record<string, NoulQuestion>;
}): Promise<string> =>
	toHex(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				JSON.stringify([
					CACHE_VERSION,
					input.ownerFingerprint,
					input.model,
					input.state,
					input.questions,
				]),
			),
		),
	);

const isProbabilities = (value: unknown): value is Record<string, number> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every(
		(p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1,
	);

/** Workers Cache API (data center 単位) を使う cache。 */
export const createCacheApiSemanticCache = (
	cache: Pick<Cache, "match" | "put">,
	ttlSeconds = SEMANTIC_CACHE_TTL_SECONDS,
): SemanticCache => {
	const url = (key: string) => `https://jev-cache.auto-router.internal/${key}`;
	return {
		async get(key) {
			const res = await cache.match(url(key));
			if (res === undefined) return undefined;
			const json: unknown = await res.json();
			return isProbabilities(json) ? json : undefined;
		},
		async put(key, probabilities) {
			await cache.put(
				url(key),
				Response.json(probabilities, {
					headers: { "cache-control": `max-age=${ttlSeconds}` },
				}),
			);
		},
	};
};

/** テスト用の in-memory cache。 */
export const createMemorySemanticCache = (
	options: { ttlMs?: number; now?: () => number } = {},
): SemanticCache & { size(): number } => {
	const ttlMs = options.ttlMs ?? SEMANTIC_CACHE_TTL_SECONDS * 1000;
	const now = options.now ?? Date.now;
	const entries = new Map<
		string,
		{ value: Record<string, number>; expiresAt: number }
	>();
	return {
		async get(key) {
			const entry = entries.get(key);
			return entry && entry.expiresAt > now() ? entry.value : undefined;
		},
		async put(key, value) {
			entries.set(key, { value, expiresAt: now() + ttlMs });
		},
		size: () => entries.size,
	};
};
