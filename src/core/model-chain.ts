/** 優先順付きのmodel候補列。先頭がprimary、以降がfallback。 */
export type RequestedModelChain = string[];

/**
 * OpenRouter の `model` / `models` を優先順付き候補列へ正規化する。
 *
 * - model のみ → [model]
 * - models のみ → models
 * - model + models → [model, ...models]
 *
 * 重複は先に出現した位置を残して除去する。
 */
export const normalizeModelChain = (
	model: string | undefined,
	models: readonly string[] | undefined,
): RequestedModelChain => {
	const chain = [...(model !== undefined ? [model] : []), ...(models ?? [])];
	return [...new Set(chain)];
};
