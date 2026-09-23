/**
 * `,` 区切りの model id 一覧 (Worker var) を parse する。
 * 設定ミスで全 request を失敗させないよう、不正・空なら warning を出して undefined (既定値を使う) を返す。
 */
export const parseModelList = (
	name: string,
	raw: string | undefined,
): string[] | undefined => {
	if (raw === undefined || raw.trim() === "") return undefined;
	const models = raw.split(",").map((m) => m.trim());
	if (models.some((m) => m === "" || /\s/.test(m))) {
		console.warn(`ignoring invalid ${name}`, raw);
		return undefined;
	}
	return [...new Set(models)];
};
