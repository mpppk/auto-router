import type { EffectiveRoutePlan } from "../core/types";

const sameChain = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((model, i) => model === b[i]);

/**
 * OpenRouter の `model` / `models` / `tools` / `tool_choice` / `provider` を持つ endpoint 共通の patch。
 * 元のrequestは変更せず、plan に必要なfieldだけを書き換えた新しいrequestを返す。
 * `toToolChoice` は planner の tool_choice (Chat Completions の意味) を endpoint 固有形式に変換する。
 */
export const applyCommonRoutePlan = <T extends Record<string, unknown>>(
	request: T,
	plan: EffectiveRoutePlan,
	requestedChain: readonly string[],
	toToolChoice: (value: unknown, original: unknown) => unknown,
): T => {
	const patched: Record<string, unknown> = { ...request };

	if (!sameChain(plan.modelChain, requestedChain)) {
		const [primary, ...fallbacks] = plan.modelChain;
		if (primary === undefined) {
			delete patched.model;
		} else {
			patched.model = primary;
		}
		if (fallbacks.length > 0) {
			patched.models = fallbacks;
		} else {
			delete patched.models;
		}
	}
	if (plan.tools !== undefined) patched.tools = plan.tools;
	if (plan.toolChoice !== undefined) {
		patched.tool_choice = toToolChoice(
			plan.toolChoice.value,
			request.tool_choice,
		);
	}
	if (plan.provider !== undefined) patched.provider = plan.provider;

	return patched as T;
};
