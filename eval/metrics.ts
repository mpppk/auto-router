import type { Capability } from "../src/core/capabilities";
import { classify, type Threshold } from "../src/semantic/detector";

/** 1 case × 1 capability の観測値。 */
export interface Observation {
	caseId: string;
	capability: Capability;
	gold: boolean;
	probability: number;
}

export interface CapabilityMetrics {
	capability: Capability;
	n: number;
	tp: number;
	fp: number;
	tn: number;
	fn: number;
	uncertain: number;
	precision: number;
	recall: number;
	falsePositiveRate: number;
	falseNegativeRate: number;
	uncertainRate: number;
	/** 誤判定 (uncertain を含む gold との不一致) の case id。 */
	errors: { caseId: string; gold: boolean; probability: number }[];
}

const ratio = (num: number, den: number) =>
	den === 0 ? Number.NaN : num / den;

/**
 * binary gold に対する threshold 性能。
 * `required` 判定のみを positive とし (MVP では uncertain は route に影響しないため)、
 * 中間帯は uncertain rate として別途計測する。
 */
export const computeMetrics = (
	capability: Capability,
	observations: readonly Observation[],
	threshold: Threshold,
): CapabilityMetrics => {
	const m = { tp: 0, fp: 0, tn: 0, fn: 0, uncertain: 0 };
	const errors: CapabilityMetrics["errors"] = [];
	const relevant = observations.filter((o) => o.capability === capability);
	for (const o of relevant) {
		const decision = classify(o.probability, threshold);
		if (decision === "uncertain") m.uncertain++;
		const predicted = decision === "required";
		if (predicted && o.gold) m.tp++;
		else if (predicted && !o.gold) m.fp++;
		else if (!predicted && o.gold) m.fn++;
		else m.tn++;
		const correct = o.gold
			? decision === "required"
			: decision === "not_required";
		if (!correct) {
			errors.push({
				caseId: o.caseId,
				gold: o.gold,
				probability: o.probability,
			});
		}
	}
	return {
		capability,
		n: relevant.length,
		...m,
		precision: ratio(m.tp, m.tp + m.fp),
		recall: ratio(m.tp, m.tp + m.fn),
		falsePositiveRate: ratio(m.fp, m.fp + m.tn),
		falseNegativeRate: ratio(m.fn, m.fn + m.tp),
		uncertainRate: ratio(m.uncertain, relevant.length),
		errors,
	};
};

export const formatRate = (value: number) =>
	Number.isNaN(value) ? "  -  " : value.toFixed(2).padStart(5);
