import { describe, expect, test } from "bun:test";
import { normalizeModelChain } from "../src/core/model-chain";

describe("normalizeModelChain", () => {
	test("model only", () => {
		expect(normalizeModelChain("a", undefined)).toEqual(["a"]);
	});
	test("models only", () => {
		expect(normalizeModelChain(undefined, ["a", "b"])).toEqual(["a", "b"]);
	});
	test("model + models", () => {
		expect(normalizeModelChain("a", ["b", "c"])).toEqual(["a", "b", "c"]);
	});
	test("removes duplicates keeping first occurrence", () => {
		expect(normalizeModelChain("a", ["b", "a", "c"])).toEqual(["a", "b", "c"]);
	});
	test("neither", () => {
		expect(normalizeModelChain(undefined, undefined)).toEqual([]);
	});
});
