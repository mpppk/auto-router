import {
	type Capability,
	SEMANTIC_CAPABILITIES,
} from "../src/core/capabilities";
import {
	DEFAULT_THRESHOLD,
	type ThresholdConfig,
} from "../src/semantic/detector";

/** `capability=required[,notRequired]` 形式の CLI 引数を parse する。 */
export const parseThresholds = (specs: readonly string[]): ThresholdConfig => {
	const config: ThresholdConfig = {};
	for (const spec of specs) {
		const [capability, range] = spec.split("=");
		const [required, notRequired] = (range ?? "").split(",").map(Number);
		if (
			!SEMANTIC_CAPABILITIES.includes(capability as Capability) ||
			required === undefined ||
			Number.isNaN(required)
		) {
			throw new Error(
				`invalid --threshold ${spec} (capability=required[,notRequired])`,
			);
		}
		config[capability as Capability] = {
			required,
			notRequired: notRequired ?? DEFAULT_THRESHOLD.notRequired,
		};
	}
	return config;
};
