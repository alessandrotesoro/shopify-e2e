import { describe, expect, it } from "vitest";

import {
	MAX_STORAGE_STATE_BYTES,
	serializeStorageState,
	validateStorageState,
} from "../src/storage-state/schema.cjs";

describe("dependency-neutral Playwright storage-state schema", () => {
	it("accepts and detaches a bounded state value", () => {
		const state = {
			cookies: [],
			origins: [
				{
					localStorage: [{ name: "identity", value: "admin" }],
					origin: "https://shop.example",
				},
			],
		};

		const validated = validateStorageState(state);

		expect(validated).toEqual(state);
		expect(validated).not.toBe(state);
		expect(JSON.parse(serializeStorageState(state))).toEqual(state);
	});

	it("rejects malformed and oversized state", () => {
		expect(() => validateStorageState({ cookies: [] })).toThrow(
			/storage state/i,
		);
		expect(() =>
			serializeStorageState({
				cookies: [],
				origins: [],
				padding: "x".repeat(MAX_STORAGE_STATE_BYTES),
			}),
		).toThrow(/64 MiB/i);
	});
});
