import {
	type Capability,
	SEMANTIC_CAPABILITIES,
	type SemanticDecision,
	type SemanticRequirement,
} from "../core/capabilities";
import type { RoutingContext } from "../core/types";
import {
	buildSemanticContext,
	type SemanticContext,
	toJevState,
} from "./context";
import { type JevClient, JevError, type JevFailureReason } from "./jev-client";
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
}

export type SemanticDetection =
	| (DetectionBase & { status: "ok" })
	/** 最新 user message が無いため判定しなかった。 */
	| (DetectionBase & { status: "skipped" })
	/**
	 * Jev 障害。semantic requirement は空として扱い (model chain / tool 注入を変えない)、
	 * request 自体は fail させない。structural requirement には影響しない。
	 */
	| (DetectionBase & { status: "degraded"; reason: JevFailureReason });

export interface SemanticDetectorOptions {
	jev: JevClient;
	thresholds?: ThresholdConfig;
	capabilities?: readonly Capability[];
	now?: () => number;
}

export interface SemanticDetector {
	detect(
		context: Pick<RoutingContext, "conversation" | "instructions">,
		options: { apiKey: string; signal?: AbortSignal },
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
	const questions = Object.fromEntries(
		capabilities.map((c) => [c, CAPABILITY_QUESTIONS[c]]),
	);

	return {
		async detect(context, { apiKey, signal }) {
			const semantic: SemanticContext = buildSemanticContext(context);
			const messagesUsed = semantic.conversation.length;
			if (semantic.latestUserMessage === undefined) {
				return { status: "skipped", requirements: [], messagesUsed };
			}

			const started = now();
			try {
				const probabilities = await options.jev.noul(
					toJevState(semantic),
					questions,
					{ apiKey, ...(signal ? { signal } : {}) },
				);
				return {
					status: "ok",
					requirements: toRequirements(probabilities, options.thresholds),
					messagesUsed,
					latencyMs: now() - started,
				};
			} catch (err) {
				const reason: JevFailureReason =
					err instanceof JevError ? err.reason : "jev_error";
				console.warn("semantic detection degraded", reason);
				return {
					status: "degraded",
					reason,
					requirements: [],
					messagesUsed,
					latencyMs: now() - started,
				};
			}
		},
	};
};
