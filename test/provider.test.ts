import { describe, expect, test } from "bun:test";
import {
	allowsAnyProvider,
	enforceRequireParameters,
} from "../src/core/provider";

describe("enforceRequireParameters", () => {
	test("keeps every caller setting and only strengthens require_parameters", () => {
		const provider = {
			only: ["openai"],
			ignore: ["azure"],
			order: ["openai"],
			zdr: true,
			data_collection: "deny" as const,
			require_parameters: false,
		};
		expect(enforceRequireParameters(provider)).toEqual({
			provider: { ...provider, require_parameters: true },
			overridden: true,
		});
	});

	test("creates provider object when absent", () => {
		expect(enforceRequireParameters(undefined)).toEqual({
			provider: { require_parameters: true },
			overridden: true,
		});
	});

	test("no-op when already true", () => {
		const provider = { require_parameters: true };
		expect(enforceRequireParameters(provider)).toEqual({
			provider,
			overridden: false,
		});
	});
});

describe("allowsAnyProvider", () => {
	test.each([
		[undefined, true],
		[{}, true],
		[{ only: ["xai"] }, true],
		[{ only: ["xai/zdr"] }, true],
		[{ only: ["openai"] }, false],
		[{ ignore: ["xai"] }, false],
		[{ order: ["openai"] }, true],
	])("%j → %p", (provider, expected) => {
		expect(allowsAnyProvider(provider, ["xai"])).toBe(expected);
	});
});
