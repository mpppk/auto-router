const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/**
 * trace ownership 用の API key fingerprint。raw key は保存しない。
 * secret が設定されていれば HMAC-SHA256、無ければ domain 分離した SHA-256 を使う。
 */
export const apiKeyFingerprint = async (
	apiKey: string,
	secret: string | undefined,
): Promise<string> => {
	if (secret === undefined || secret === "") {
		return `sha256:${toHex(
			await crypto.subtle.digest(
				"SHA-256",
				encoder.encode(`auto-router-trace-owner:${apiKey}`),
			),
		)}`;
	}
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return `hmac:${toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(apiKey)))}`;
};
