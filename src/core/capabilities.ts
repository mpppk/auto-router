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

/** caller が明示的に許可した capability の置き換え (#25)。 */
export interface CapabilityDegrade {
	from: Capability;
	to: Capability;
}

/**
 * opt-in で degrade してよい組み合わせ。
 * Places 系は通常の Web Search でも実用的に答えられることが多いため `web.search` への degrade を許可する。
 * `source.google_maps` は source 指定が明確 (Google Maps のデータが必要) なので degrade 対象外。
 */
export const ALLOWED_CAPABILITY_DEGRADES: Partial<
	Record<Capability, readonly Capability[]>
> = {
	"places.search": ["web.search"],
	"places.opening_hours": ["web.search"],
	"places.reviews": ["web.search"],
	"geo.proximity": ["web.search"],
};

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

/**
 * caller が許可した degrade を semantic requirements に適用する。
 * required な `from` を取り除き、代わりに `to` を required にする (確率は `from` と既存の `to` の大きい方)。
 * required でない `from` や、許可されていない capability には何もしない。
 */
export const applyCapabilityDegrades = (
	requirements: readonly SemanticRequirement[],
	degrades: readonly CapabilityDegrade[],
): { requirements: SemanticRequirement[]; applied: CapabilityDegrade[] } => {
	const applied = degrades.filter((d) =>
		requirements.some(
			(r) => r.capability === d.from && r.decision === "required",
		),
	);
	if (applied.length === 0) return { requirements: [...requirements], applied };

	const from = new Set(applied.map((d) => d.from));
	const result = requirements.filter((r) => !from.has(r.capability));
	for (const d of applied) {
		const source = requirements.find((r) => r.capability === d.from);
		const p = source?.requiredProbability ?? 1;
		const index = result.findIndex((r) => r.capability === d.to);
		const existing = result[index];
		const upgraded: SemanticRequirement = {
			kind: "semantic",
			capability: d.to,
			decision: "required",
			requiredProbability: Math.max(p, existing?.requiredProbability ?? 0),
		};
		if (existing === undefined) result.push(upgraded);
		else result[index] = upgraded;
	}
	return { requirements: result, applied };
};
