import type {
	Capability,
	SemanticRequirement,
	StructuralCapability,
	StructuralRequirement,
} from "../../src/core/capabilities";

export const required = (capability: Capability): SemanticRequirement => ({
	kind: "semantic",
	capability,
	decision: "required",
	requiredProbability: 0.95,
});

export const structural = (
	capability: StructuralCapability,
	source = "test",
): StructuralRequirement => ({ kind: "structural", capability, source });
