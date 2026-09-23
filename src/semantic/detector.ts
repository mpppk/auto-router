import {
	type Capability,
	SEMANTIC_CAPABILITIES,
	type SemanticDecision,
	type SemanticRequirement,
} from "../core/capabilities";
import { RouterError } from "../core/errors";
import type { RoutingContext } from "../core/types";
import { apiKeyFingerprint } from "../trace/fingerprint";
import { logRouterEvent } from "../trace/log";
import { type SemanticCache, semanticCacheKey } from "./cache";
import {
	buildSemanticContext,
	type SemanticContext,
	toJevState,
} from "./context";
import {
	JEV_MODEL,
	type JevClient,
	JevError,
	type JevFailureReason,
} from "./jev-client";
import { CAPABILITY_QUESTIONS } from "./questions";

export interface Threshold {
	/** p >= required → required */
	required: number;
	/** p <= notRequired → not_required */
	notRequired: number;
}

/** 暫定 threshold。#8 の eval で capability ごとに calibration する。 */
export const DEFAULT_THRESHOLD: Threshold = { required: 0.8, notRequired: 0.2 };

export type ThresholdConfig = Partial<Record<Capability, Threshold>>;

export const thresholdFor = (
	capability: Capability,
	config: ThresholdConfig = {},
): Threshold => config[capability] ?? DEFAULT_THRESHOLD;

/** Noul は Yes probability であり、程度ではないため `preferred` には分類しない。 */
export const classify = (p: number, threshold: Threshold): SemanticDecision => {
	if (p >= threshold.required) return "required";
	if (p <= threshold.notRequired) return "not_required";
	return "uncertain";
};

interface DetectionBase {
	requirements: SemanticRequirement[];
	/** Jev に渡した user / assistant message 数。 */
	messagesUsed: number;
	latencyMs?: number;
	/** cache が有効な場合の結果。hit なら Jev を呼んでいない。 */
	cache?: "hit" | "miss";
}

export type SemanticDetection =
	| (DetectionBase & { status: "ok" })
	/** 最新 user message が無いため判定しなかった。 */
	| (DetectionBase & { status: "skipped" })
	/** caller が header で semantic routing を無効化した (Jev を呼ばない)。 */
	| (DetectionBase & { status: "disabled" })
	/**
	 * Jev 障害。semantic requirement は空として扱い (model chain / tool 注入を変えない)、
	 * request 自体は fail させない。structural requirement には影響しない。
	 */
	| (DetectionBase & { status: "degraded"; reason: JevFailureReason });

export interface SemanticDetectorOptions {
	jev: JevClient;
	/** 判定結果の短期 cache (#26)。未指定なら毎回 Jev を呼ぶ。 */
	cache?: {
		store: SemanticCache;
		/** cache key の API key fingerprint 用 secret (`TRACE_FINGERPRINT_SECRET`)。 */
		fingerprintSecret?: string;
		/** Jev の model id (cache key に含める)。 */
		model?: string;
	};
	thresholds?: ThresholdConfig;
	capabilities?: readonly Capability[];
	now?: () => number;
}

export interface DetectOptions {
	apiKey: string;
	signal?: AbortSignal;
	/** この request で判定する capability を限定する (detector の capability との積集合)。 */
	capabilities?: readonly Capability[];
}

export interface SemanticDetector {
	detect(
		context: Pick<RoutingContext, "conversation" | "instructions">,
		options: DetectOptions,
	): Promise<SemanticDetection>;
}

export const toRequirements = (
	probabilities: Partial<Record<Capability, number>>,
	thresholds: ThresholdConfig = {},
): SemanticRequirement[] =>
	SEMANTIC_CAPABILITIES.flatMap((capability) => {
		const p = probabilities[capability];
		if (p === undefined) return [];
		return [
			{
				kind: "semantic",
				capability,
				requiredProbability: p,
				decision: classify(p, thresholdFor(capability, thresholds)),
			},
		];
	});

export const createSemanticDetector = (
	options: SemanticDetectorOptions,
): SemanticDetector => {
	const capabilities = options.capabilities ?? SEMANTIC_CAPABILITIES;
	const now = options.now ?? Date.now;

	return {
		async detect(context, { apiKey, signal, capabilities: scope }) {
			const semantic: SemanticContext = buildSemanticContext(context);
			const messagesUsed = semantic.conversation.length;
			if (semantic.latestUserMessage === undefined) {
				return { status: "skipped", requirements: [], messagesUsed };
			}
			const targets =
				scope === undefined
					? capabilities
					: capabilities.filter((c) => scope.includes(c));
			if (targets.length === 0) {
				return { status: "disabled", requirements: [], messagesUsed: 0 };
			}
			const questions = Object.fromEntries(
				targets.map((c) => [c, CAPABILITY_QUESTIONS[c]]),
			);

			const started = now();
			const state = toJevState(semantic);
			const cacheKey = options.cache
				? await semanticCacheKey({
						ownerFingerprint: await apiKeyFingerprint(
							apiKey,
							options.cache.fingerprintSecret,
						),
						model: options.cache.model ?? JEV_MODEL,
						state,
						questions,
					})
				: undefined;
			const cached =
				cacheKey === undefined
					? undefined
					: await options.cache?.store.get(cacheKey).catch(() => undefined);
			if (cached !== undefined && targets.every((c) => c in cached)) {
				return {
					status: "ok",
					requirements: toRequirements(cached, options.thresholds),
					messagesUsed,
					latencyMs: now() - started,
					cache: "hit",
				};
			}
			try {
				const probabilities = await options.jev.noul(state, questions, {
					apiKey,
					...(signal ? { signal } : {}),
				});
				if (cacheKey !== undefined) {
					// cache の書き込み失敗で request を失敗させない。
					await options.cache?.store
						.put(cacheKey, probabilities)
						.catch((err: unknown) =>
							console.warn(
								"failed to cache semantic detection",
								err instanceof Error ? err.message : err,
							),
						);
				}
				return {
					status: "ok",
					requirements: toRequirements(probabilities, options.thresholds),
					messagesUsed,
					latencyMs: now() - started,
					...(cacheKey !== undefined ? { cache: "miss" as const } : {}),
				};
			} catch (err) {
				const reason: JevFailureReason =
					err instanceof JevError ? err.reason : "jev_error";
				if (reason === "jev_unauthorized") {
					logRouterEvent({ event: "invalid_api_key", source: "jev" });
					// 不正な key は upstream でも必ず失敗するため、degraded で続行せず 401 にする。
					throw new RouterError(
						"invalid_api_key",
						"OpenRouter rejected the API key.",
					);
				}
				console.warn("semantic detection degraded", reason);
				return {
					status: "degraded",
					reason,
					requirements: [],
					messagesUsed,
					latencyMs: now() - started,
					...(cacheKey !== undefined ? { cache: "miss" as const } : {}),
				};
			}
		},
	};
};
