import { Hono } from "hono";
import { cors } from "hono/cors";
import { RouterError } from "./core/errors";
import { handleChatCompletions } from "./http/chat-completions";
import {
	DEFAULT_OPENROUTER_BASE_URL,
	type UpstreamConfig,
} from "./upstream/openrouter";

export interface AppDeps {
	upstream?: Partial<UpstreamConfig>;
}

/** browser から読めるようにする auto-router 独自response header。 */
export const EXPOSED_HEADERS = [
	"Auto-Router-Trace-Id",
	"Auto-Router-Requested-Model",
	"Auto-Router-Selected-Model",
	"Auto-Router-Route-Reason",
	"Auto-Router-Degraded",
];

export const createApp = (deps: AppDeps = {}) => {
	const upstream: UpstreamConfig = {
		baseUrl: deps.upstream?.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
		fetch: deps.upstream?.fetch ?? ((input, init) => fetch(input, init)),
	};

	const app = new Hono<{ Bindings: Env }>();

	app.use("*", cors({ origin: "*", exposeHeaders: EXPOSED_HEADERS }));

	app.get("/health", (c) => c.json({ status: "ok" }));

	for (const prefix of ["/api/v1", "/v1"]) {
		app.post(`${prefix}/chat/completions`, (c) =>
			handleChatCompletions(c.req.raw, { upstream }),
		);
		// 未対応の endpoint は黙って proxy せず明示的にエラーにする。
		app.all(`${prefix}/*`, (c) => {
			throw new RouterError(
				"unsupported_endpoint",
				`auto-router does not support ${c.req.method} ${c.req.path}. Supported: POST ${prefix}/chat/completions`,
				{ method: c.req.method, path: c.req.path },
			);
		});
	}

	app.onError((err, c) => {
		if (err instanceof RouterError) {
			return c.json(err.toBody(), err.status as 400);
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
