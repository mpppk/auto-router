import { type Bindings, createTraceStore } from "./app";
import { refreshCatalogKv } from "./catalog/kv-catalog";
import {
	DEFAULT_OPENROUTER_BASE_URL,
	type FetchLike,
} from "./upstream/openrouter";

/** wrangler.jsonc の cron trigger。 */
export const TRACE_CLEANUP_CRON = "17 3 * * *";
export const CATALOG_REFRESH_CRON = "7 * * * *";

export const runScheduled = async (
	cron: string,
	env: Pick<Bindings, "CATALOG_KV" | "TRACES_DB">,
	options: { fetch?: FetchLike; now?: () => number } = {},
) => {
	const now = options.now ?? Date.now;
	switch (cron) {
		case TRACE_CLEANUP_CRON:
			// 期限切れ routing trace を削除する。
			await createTraceStore(env)?.deleteExpired(now());
			return;
		case CATALOG_REFRESH_CRON: {
			// OpenRouter model catalog を縮約して KV に保存する (#20)。
			const profiles = await refreshCatalogKv({
				kv: env.CATALOG_KV,
				baseUrl: DEFAULT_OPENROUTER_BASE_URL,
				fetch: options.fetch ?? ((input, init) => fetch(input, init)),
				timeoutMs: 10000,
				now,
			});
			console.log("refreshed model catalog", profiles.length);
			return;
		}
		default:
			console.warn("unknown cron", cron);
	}
};
