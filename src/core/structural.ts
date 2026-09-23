import type {
	StructuralCapability,
	StructuralRequirement,
} from "./capabilities";
import type { ProviderPreferences } from "./provider";
import { PARAMETER_CAPABILITIES } from "./registry";
import type { RequestFeatures } from "./types";

const CONTENT_PART_CAPABILITY: Record<string, StructuralCapability> = {
	image_url: "input.image",
	input_image: "input.image",
	image: "input.image",
	input_audio: "input.audio",
	audio: "input.audio",
	video_url: "input.video",
	input_video: "input.video",
	video: "input.video",
	file: "input.file",
	input_file: "input.file",
	// Anthropic Messages の PDF 等
	document: "input.file",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * caller 定義の tool (model が tool calling に対応している必要がある) か。
 * Chat Completions / Responses は `type: "function"`、Anthropic Messages は
 * `type` 無し (または `"custom"`) で `input_schema` を持つ。
 */
const isFunctionTool = (tool: unknown) =>
	isRecord(tool) &&
	(tool.type === "function" ||
		tool.type === "custom" ||
		(tool.type === undefined && isRecord(tool.input_schema)));

const reasoningRequested = (features: RequestFeatures): boolean => {
	const { reasoning, reasoningEffort, includeReasoning } = features;
	if (isRecord(reasoning)) {
		const disabled = reasoning.enabled === false || reasoning.effort === "none";
		if (!disabled) return true;
	}
	if (typeof reasoningEffort === "string" && reasoningEffort !== "none") {
		return true;
	}
	return includeReasoning === true;
};

export interface StructuralAnalysis {
	requirements: StructuralRequirement[];
	/** caller の provider 設定 (緩和せず保持する)。 */
	provider?: ProviderPreferences;
	/** planner が `provider.require_parameters=true` を強制すべきか。 */
	requireParameters: boolean;
}

/** Jev を使わず request 構造から決定的に requirement を抽出する。 */
export const detectStructuralRequirements = (
	features: RequestFeatures,
): StructuralAnalysis => {
	const requirements: StructuralRequirement[] = [];
	const add = (capability: StructuralCapability, source: string) => {
		if (!requirements.some((r) => r.capability === capability)) {
			requirements.push({ kind: "structural", capability, source });
		}
	};

	for (const part of features.contentParts) {
		const capability = CONTENT_PART_CAPABILITY[part.type];
		if (capability !== undefined) add(capability, part.path);
	}

	if (features.tools?.some(isFunctionTool)) add("tools", "tools");

	if (isRecord(features.responseFormat)) {
		if (features.responseFormat.type === "json_schema") {
			add("structured_output", "response_format");
		} else if (features.responseFormat.type === "json_object") {
			add("json_output", "response_format");
		}
	}

	if (reasoningRequested(features)) add("reasoning", "reasoning");

	return {
		requirements,
		...(features.provider !== undefined ? { provider: features.provider } : {}),
		requireParameters: requirements.some((r) =>
			PARAMETER_CAPABILITIES.has(r.capability),
		),
	};
};
