import type { FetchLike } from "../../src/upstream/openrouter";

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: string;
}

/** OpenRouter の代わりに request を記録し、固定のresponseを返す fake fetch。 */
export const createFakeUpstream = (
	respond: (req: RecordedRequest) => Response = () =>
		Response.json({ id: "gen-1", choices: [] }),
) => {
	const requests: RecordedRequest[] = [];
	const fetch: FetchLike = async (input, init) => {
		const req: RecordedRequest = {
			url: input,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : "",
		};
		requests.push(req);
		return respond(req);
	};
	return { fetch, requests };
};

export const sseResponse = (chunks: string[]) =>
	new Response(
		new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
