import {
	createStaticModelCatalog,
	EMPTY_MODEL_CATALOG,
	fetchOpenRouterProfiles,
	type ModelCatalog,
	type ModelCatalogSource,
	type ModelProfile,
	type OpenRouterModelsOptions,
} from "./model-catalog";

/** 縮約 catalog の KV key。形式を変えたら version を上げる。 */
export const CATALOG_KV_KEY = "openrouter-models:v1";

/**
 * routing に必要な field だけに縮約した catalog (約 35KB)。
 * modality / parameter 名は辞書にし、model ごとには index だけを持つ。
 */
export interface CompactCatalog {
	v: 1;
	/** OpenRouter から取得した時刻 (epoch ms)。 */
	fetchedAt: number;
	modalities: string[];
	parameters: string[];
	/** [id, modality index[], parameter index[], context_length | null] */
	models: [string, number[], number[], number | null][];
}

export type CatalogKV = Pick<KVNamespace, "get" | "put">;

export const toCompactCatalog = (
	profiles: readonly ModelProfile[],
	fetchedAt: number,
): CompactCatalog => {
	const modalities = [...new Set(profiles.flatMap((p) => p.inputModalities))];
	const parameters = [
		...new Set(profiles.flatMap((p) => p.supportedParameters)),
	];
	return {
		v: 1,
		fetchedAt,
		modalities,
		parameters,
		models: profiles.map((p) => [
			p.id,
			p.inputModalities.map((m) => modalities.indexOf(m)),
			p.supportedParameters.map((x) => parameters.indexOf(x)),
			p.contextLength ?? null,
		]),
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isIndexArray = (value: unknown, size: number): value is number[] =>
	Array.isArray(value) &&
	value.every((i) => Number.isInteger(i) && i >= 0 && i < size);

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === "string");

export const fromCompactCatalog = (json: unknown): ModelProfile[] => {
	if (
		!isRecord(json) ||
		json.v !== 1 ||
		!isStringArray(json.modalities) ||
		!isStringArray(json.parameters) ||
		!Array.isArray(json.models)
	) {
		throw new Error("invalid compact catalog");
	}
	const { modalities, parameters } = json;
	return json.models.map((m): ModelProfile => {
		if (
			!Array.isArray(m) ||
			typeof m[0] !== "string" ||
			!isIndexArray(m[1], modalities.length) ||
			!isIndexArray(m[2], parameters.length)
		) {
			throw new Error("invalid compact catalog entry");
		}
		return {
			id: m[0],
			inputModalities: m[1].map((i) => modalities[i] as string),
			supportedParameters: m[2].map((i) => parameters[i] as string),
			...(typeof m[3] === "number" ? { contextLength: m[3] } : {}),
		};
	});
};

/**
 * OpenRouter から catalog を取得し、縮約して KV に保存する (cron trigger)。
 * 失敗した場合は throw し、KV の既存の値はそのまま残る。
 */
export const refreshCatalogKv = async (
	options: OpenRouterModelsOptions & { kv: CatalogKV; now?: () => number },
): Promise<ModelProfile[]> => {
	const profiles = await fetchOpenRouterProfiles(options);
	if (profiles.length === 0) throw new Error("empty OpenRouter models");
	await options.kv.put(
		CATALOG_KV_KEY,
		JSON.stringify(toCompactCatalog(profiles, (options.now ?? Date.now)())),
	);
	return profiles;
};

export interface KvModelCatalogOptions extends OpenRouterModelsOptions {
	kv: CatalogKV;
	/** isolate 内 cache の TTL。 */
	ttlMs?: number;
	/** KV の edge cache TTL (秒、最小 30)。 */
	kvCacheTtlSeconds?: number;
	now?: () => number;
}

/**
 * cron が KV に保存した縮約 catalog を読む ModelCatalogSource。
 * 通常の request path では 750KB の `GET /models` を parse しない。
 *
 * - KV に無い場合 (初回 deploy 直後等) だけ OpenRouter から取得し KV を埋める
 * - KV / OpenRouter の取得に失敗した場合は古い isolate cache → 空 catalog (全 model 不明)
 */
export const createKvModelCatalogSource = (
	options: KvModelCatalogOptions,
): ModelCatalogSource => {
	const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
	const now = options.now ?? Date.now;
	let cached: { catalog: ModelCatalog; expiresAt: number } | undefined;
	let inflight: Promise<ModelCatalog> | undefined;

	const read = async (): Promise<ModelProfile[]> => {
		const raw = await options.kv.get(CATALOG_KV_KEY, {
			type: "text",
			cacheTtl: options.kvCacheTtlSeconds ?? 300,
		});
		if (raw !== null) return fromCompactCatalog(JSON.parse(raw));
		console.warn("model catalog is not in KV yet; fetching from OpenRouter");
		return refreshCatalogKv(options);
	};

	const load = async (): Promise<ModelCatalog> => {
		try {
			const catalog = createStaticModelCatalog(await read());
			cached = { catalog, expiresAt: now() + ttlMs };
			return catalog;
		} catch (err) {
			console.warn(
				"failed to load model catalog",
				err instanceof Error ? err.message : err,
			);
			return cached?.catalog ?? EMPTY_MODEL_CATALOG;
		}
	};

	return {
		load() {
			if (cached !== undefined && cached.expiresAt > now()) {
				return Promise.resolve(cached.catalog);
			}
			inflight ??= load().finally(() => {
				inflight = undefined;
			});
			return inflight;
		},
	};
};
