import type { ModelProfile } from "../catalog/model-catalog";
import type { Capability, StructuralCapability } from "./capabilities";

export type Support = "supported" | "unsupported" | "unknown";

export const WEB_SEARCH_TOOL_TYPE = "openrouter:web_search";

/** server tool の1 parameter について、caller の値とHard Requirementをどうmergeするか。 */
export type ParameterMerge = (
	callerValue: unknown,
) => { value: unknown } | { conflict: string };

/** Hard Requirement を満たすために effective request へ必要な OpenRouter server tool。 */
export interface ServerToolRequirement {
	type: string;
	/** key ごとの merge 規則。caller が未指定なら補完し、意味を変える必要があれば conflict。 */
	parameters: Record<string, ParameterMerge>;
}

/** capability を満たす既定の実行route。MVP では1 model。 */
export interface ExecutionRouteTemplate {
	model: string;
}

export interface CapabilityDefinition<C extends string = string> {
	capability: C;
	detection: "semantic" | "structural" | "policy";
	routing: "model" | "provider" | "tool" | "harness";
	description: string;
	/** candidate model がこの capability を提供できるか。 */
	support(modelId: string, profile: ModelProfile | undefined): Support;
	serverTool?: ServerToolRequirement;
	/** capability の実行に必要な provider (いずれか)。caller の provider 制約と両立しなければ conflict。 */
	providers?: string[];
	defaultRoute?: ExecutionRouteTemplate;
}

/**
 * `engine` は native search が必要。`auto` は native を持つ model では native が選ばれるため
 * 意味を変えずに native へ確定できるが、他 engine の明示指定は caller の意味を変えるので conflict。
 */
const requireNativeEngine: ParameterMerge = (callerValue) =>
	callerValue === undefined ||
	callerValue === "auto" ||
	callerValue === "native"
		? { value: "native" }
		: {
				conflict: `web_search engine "${String(callerValue)}" cannot search X; "native" is required`,
			};

/** `x_search` は opt-in object。caller の filter (handle / 日付等) はそのまま保持する。 */
const requireXSearchObject: ParameterMerge = (callerValue) => {
	if (callerValue === undefined) return { value: {} };
	if (typeof callerValue === "object" && callerValue !== null) {
		return { value: callerValue };
	}
	return {
		conflict: "web_search x_search must be an object to enable X search",
	};
};

/** Grok 4 以降 (x_search 対応) の model か。`multi-agent` 版は tool 非対応のため除外する。 */
export const isGrok4OrLater = (modelId: string): boolean => {
	const base = modelId.split(":")[0] ?? "";
	if (base === "~x-ai/grok-latest") return true;
	const match = /^x-ai\/grok-(\d+)(?:\.\d+)?(-.*)?$/.exec(base);
	if (match === null) return false;
	return Number(match[1]) >= 4 && !(match[2] ?? "").includes("multi-agent");
};

const hasParameter =
	(...parameters: string[]) =>
	(_modelId: string, profile: ModelProfile | undefined): Support => {
		if (profile === undefined) return "unknown";
		return parameters.some((p) => profile.supportedParameters.includes(p))
			? "supported"
			: "unsupported";
	};

const hasModality =
	(modality: string) =>
	(_modelId: string, profile: ModelProfile | undefined): Support => {
		if (profile === undefined) return "unknown";
		return profile.inputModalities.includes(modality)
			? "supported"
			: "unsupported";
	};

const unsupported = (): Support => "unsupported";

/** X Search / Web Search の既定 model。 */
export const DEFAULT_GROK_MODEL = "x-ai/grok-4.7";

const placesDefinition = (
	capability: Capability,
	description: string,
): CapabilityDefinition<Capability> => ({
	capability,
	detection: "semantic",
	routing: "harness",
	description,
	// taxonomy は保持するが MVP では実行routeを持たない。Web Search へ silent degrade しない。
	support: unsupported,
});

export const SEMANTIC_REGISTRY: Record<
	Capability,
	CapabilityDefinition<Capability>
> = {
	"web.search": {
		capability: "web.search",
		detection: "semantic",
		routing: "tool",
		description: "Search the web for current or external information.",
		// openrouter:web_search は tool calling 可能な model で利用できる。
		// default route の Grok は catalog が取得できなくても native search で対応する。
		support: (modelId, profile) =>
			isGrok4OrLater(modelId)
				? "supported"
				: hasParameter("tools")(modelId, profile),
		serverTool: { type: WEB_SEARCH_TOOL_TYPE, parameters: {} },
		defaultRoute: { model: DEFAULT_GROK_MODEL },
	},
	"social.x.search": {
		capability: "social.x.search",
		detection: "semantic",
		routing: "model",
		description: "Search posts on X (Twitter).",
		support: (modelId) =>
			isGrok4OrLater(modelId) ? "supported" : "unsupported",
		serverTool: {
			type: WEB_SEARCH_TOOL_TYPE,
			parameters: {
				engine: requireNativeEngine,
				x_search: requireXSearchObject,
			},
		},
		// X Search は xAI の native search でのみ実行できる。
		providers: ["xai"],
		defaultRoute: { model: DEFAULT_GROK_MODEL },
	},
	"places.search": placesDefinition("places.search", "Search places / POIs."),
	"places.opening_hours": placesDefinition(
		"places.opening_hours",
		"Current opening hours of places.",
	),
	"places.reviews": placesDefinition("places.reviews", "Reviews of places."),
	"geo.proximity": placesDefinition(
		"geo.proximity",
		"Distance / proximity from a location.",
	),
	"source.google_maps": placesDefinition(
		"source.google_maps",
		"Google Maps as the data source.",
	),
};

export const STRUCTURAL_REGISTRY: Record<
	StructuralCapability,
	CapabilityDefinition<StructuralCapability>
> = {
	"input.image": {
		capability: "input.image",
		detection: "structural",
		routing: "model",
		description: "Image input in messages.",
		support: hasModality("image"),
	},
	"input.audio": {
		capability: "input.audio",
		detection: "structural",
		routing: "model",
		description: "Audio input in messages.",
		support: hasModality("audio"),
	},
	"input.video": {
		capability: "input.video",
		detection: "structural",
		routing: "model",
		description: "Video input in messages.",
		support: hasModality("video"),
	},
	"input.file": {
		capability: "input.file",
		detection: "structural",
		routing: "model",
		description: "File (e.g. PDF) input in messages.",
		support: hasModality("file"),
	},
	tools: {
		capability: "tools",
		detection: "structural",
		routing: "provider",
		description: "Caller function tools / tool_choice.",
		support: hasParameter("tools"),
	},
	structured_output: {
		capability: "structured_output",
		detection: "structural",
		routing: "provider",
		description: "response_format json_schema.",
		support: hasParameter("structured_outputs"),
	},
	json_output: {
		capability: "json_output",
		detection: "structural",
		routing: "provider",
		description: "response_format json_object.",
		support: hasParameter("response_format", "structured_outputs"),
	},
	reasoning: {
		capability: "reasoning",
		detection: "structural",
		routing: "provider",
		description: "Reasoning parameters.",
		support: hasParameter("reasoning", "include_reasoning"),
	},
	"context.long": {
		capability: "context.long",
		detection: "structural",
		routing: "model",
		description: "Long-context requirement (reserved).",
		support: () => "unknown",
	},
};

/**
 * provider parameter support が必要な structural capability。
 * これらが Hard Requirement のとき planner は `provider.require_parameters=true` を強制する。
 */
export const PARAMETER_CAPABILITIES: ReadonlySet<StructuralCapability> =
	new Set(["tools", "structured_output", "json_output", "reasoning"]);
