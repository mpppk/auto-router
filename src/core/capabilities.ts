/** Jev で「必須か」を判定する semantic capability。 */
export const SEMANTIC_CAPABILITIES = [
	"social.x.search",
	"web.search",
	"places.search",
	"places.opening_hours",
	"places.reviews",
	"geo.proximity",
	"source.google_maps",
] as const;

export type Capability = (typeof SEMANTIC_CAPABILITIES)[number];

/** request 構造から決定的に抽出する capability。 */
export const STRUCTURAL_CAPABILITIES = [
	"input.image",
	"input.audio",
	"input.video",
	"input.file",
	"tools",
	"structured_output",
	"json_output",
	"reasoning",
	/** 将来の long-context requirement 用。MVP では検出しない。 */
	"context.long",
] as const;

export type StructuralCapability = (typeof STRUCTURAL_CAPABILITIES)[number];

/**
 * Jev Noul の Yes probability に対する分類。
 * Noul は程度ではなく確率なので `preferred` という解釈は行わない。
 */
export type SemanticDecision = "required" | "uncertain" | "not_required";

export interface SemanticRequirement {
	kind: "semantic";
	capability: Capability;
	decision: SemanticDecision;
	requiredProbability: number;
}

export interface StructuralRequirement {
	kind: "structural";
	capability: StructuralCapability;
	/** requirement の由来 (例: `messages[0].content[1]`, `response_format`)。trace / debug 用。 */
	source: string;
}

export type Requirement = SemanticRequirement | StructuralRequirement;

/**
 * Hard Requirements = semantic decision が required のもの + 全 structural requirements。
 * `uncertain` は MVP では route 選択に影響させない。
 */
export const hardRequirements = (
	requirements: readonly Requirement[],
): Requirement[] =>
	requirements.filter(
		(r) => r.kind === "structural" || r.decision === "required",
	);

/** 重複を除いた capability 一覧。 */
export const capabilitiesOf = (requirements: readonly Requirement[]) => [
	...new Set(requirements.map((r) => r.capability)),
];
