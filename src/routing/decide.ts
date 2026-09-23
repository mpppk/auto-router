import type { ModelCatalogSource } from "../catalog/model-catalog";
import {
	applyCapabilityDegrades,
	type Capability,
	type CapabilityDegrade,
} from "../core/capabilities";
import type { RequestedModelChain } from "../core/model-chain";
import { type RouteResolution, resolveRoute } from "../core/resolver";
import {
	detectStructuralRequirements,
	type StructuralAnalysis,
} from "../core/structural";
import type { RequestFeatures, RoutingContext } from "../core/types";
import type { SemanticOptions } from "../http/router-options";
import type { SemanticDetection, SemanticDetector } from "../semantic/detector";

export interface RoutingDeps {
	detector: SemanticDetector;
	catalog: ModelCatalogSource;
	/** capability default route の上書き。未指定なら registry の既定値。 */
	defaultRouteModels?: readonly string[];
	now?: () => number;
}

export interface RoutingDecision {
	resolution: RouteResolution;
	semantic: SemanticDetection;
	structural: StructuralAnalysis;
	features: RequestFeatures;
	/** 最新 user message 以降の assistant tool call 数 (agent loop のターン)。 */
	agentLoopTurns: number;
	/** 実際に適用した capability degrade (`Auto-Router-Allow-Capability-Degrade`)。 */
	capabilityDegrades: CapabilityDegrade[];
	/** caller が `Auto-Router-Capabilities` で限定した semantic capability。 */
	semanticScope?: Capability[];
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
		/** 未指定なら全 semantic capability を判定する。 */
		semantic?: SemanticOptions;
		/** caller が許可した capability degrade。 */
		capabilityDegrades?: readonly CapabilityDegrade[];
		apiKey: string;
		signal?: AbortSignal;
	},
	deps: RoutingDeps,
): Promise<RoutingDecision> => {
	const now = deps.now ?? Date.now;
	const started = now();
	const structural = detectStructuralRequirements(input.context.features);
	const options = input.semantic ?? { enabled: true };
	const [semantic, catalog] = await Promise.all([
		options.enabled
			? deps.detector.detect(input.context, {
					apiKey: input.apiKey,
					...(input.signal ? { signal: input.signal } : {}),
					...(options.capabilities
						? { capabilities: options.capabilities }
						: {}),
				})
			: Promise.resolve<SemanticDetection>({
					status: "disabled",
					requirements: [],
					messagesUsed: 0,
				}),
		deps.catalog.load(),
	]);

	const degraded = applyCapabilityDegrades(
		semantic.requirements,
		input.capabilityDegrades ?? [],
	);
	const resolution = resolveRoute({
		requestedChain: input.requestedChain,
		semanticRequirements: degraded.requirements,
		semanticDegraded: semantic.status === "degraded",
		structural,
		features: input.context.features,
		catalog,
		allowModelOverride: input.allowModelOverride,
		...(deps.defaultRouteModels
			? { defaultRouteModels: deps.defaultRouteModels }
			: {}),
	});

	return {
		resolution,
		semantic,
		structural,
		features: input.context.features,
		agentLoopTurns: input.context.agentLoopTurns,
		capabilityDegrades: degraded.applied,
		...(options.enabled && options.capabilities
			? { semanticScope: options.capabilities }
			: {}),
		latencyMs: {
			...(semantic.latencyMs !== undefined ? { jev: semantic.latencyMs } : {}),
			routing: now() - started,
		},
	};
};
