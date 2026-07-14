import { describe, expect, it } from "vitest";
import { validateStorageState } from "../src/profiles/profile-schema.js";

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

describe("Playwright storage-state schema", () => {
	it("accepts cookies, localStorage, and the Playwright 1.61.1 IndexedDB shape", () => {
		const state = {
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
		};

		expect(validateStorageState(state)).toEqual(state);
	});

	it("rejects malformed cookies, origins, and IndexedDB arrays", () => {
		const invalidStates = [
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
			expect(() => validateStorageState(state)).toThrow(/storage state/i);
		}
	});
});
