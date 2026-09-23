import type { ModelCatalogSource } from "../catalog/model-catalog";
import type { RequestedModelChain } from "../core/model-chain";
import { type RouteResolution, resolveRoute } from "../core/resolver";
import {
	detectStructuralRequirements,
	type StructuralAnalysis,
} from "../core/structural";
import type { RoutingContext } from "../core/types";
import type { SemanticDetection, SemanticDetector } from "../semantic/detector";

export interface RoutingDeps {
	detector: SemanticDetector;
	catalog: ModelCatalogSource;
	now?: () => number;
}

export interface RoutingDecision {
	resolution: RouteResolution;
	semantic: SemanticDetection;
	structural: StructuralAnalysis;
	latencyMs: { jev?: number; routing: number };
}

/**
 * routing core の入口。endpoint 固有形式・Hono には依存しない。
 * semantic (Jev) と structural requirements を集め、resolver で effective route を決める。
 */
export const decideRoute = async (
	input: {
		context: RoutingContext;
		requestedChain: RequestedModelChain;
		allowModelOverride: boolean;
		apiKey: string;
		signal?: AbortSignal;
	},
	deps: RoutingDeps,
): Promise<RoutingDecision> => {
	const now = deps.now ?? Date.now;
	const started = now();
	const structural = detectStructuralRequirements(input.context.features);
	const [semantic, catalog] = await Promise.all([
		deps.detector.detect(input.context, {
			apiKey: input.apiKey,
			...(input.signal ? { signal: input.signal } : {}),
		}),
		deps.catalog.load(),
	]);

	const resolution = resolveRoute({
		requestedChain: input.requestedChain,
		semanticRequirements: semantic.requirements,
		semanticDegraded: semantic.status === "degraded",
		structural,
		features: input.context.features,
		catalog,
		allowModelOverride: input.allowModelOverride,
	});

	return {
		resolution,
		semantic,
		structural,
		latencyMs: {
			...(semantic.latencyMs !== undefined ? { jev: semantic.latencyMs } : {}),
			routing: now() - started,
		},
	};
};
