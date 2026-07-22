import { describe, expect, it } from "vitest";

import {
	MAX_STORAGE_STATE_BYTES,
	serializeStorageState,
	validateParsedStorageState,
	validateStorageState,
} from "../src/storage-state/schema.js";

const configuredOrigin = "https://shop.example";

const stateWithCookie = (value: string) => ({
	cookies: [
		{
			domain: "shop.example",
			expires: -1,
			httpOnly: true,
			name: "session",
			path: "/",
			sameSite: "Lax" as const,
			secure: true,
			value,
		},
	],
	origins: [],
});

const completeStorageState = () => ({
	cookies: [
		{
			...stateWithCookie("bearer").cookies[0],
			_crHasCrossSiteAncestor: false,
			partitionKey: "https://top-level.example",
		},
	],
	origins: [
		{
			indexedDB: [
				{
					name: "identity",
					stores: [
						{
							autoIncrement: false,
							indexes: [
								{
									keyPath: "email",
									multiEntry: false,
									name: "by-email",
									unique: true,
								},
							],
							keyPath: "id",
							name: "accounts",
							records: [{ value: { email: "a@example.com", id: 1 } }],
						},
					],
					version: 1,
				},
			],
			localStorage: [{ name: "identity", value: "customer" }],
			origin: configuredOrigin,
		},
	],
});

describe("dependency-neutral Playwright storage-state schema", () => {
	it("accepts cookies, localStorage, and Playwright 1.61.1 IndexedDB state", () => {
		const state = completeStorageState();

		const parsed = validateParsedStorageState(state);
		const validated = validateStorageState(state);

		expect(parsed).toBe(state);
		expect(validated).toEqual(state);
		expect(validated).not.toBe(state);
		expect(JSON.parse(serializeStorageState(state))).toEqual(state);
	});

	it("rejects malformed cookies, origins, and IndexedDB arrays", () => {
		const invalidStates: readonly unknown[] = [
			{ cookies: [], origins: [], extra: true },
			{ cookies: [{ name: "session" }], origins: [] },
			{
				cookies: [
					{
						...stateWithCookie("bearer").cookies[0],
						partitionKey: 123,
					},
				],
				origins: [],
			},
			{
				cookies: [
					{
						...stateWithCookie("bearer").cookies[0],
						_crHasCrossSiteAncestor: "false",
					},
				],
				origins: [],
			},
			{
				cookies: [],
				origins: [{ localStorage: [], origin: "https://shop.example/path" }],
			},
			{
				cookies: [],
				origins: [
					{
						indexedDB: [{ name: "db", stores: [], version: 1.5 }],
						localStorage: [],
						origin: configuredOrigin,
					},
				],
			},
			{
				cookies: [],
				origins: [
					{
						indexedDB: [{ arbitrary: "json" }],
						localStorage: [],
						origin: configuredOrigin,
					},
				],
			},
		];

		for (const state of invalidStates) {
			expect(() => validateParsedStorageState(state)).toThrow(/storage state/i);
			expect(() => validateStorageState(state)).toThrow(/storage state/i);
		}
	});

	it("bounds serialized input without imposing that bound on parsed state", () => {
		const oversizedState = {
			cookies: [],
			origins: [
				{
					localStorage: [
						{ name: "padding", value: "x".repeat(MAX_STORAGE_STATE_BYTES) },
					],
					origin: configuredOrigin,
				},
			],
		};

		expect(validateParsedStorageState(oversizedState)).toBe(oversizedState);
		expect(() => validateStorageState(oversizedState)).toThrow(/64 MiB/i);
		expect(() => serializeStorageState(oversizedState)).toThrow(/64 MiB/i);
	});
});
