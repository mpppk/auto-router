import type { FetchLike } from "../upstream/openrouter";

/** capability 判定に必要な model 情報。 */
export interface ModelProfile {
	id: string;
	inputModalities: string[];
	supportedParameters: string[];
	contextLength?: number;
}

/** model id → profile。見つからない model は「不明」として扱う。 */
export interface ModelCatalog {
	lookup(modelId: string): ModelProfile | undefined;
}

export const createStaticModelCatalog = (
	profiles: readonly ModelProfile[],
): ModelCatalog => {
	const byId = new Map(profiles.map((p) => [p.id, p]));
	return {
		lookup(modelId) {
			const exact = byId.get(modelId);
			if (exact !== undefined) return exact;
			// `:nitro` `:floor` 等の variant suffix は base model の profile を使う。
			const base = modelId.split(":")[0];
			return base === undefined ? undefined : byId.get(base);
		},
	};
};

/** 取得できなかった場合に使う空の catalog。全 model が「不明」になる。 */
export const EMPTY_MODEL_CATALOG: ModelCatalog = createStaticModelCatalog([]);

export interface ModelCatalogSource {
	load(): Promise<ModelCatalog>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const stringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];

export const parseOpenRouterModels = (json: unknown): ModelProfile[] => {
	if (!isRecord(json) || !Array.isArray(json.data)) {
		throw new Error("invalid OpenRouter models response");
	}
	return json.data.flatMap((m): ModelProfile[] => {
		if (!isRecord(m) || typeof m.id !== "string") return [];
		const architecture = isRecord(m.architecture) ? m.architecture : {};
		return [
			{
				id: m.id,
				inputModalities: stringArray(architecture.input_modalities),
				supportedParameters: stringArray(m.supported_parameters),
				...(typeof m.context_length === "number"
					? { contextLength: m.context_length }
					: {}),
			},
		];
	});
};

export interface OpenRouterModelCatalogOptions {
	baseUrl: string;
	fetch: FetchLike;
	ttlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

/**
 * OpenRouter `GET /models` (認証不要) から model profile を取得し、isolate 内でcacheする。
 * 取得に失敗した場合は空の catalog (全 model 不明) を返し、request 自体は失敗させない。
 */
export const createOpenRouterModelCatalogSource = (
	options: OpenRouterModelCatalogOptions,
): ModelCatalogSource => {
	const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
	const timeoutMs = options.timeoutMs ?? 3000;
	const now = options.now ?? Date.now;
	let cached: { catalog: ModelCatalog; expiresAt: number } | undefined;
	let inflight: Promise<ModelCatalog> | undefined;

	const fetchCatalog = async (): Promise<ModelCatalog> => {
		try {
			const res = await options.fetch(`${options.baseUrl}/models`, {
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) throw new Error(`status ${res.status}`);
			const catalog = createStaticModelCatalog(
				parseOpenRouterModels(await res.json()),
			);
			cached = { catalog, expiresAt: now() + ttlMs };
			return catalog;
		} catch (err) {
			console.warn(
				"failed to load OpenRouter model catalog",
				err instanceof Error ? err.message : err,
			);
			// 古い cache があればそれを使い続ける。
			return cached?.catalog ?? EMPTY_MODEL_CATALOG;
		}
	};

	return {
		load() {
			if (cached !== undefined && cached.expiresAt > now()) {
				return Promise.resolve(cached.catalog);
			}
			inflight ??= fetchCatalog().finally(() => {
				inflight = undefined;
			});
			return inflight;
		},
	};
};
