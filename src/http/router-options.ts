import { RouterError } from "../core/errors";

export interface RouterOptions {
	/** caller chain で Hard Requirement を満たせない場合に default route へ置換してよいか。 */
	allowModelOverride: boolean;
	/** 詳細traceを保持するか。 */
	debug: boolean;
}

export const ALLOW_MODEL_OVERRIDE_HEADER = "Auto-Router-Allow-Model-Override";
export const DEBUG_HEADER = "Auto-Router-Debug";

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
			throw new RouterError(
				"invalid_router_request",
				`Header \`${name}\` must be "true" or "false".`,
				{ header: name },
			);
	}
};

export const parseRouterOptions = (headers: Headers): RouterOptions => ({
	allowModelOverride: parseBooleanHeader(
		headers,
		ALLOW_MODEL_OVERRIDE_HEADER,
		true,
	),
	debug: parseBooleanHeader(headers, DEBUG_HEADER, false),
});
