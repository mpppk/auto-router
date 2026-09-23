import type { RoutingTrace } from "./trace";

/** routing trace の保持期間。 */
export const TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TraceStore {
	put(trace: RoutingTrace, owner: string): Promise<void>;
	/** owner が一致しない trace は存在しないものとして扱う。 */
	get(id: string, owner: string): Promise<RoutingTrace | undefined>;
	deleteExpired(now: number): Promise<void>;
}

export const createD1TraceStore = (
	db: D1Database,
	options: { now?: () => number; ttlMs?: number } = {},
): TraceStore => {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? TRACE_TTL_MS;
	return {
		async put(trace, owner) {
			const createdAt = now();
			await db
				.prepare(
					"INSERT INTO routing_traces (id, owner, created_at, expires_at, debug, trace) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.bind(
					trace.id,
					owner,
					createdAt,
					createdAt + ttlMs,
					trace.detail === "full" ? 1 : 0,
					JSON.stringify(trace),
				)
				.run();
		},
		async get(id, owner) {
			const row = await db
				.prepare(
					"SELECT trace FROM routing_traces WHERE id = ? AND owner = ? AND expires_at > ?",
				)
				.bind(id, owner, now())
				.first<{ trace: string }>();
			return row ? (JSON.parse(row.trace) as RoutingTrace) : undefined;
		},
		async deleteExpired(at) {
			await db
				.prepare("DELETE FROM routing_traces WHERE expires_at <= ?")
				.bind(at)
				.run();
		},
	};
};

/** テスト / binding 未設定時用の in-memory store。 */
export const createMemoryTraceStore = (
	options: { now?: () => number; ttlMs?: number } = {},
): TraceStore & { size(): number } => {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? TRACE_TTL_MS;
	const rows = new Map<
		string,
		{ owner: string; expiresAt: number; trace: string }
	>();
	return {
		async put(trace, owner) {
			rows.set(trace.id, {
				owner,
				expiresAt: now() + ttlMs,
				trace: JSON.stringify(trace),
			});
		},
		async get(id, owner) {
			const row = rows.get(id);
			if (row === undefined || row.owner !== owner || row.expiresAt <= now()) {
				return undefined;
			}
			return JSON.parse(row.trace) as RoutingTrace;
		},
		async deleteExpired(at) {
			for (const [id, row] of rows) if (row.expiresAt <= at) rows.delete(id);
		},
		size: () => rows.size,
	};
};
