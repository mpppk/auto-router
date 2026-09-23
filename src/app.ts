import { type Context, Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { createKvModelCatalogSource } from "./catalog/kv-catalog";
import {
	createOpenRouterModelCatalogSource,
	type ModelCatalogSource,
} from "./catalog/model-catalog";
import { parseModelList } from "./config";
import { RouterError } from "./core/errors";
import { handleChatCompletions, type TraceDeps } from "./http/chat-completions";
import { handleGetTrace, handleInspect } from "./http/debug";
import { enforceRateLimit, type RateLimiter } from "./http/rate-limit";
import type { RoutingDeps } from "./routing/decide";
import {
	createSemanticDetector,
	type SemanticDetector,
} from "./semantic/detector";
import { createJevClient } from "./semantic/jev-client";
import {
	createD1TraceStore,
	createMemoryTraceStore,
	type TraceStore,
} from "./trace/store";
import {
	DEFAULT_OPENROUTER_BASE_URL,
	forwardGetToOpenRouter,
	toClientResponse,
	type UpstreamConfig,
} from "./upstream/openrouter";

/** Worker の binding / secret。secret は `wrangler secret put` で設定する。 */
export type Bindings = Env & {
	/** trace ownership 用 API key fingerprint の HMAC secret。 */
	TRACE_FINGERPRINT_SECRET?: string;
};

export interface AppDeps {
	upstream?: Partial<UpstreamConfig>;
	detector?: SemanticDetector;
	catalog?: ModelCatalogSource;
	/** 指定しない場合は `TRACES_DB` binding (無ければ in-memory) を使う。 */
	traceStore?: TraceStore;
	/** 指定しない場合は Worker var `DEFAULT_ROUTE_MODELS` (無ければ registry の既定値) を使う。 */
	defaultRouteModels?: string[];
	/** 指定しない場合は `RATE_LIMIT_IP` / `RATE_LIMIT_KEY` binding (無ければ無制限) を使う。 */
	rateLimiters?: { ip?: RateLimiter; key?: RateLimiter };
}

/** `wrangler.jsonc` の ratelimits の period (秒)。 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** browser から読めるようにする auto-router 独自response header。 */
export const EXPOSED_HEADERS = [
	"Auto-Router-Trace-Id",
	"Auto-Router-Requested-Model",
	"Auto-Router-Selected-Model",
	"Auto-Router-Route-Reason",
	"Auto-Router-Degraded",
];

export const createTraceStore = (env: Partial<Bindings> | undefined) =>
	env?.TRACES_DB ? createD1TraceStore(env.TRACES_DB) : undefined;

export const createApp = (deps: AppDeps = {}) => {
	const upstream: UpstreamConfig = {
		baseUrl: deps.upstream?.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
		fetch: deps.upstream?.fetch ?? ((input, init) => fetch(input, init)),
	};
	const detector =
		deps.detector ?? createSemanticDetector({ jev: createJevClient(upstream) });
	// isolate 内 cache を request 間で共有するため、source は isolate ごとに1つだけ作る。
	let directCatalog: ModelCatalogSource | undefined;
	let kvCatalog: ModelCatalogSource | undefined;
	const catalogFor = (env: Partial<Bindings> | undefined) => {
		if (deps.catalog) return deps.catalog;
		const kv = env?.CATALOG_KV;
		if (kv) {
			kvCatalog ??= createKvModelCatalogSource({ ...upstream, kv });
			return kvCatalog;
		}
		directCatalog ??= createOpenRouterModelCatalogSource(upstream);
		return directCatalog;
	};
	const routingDeps = (c: Context<{ Bindings: Bindings }>): RoutingDeps => {
		const env = c.env as Partial<Bindings> | undefined;
		const defaultRouteModels =
			deps.defaultRouteModels ??
			parseModelList("DEFAULT_ROUTE_MODELS", env?.DEFAULT_ROUTE_MODELS);
		return {
			detector,
			catalog: catalogFor(env),
			...(defaultRouteModels ? { defaultRouteModels } : {}),
		};
	};
	const fallbackTraceStore = createMemoryTraceStore();

	const traceDeps = (c: Context<{ Bindings: Bindings }>): TraceDeps => {
		const env = c.env as Partial<Bindings> | undefined;
		let waitUntil: TraceDeps["waitUntil"];
		try {
			const ctx = c.executionCtx;
			waitUntil = (promise) => ctx.waitUntil(promise);
		} catch {
			// テスト等 ExecutionContext が無い環境では await する。
		}
		return {
			store: deps.traceStore ?? createTraceStore(env) ?? fallbackTraceStore,
			...(env?.TRACE_FINGERPRINT_SECRET
				? { fingerprintSecret: env.TRACE_FINGERPRINT_SECRET }
				: {}),
			...(waitUntil ? { waitUntil } : {}),
		};
	};

	const app = new Hono<{ Bindings: Bindings }>();

	app.use("*", cors({ origin: "*", exposeHeaders: EXPOSED_HEADERS }));

	app.get("/health", (c) => c.json({ status: "ok" }));

	// Jev 呼び出し・D1 書き込みの前に IP / API key 単位で rate limit する。
	const rateLimit: MiddlewareHandler<{ Bindings: Bindings }> = async (
		c,
		next,
	) => {
		const env = c.env as Partial<Bindings> | undefined;
		const ip = deps.rateLimiters?.ip ?? env?.RATE_LIMIT_IP;
		const key = deps.rateLimiters?.key ?? env?.RATE_LIMIT_KEY;
		await enforceRateLimit(c.req.raw, {
			...(ip ? { ip } : {}),
			...(key ? { key } : {}),
			...(env?.TRACE_FINGERPRINT_SECRET
				? { fingerprintSecret: env.TRACE_FINGERPRINT_SECRET }
				: {}),
			periodSeconds: RATE_LIMIT_PERIOD_SECONDS,
		});
		await next();
	};
	app.use("/api/v1/*", rateLimit);
	app.use("/v1/*", rateLimit);

	app.post("/api/v1/auto-router/inspect", (c) =>
		handleInspect(c.req.raw, routingDeps(c)),
	);
	app.get("/api/v1/auto-router/traces/:traceId", (c) =>
		handleGetTrace(c.req.raw, c.req.param("traceId"), traceDeps(c)),
	);

	for (const prefix of ["/api/v1", "/v1"]) {
		app.post(`${prefix}/chat/completions`, (c) =>
			handleChatCompletions(c.req.raw, {
				upstream,
				...routingDeps(c),
				trace: traceDeps(c),
			}),
		);
		// model 一覧は generation endpoint ではないため OpenRouter の response をそのまま返す (#23)。
		// OpenAI 互換 client が接続確認・model 選択 UI で `GET {baseURL}/models` を呼ぶ。
		app.get(`${prefix}/models`, async (c) => {
			const upstreamRes = await forwardGetToOpenRouter(
				upstream,
				"/models",
				new URL(c.req.url).search,
				c.req.raw.headers,
				c.req.raw.signal,
			);
			return toClientResponse(upstreamRes);
		});
		// 未対応の endpoint は黙って proxy せず明示的にエラーにする。
		app.all(`${prefix}/*`, (c) => {
			throw new RouterError(
				"unsupported_endpoint",
				`auto-router does not support ${c.req.method} ${c.req.path}. Supported: POST ${prefix}/chat/completions, GET ${prefix}/models`,
				{ method: c.req.method, path: c.req.path },
			);
		});
	}

	app.onError((err, c) => {
		if (err instanceof RouterError) {
			return c.json(err.toBody(), err.status as 400, err.headers);
		}
		console.error("unhandled error", err instanceof Error ? err.message : err);
		return c.json(
			{
				error: {
					message: "Internal server error",
					type: "internal_error",
					code: "internal_error",
				},
			},
			500,
		);
	});

	return app;
};
