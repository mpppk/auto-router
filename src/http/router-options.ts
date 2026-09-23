import { type Capability, SEMANTIC_CAPABILITIES } from "../core/capabilities";
import { RouterError } from "../core/errors";

/**
 * caller が request header で指定する auto-router の挙動。
 *
 * header の方針:
 * - body には独自 field を追加せず、`Auto-Router-*` header で指定する (upstream には転送しない)
 * - 値は前後の空白を無視し、真偽値は `true` / `false`、on / off は `on` / `off`、
 *   一覧は `,` 区切り (各要素の前後の空白は無視)
 * - 不正な値は黙って無視せず `invalid_router_request` (400) にする
 */
export interface RouterOptions {
	/** caller chain で Hard Requirement を満たせない場合に default route へ置換してよいか。 */
	allowModelOverride: boolean;
	/** 詳細traceを保持するか。 */
	debug: boolean;
	semantic: SemanticOptions;
}

export interface SemanticOptions {
	/** false なら Jev を呼ばず semantic requirement なしとして扱う (structural は維持)。 */
	enabled: boolean;
	/** 判定する semantic capability を限定する。undefined なら全 capability。 */
	capabilities?: Capability[];
}

export const ALLOW_MODEL_OVERRIDE_HEADER = "Auto-Router-Allow-Model-Override";
export const DEBUG_HEADER = "Auto-Router-Debug";
export const SEMANTIC_HEADER = "Auto-Router-Semantic";
export const CAPABILITIES_HEADER = "Auto-Router-Capabilities";

export const invalidHeader = (name: string, message: string) =>
	new RouterError("invalid_router_request", message, { header: name });

const parseBooleanHeader = (
	headers: Headers,
	name: string,
	defaultValue: boolean,
): boolean => {
	const raw = headers.get(name);
	if (raw === null) return defaultValue;
	switch (raw.trim().toLowerCase()) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		default:
			throw invalidHeader(
				name,
				`Header \`${name}\` must be "true" or "false".`,
			);
	}
};

const parseOnOffHeader = (
	headers: Headers,
	name: string,
	defaultValue: boolean,
): boolean => {
	const raw = headers.get(name);
	if (raw === null) return defaultValue;
	switch (raw.trim().toLowerCase()) {
		case "on":
			return true;
		case "off":
			return false;
		default:
			throw invalidHeader(name, `Header \`${name}\` must be "on" or "off".`);
	}
};

/** `,` 区切りの header を要素の配列にする。空要素は不正。 */
export const parseListHeader = (
	headers: Headers,
	name: string,
): string[] | undefined => {
	const raw = headers.get(name);
	if (raw === null) return undefined;
	const items = raw.split(",").map((item) => item.trim());
	if (items.some((item) => item === "")) {
		throw invalidHeader(
			name,
			`Header \`${name}\` must be a comma-separated list without empty items.`,
		);
	}
	return items;
};

const isCapability = (value: string): value is Capability =>
	(SEMANTIC_CAPABILITIES as readonly string[]).includes(value);

/** semantic capability 名の一覧として parse する。未知の capability は不正。 */
export const parseCapabilityList = (
	headers: Headers,
	name: string,
): Capability[] | undefined => {
	const items = parseListHeader(headers, name);
	if (items === undefined) return undefined;
	const unknown = items.filter((item) => !isCapability(item));
	if (unknown.length > 0) {
		throw invalidHeader(
			name,
			`Header \`${name}\` has unknown capabilities: ${unknown.join(", ")}. Supported: ${SEMANTIC_CAPABILITIES.join(", ")}`,
		);
	}
	return [...new Set(items as Capability[])];
};

export const parseRouterOptions = (headers: Headers): RouterOptions => {
	const capabilities = parseCapabilityList(headers, CAPABILITIES_HEADER);
	return {
		allowModelOverride: parseBooleanHeader(
			headers,
			ALLOW_MODEL_OVERRIDE_HEADER,
			true,
		),
		debug: parseBooleanHeader(headers, DEBUG_HEADER, false),
		semantic: {
			enabled: parseOnOffHeader(headers, SEMANTIC_HEADER, true),
			...(capabilities !== undefined ? { capabilities } : {}),
		},
	};
};
