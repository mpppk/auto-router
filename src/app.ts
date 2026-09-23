import { Hono } from "hono";

export const createApp = () => {
	const app = new Hono<{ Bindings: Env }>();

	app.get("/health", (c) => c.json({ status: "ok" }));

	return app;
};
