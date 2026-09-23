import { type Bindings, createApp, createTraceStore } from "./app";

const app = createApp();

export default {
	fetch: app.fetch,
	/** 期限切れ routing trace を削除する (wrangler.jsonc の cron trigger)。 */
	async scheduled(_controller, env) {
		await createTraceStore(env)?.deleteExpired(Date.now());
	},
} satisfies ExportedHandler<Bindings>;
