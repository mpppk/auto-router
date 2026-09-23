import { type Bindings, createApp } from "./app";
import { runScheduled } from "./scheduled";

const app = createApp();

// entry module の named export は workerd の entrypoint として扱われるため、default export のみにする。
export default {
	fetch: app.fetch,
	async scheduled(controller, env) {
		await runScheduled(controller.cron, env);
	},
} satisfies ExportedHandler<Bindings>;
