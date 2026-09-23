/**
 * OpenRouter の provider preferences。
 * 未知のfieldも保持するため index signature を持つ。
 */
export type ProviderPreferences = Record<string, unknown> & {
	order?: string[];
	only?: string[];
	ignore?: string[];
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
	data_collection?: "allow" | "deny";
	zdr?: boolean;
	quantizations?: string[];
};

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === "string");

/** provider tag (例: `xai/zdr`) から provider slug (`xai`) を取り出す。 */
const providerSlug = (tag: string) => tag.split("/")[0]?.toLowerCase() ?? "";

/**
 * caller の provider 制約の下で、指定 provider 群のいずれかが利用可能か。
 * `only` / `ignore` は緩和せず、その範囲で判定する。
 */
export const allowsAnyProvider = (
	provider: ProviderPreferences | undefined,
	providers: readonly string[],
): boolean => {
	if (provider === undefined) return true;
	const only = isStringArray(provider.only)
		? provider.only.map(providerSlug)
		: undefined;
	const ignore = isStringArray(provider.ignore)
		? provider.ignore.map(providerSlug)
		: [];
	return providers.some((p) => {
		const slug = providerSlug(p);
		return (
			(only === undefined || only.includes(slug)) && !ignore.includes(slug)
		);
	});
};

/**
 * Hard Requirement 維持のため `require_parameters: true` へ強化する。
 * caller の他の設定 (only / ignore / order / zdr 等) はそのまま保持する。
 */
export const enforceRequireParameters = (
	provider: ProviderPreferences | undefined,
): { provider: ProviderPreferences; overridden: boolean } => {
	if (provider?.require_parameters === true) {
		return { provider, overridden: false };
	}
	return {
		provider: { ...(provider ?? {}), require_parameters: true },
		overridden: true,
	};
};
