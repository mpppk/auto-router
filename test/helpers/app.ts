import { type AppDeps, createApp } from "../../src/app";
import {
	createStaticModelCatalog,
	type ModelProfile,
} from "../../src/catalog/model-catalog";
import type { Capability } from "../../src/core/capabilities";
import {
	type DetectOptions,
	type SemanticDetection,
	type SemanticDetector,
	toRequirements,
} from "../../src/semantic/detector";
import type { JevFailureReason } from "../../src/semantic/jev-client";
import { createMemoryTraceStore } from "../../src/trace/store";
import { createFakeUpstream } from "./fake-upstream";

export const UPSTREAM_BASE = "https://openrouter.test/api/v1";

export type FakeSemantic =
	| Partial<Record<Capability, number>>
	| { degraded: JevFailureReason };

/** Jev の代わりに固定の probability (または障害) を返す detector。 */
export const fakeDetector = (
	semantic: FakeSemantic = {},
): SemanticDetector & {
	calls: number;
	scopes: (readonly Capability[] | undefined)[];
} => {
	const detector = {
		calls: 0,
		scopes: [] as (readonly Capability[] | undefined)[],
		async detect(
			context: { conversation: unknown[] },
			options: DetectOptions,
		): Promise<SemanticDetection> {
			detector.calls++;
			detector.scopes.push(options.capabilities);
			const messagesUsed = Math.min(context.conversation.length, 12);
			if ("degraded" in semantic && typeof semantic.degraded === "string") {
				return {
					status: "degraded",
					reason: semantic.degraded,
					requirements: [],
					messagesUsed,
					latencyMs: 1,
				};
			}
			const scope = options.capabilities;
			const probabilities = Object.fromEntries(
				Object.entries(semantic).filter(
					([c]) => scope === undefined || scope.includes(c as Capability),
				),
			) as Partial<Record<Capability, number>>;
			return {
				status: "ok",
				requirements: toRequirements(probabilities),
				messagesUsed,
				latencyMs: 1,
			};
		},
	};
	return detector;
};

export const MODEL_PROFILES: ModelProfile[] = [
	{
		id: "x-ai/grok-4.7",
		inputModalities: ["text", "image", "file"],
		supportedParameters: [
			"tools",
			"tool_choice",
			"structured_outputs",
			"response_format",
			"reasoning",
		],
	},
	{
		// default route の fallback (DEFAULT_GROK_MODELS)
		id: "x-ai/grok-4.6",
		inputModalities: ["text", "image", "file"],
		supportedParameters: [
			"tools",
			"tool_choice",
			"structured_outputs",
			"response_format",
			"reasoning",
		],
	},
	{
		id: "anthropic/claude-sonnet-5",
		inputModalities: ["text", "image", "file"],
		supportedParameters: [
			"tools",
			"tool_choice",
			"structured_outputs",
			"response_format",
			"reasoning",
		],
	},
	{
		id: "openai/gpt-5",
		inputModalities: ["text", "image", "file"],
		supportedParameters: [
			"tools",
			"tool_choice",
			"structured_outputs",
			"response_format",
			"reasoning",
		],
	},
	{
		id: "text/no-tools",
		inputModalities: ["text"],
		supportedParameters: ["temperature"],
	},
];

export const createTestApp = (
	options: {
		semantic?: FakeSemantic;
		profiles?: ModelProfile[];
		respond?: Parameters<typeof createFakeUpstream>[0];
		rateLimiters?: AppDeps["rateLimiters"];
		detector?: SemanticDetector;
	} = {},
) => {
	const upstream = createFakeUpstream(options.respond);
	const fake = fakeDetector(options.semantic);
	const detector = options.detector ?? fake;
	const catalog = createStaticModelCatalog(options.profiles ?? MODEL_PROFILES);
	const traceStore = createMemoryTraceStore();
	const app = createApp({
		upstream: { baseUrl: UPSTREAM_BASE, fetch: upstream.fetch },
		detector,
		catalog: { load: async () => catalog },
		traceStore,
		...(options.rateLimiters ? { rateLimiters: options.rateLimiters } : {}),
	});
	return { app, upstream, detector: fake, traceStore };
};
