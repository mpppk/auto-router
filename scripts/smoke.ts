/**
 * deploy 後の本番 endpoint に対する smoke test (#28)。
 * Bun の unit test では検証できない Workers runtime (workerd) 上の挙動
 * (AbortSignal.any / crypto.subtle / Cache API / KV / D1 / waitUntil) を実環境で確認する。
 *
 *   SMOKE_BASE_URL=https://auto-router.<subdomain>.workers.dev OPENROUTER_API_KEY=... bun run smoke
 *
 * 1つでも失敗すれば exit code 1。
 */
const baseUrl = (process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.OPENROUTER_API_KEY;
if (baseUrl === "" || !apiKey) {
	console.error("SMOKE_BASE_URL and OPENROUTER_API_KEY are required");
	process.exit(1);
}

/** upstream LLM を呼ぶ check で使う安価な model。 */
const CHEAP_MODEL = "openai/gpt-5-nano";
const auth = { authorization: `Bearer ${apiKey}` };

const check = async (name: string, fn: () => Promise<string | undefined>) => {
	const started = Date.now();
	try {
		const detail = await fn();
		console.log(
			`ok   ${name} (${Date.now() - started}ms)${detail ? ` ${detail}` : ""}`,
		);
		return true;
	} catch (err) {
		console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
		return false;
	}
};

const expectOk = async (res: Response, label: string) => {
	if (!res.ok) {
		throw new Error(
			`${label} returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
		);
	}
};

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [
	await check("GET /health", async () => {
		const res = await fetch(`${baseUrl}/health`);
		await expectOk(res, "health");
		const body = (await res.json()) as { status?: string };
		assert(body.status === "ok", `unexpected body ${JSON.stringify(body)}`);
		return undefined;
	}),

	await check("GET /api/v1/models", async () => {
		const res = await fetch(`${baseUrl}/api/v1/models`);
		await expectOk(res, "models");
		const body = (await res.json()) as { data?: unknown[] };
		assert(Array.isArray(body.data) && body.data.length > 0, "no models");
		return `${body.data?.length} models`;
	}),

	// Jev (AbortSignal.any / crypto.subtle / Cache API) と KV の model catalog を通る。upstream LLM は呼ばない。
	await check("POST /api/v1/auto-router/inspect (Jev + catalog)", async () => {
		const res = await fetch(`${baseUrl}/api/v1/auto-router/inspect`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-5",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "Xで今Claude Codeについてどんな反応がありますか？",
							},
							{
								type: "image_url",
								image_url: { url: "https://example.com/a.png" },
							},
						],
					},
				],
			}),
		});
		await expectOk(res, "inspect");
		const { trace } = (await res.json()) as {
			trace: {
				semanticStatus: string;
				reason: string;
				candidates: { support?: { capability: string; support: string }[] }[];
			};
		};
		assert(
			trace.semanticStatus === "ok",
			`semantic detection is ${trace.semanticStatus}`,
		);
		assert(
			trace.reason === "capability_override",
			`unexpected route reason ${trace.reason}`,
		);
		// catalog が読めていれば input.image の support が unknown にならない
		const imageSupport = trace.candidates
			.flatMap((c) => c.support ?? [])
			.filter((s) => s.capability === "input.image")
			.map((s) => s.support);
		assert(
			imageSupport.length > 0 && !imageSupport.includes("unknown"),
			`model catalog is not loaded (input.image support: ${imageSupport.join(",")})`,
		);
		return trace.reason;
	}),

	// upstream proxy と D1 への trace 書き込み (waitUntil)・読み出し。
	await check("POST /api/v1/chat/completions + GET trace (D1)", async () => {
		const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
			method: "POST",
			headers: {
				...auth,
				"content-type": "application/json",
				"Auto-Router-Semantic": "off",
				"X-Title": "auto-router smoke test",
			},
			body: JSON.stringify({
				model: CHEAP_MODEL,
				messages: [{ role: "user", content: "Reply with OK." }],
				max_tokens: 16,
			}),
		});
		await expectOk(res, "chat completions");
		await res.body?.cancel();
		const traceId = res.headers.get("Auto-Router-Trace-Id");
		assert(traceId, "Auto-Router-Trace-Id header is missing");
		// trace は response 返却後に waitUntil で書き込まれる。
		for (let attempt = 0; attempt < 5; attempt++) {
			const traceRes = await fetch(
				`${baseUrl}/api/v1/auto-router/traces/${traceId}`,
				{
					headers: auth,
				},
			);
			if (traceRes.ok) {
				const trace = (await traceRes.json()) as { id: string };
				assert(trace.id === traceId, "trace id mismatch");
				return traceId ?? undefined;
			}
			if (traceRes.status !== 404) await expectOk(traceRes, "trace");
			await sleep(1000 * (attempt + 1));
		}
		throw new Error(`trace ${traceId} was not stored`);
	}),

	await check("unsupported endpoint returns 404", async () => {
		const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
			method: "POST",
			headers: auth,
			body: "{}",
		});
		assert(res.status === 404, `unexpected status ${res.status}`);
		return undefined;
	}),
];

if (results.includes(false)) process.exit(1);

export {};
