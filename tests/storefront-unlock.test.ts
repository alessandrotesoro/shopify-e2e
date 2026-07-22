import type { Locator, Page, Response } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

const typeLikeHuman = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/playwright/type-like-human.cjs", () => ({ typeLikeHuman }));

import {
	openStorefront,
	unlockStorefront,
} from "../src/playwright/storefront.cjs";

const origin = "https://shop.example";
const password = "controlled-test-password";

interface InputSpec {
	readonly enabled?: boolean;
	readonly visible?: boolean;
}

interface FormSpec {
	readonly action?: string | null;
	readonly inputIndexes?: readonly number[];
	readonly method?: string | null;
	readonly visible?: boolean;
}

interface PageSpec {
	readonly afterNavigationForms?: readonly FormSpec[];
	readonly afterNavigationInputs?: readonly InputSpec[];
	readonly afterNavigationUrl?: string;
	readonly forms?: readonly FormSpec[];
	readonly gotoError?: Error;
	readonly gotoResponse?: Response | null;
	readonly gotoUrl?: string;
	readonly inputs?: readonly InputSpec[];
	readonly navigationError?: Error;
	readonly navigationResponse?: Response | null;
	readonly url?: string;
}

const response = (ok = true): Response =>
	({ ok: vi.fn(() => ok) }) as unknown as Response;

const makePage = (spec: PageSpec = {}) => {
	let navigated = false;
	let submitted = false;
	const initialInputs = spec.inputs ?? [];
	const initialForms = spec.forms ?? [];
	const afterInputs = spec.afterNavigationInputs ?? [];
	const afterForms = spec.afterNavigationForms ?? [];
	const inputLocators = new Map<number, Locator>();
	const formLocators = new Map<number, Locator>();

	const currentInputs = () => (submitted ? afterInputs : initialInputs);
	const currentForms = () => (submitted ? afterForms : initialForms);

	const inputLocator = (index: number): Locator => {
		const cached = inputLocators.get(index);
		if (cached) return cached;
		const locator = {
			isEnabled: vi.fn(async () => currentInputs()[index]?.enabled ?? true),
			isVisible: vi.fn(async () => currentInputs()[index]?.visible ?? true),
		} as unknown as Locator;
		inputLocators.set(index, locator);
		return locator;
	};

	const inputCollection = (indexes: readonly number[]): Locator =>
		({
			count: vi.fn(async () => indexes.length),
			nth: vi.fn((index: number) => inputLocator(indexes[index] ?? -1)),
		}) as unknown as Locator;

	const formLocator = (index: number): Locator => {
		const cached = formLocators.get(index);
		if (cached) return cached;
		const locator = {
			evaluate: vi.fn(async () => {
				submitted = true;
			}),
			getAttribute: vi.fn(async (name: string) => {
				const form = currentForms()[index];
				return name === "action"
					? (form?.action ?? null)
					: (form?.method ?? null);
			}),
			isVisible: vi.fn(async () => currentForms()[index]?.visible ?? true),
			locator: vi.fn(() =>
				inputCollection(currentForms()[index]?.inputIndexes ?? []),
			),
		} as unknown as Locator;
		formLocators.set(index, locator);
		return locator;
	};

	const formCollection = (): Locator =>
		({
			count: vi.fn(async () => currentForms().length),
			nth: vi.fn((index: number) => formLocator(index)),
		}) as unknown as Locator;

	const locator = vi.fn((selector: string) =>
		selector === 'input[type="password"]'
			? inputCollection(currentInputs().map((_input, index) => index))
			: formCollection(),
	);
	const goto = vi.fn(async () => {
		if (spec.gotoError) throw spec.gotoError;
		navigated = true;
		return spec.gotoResponse === undefined ? response() : spec.gotoResponse;
	});
	const waitForLoadState = vi.fn(async () => undefined);
	const waitForNavigation = vi.fn(async () => {
		if (spec.navigationError) throw spec.navigationError;
		return spec.navigationResponse === undefined
			? response()
			: spec.navigationResponse;
	});
	const url = vi.fn(() => {
		if (submitted) return spec.afterNavigationUrl ?? origin;
		if (navigated) return spec.gotoUrl ?? origin;
		return spec.url ?? origin;
	});
	const page = {
		goto,
		locator,
		url,
		waitForLoadState,
		waitForNavigation,
	} as unknown as Page;

	return {
		formLocator,
		goto,
		locator,
		page,
		waitForLoadState,
		waitForNavigation,
	};
};

const protectedPage = (overrides: PageSpec = {}): PageSpec => ({
	forms: [
		{
			action: "/password",
			inputIndexes: [0],
			method: "POST",
		},
	],
	inputs: [{}],
	...overrides,
});

const expectSanitizedFailure = async (
	operation: Promise<unknown>,
	secret: string,
): Promise<Error> => {
	const error = await operation.catch((cause: unknown) => cause);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).not.toContain(secret);
	expect((error as Error).message).not.toMatch(/private|token=|query-secret/i);
	expect((error as Error).cause).toBeUndefined();
	return error as Error;
};

afterEach(() => {
	vi.unstubAllEnvs();
	typeLikeHuman.mockClear();
});

describe.sequential("storefront opening", () => {
	it("accepts a healthy same-origin response and redirect", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", `${origin}/configured/path`);
		const { goto, page } = makePage({ gotoUrl: `${origin}/redirected` });

		await openStorefront(page);

		expect(goto).toHaveBeenCalledWith(origin, {
			waitUntil: "domcontentloaded",
		});
	});

	it.each([
		{ label: "null response", spec: { gotoResponse: null } },
		{ label: "unsuccessful response", spec: { gotoResponse: response(false) } },
		{
			label: "navigation rejection",
			spec: { gotoError: new Error("private/query-secret?token=value") },
		},
		{
			label: "cross-origin redirect",
			spec: { gotoUrl: "https://other.example/private?token=query-secret" },
		},
	])("rejects $label with sanitized guidance", async ({ spec }) => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		const { page } = makePage(spec);

		await expectSanitizedFailure(openStorefront(page), "query-secret");
	});
});

describe.sequential("storefront unlocking", () => {
	it("waits for DOM readiness and rejects a wrong origin before inspection", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const { locator, page, waitForLoadState } = makePage({
			url: "https://other.example/private?token=query-secret",
		});

		await expectSanitizedFailure(unlockStorefront(page), password);

		expect(waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
		expect(locator).not.toHaveBeenCalled();
		expect(typeLikeHuman).not.toHaveBeenCalled();
	});

	it("returns without reading the password when no challenge exists", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		const originalEnvironment = process.env;
		let passwordReads = 0;
		process.env = new Proxy(originalEnvironment, {
			get(target, property, receiver) {
				if (property === "SHOPIFY_STOREFRONT_PASSWORD") passwordReads += 1;
				return Reflect.get(target, property, receiver);
			},
		});
		try {
			await unlockStorefront(makePage().page);
		} finally {
			process.env = originalEnvironment;
		}

		expect(passwordReads).toBe(0);
		expect(typeLikeHuman).not.toHaveBeenCalled();
	});

	it("types once and submits an exact verified challenge", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const fixture = makePage(protectedPage());

		await unlockStorefront(fixture.page);

		expect(typeLikeHuman).toHaveBeenCalledOnce();
		expect(typeLikeHuman).toHaveBeenCalledWith(expect.anything(), password);
		expect(fixture.waitForNavigation).toHaveBeenCalledWith({
			waitUntil: "domcontentloaded",
		});
		expect(fixture.formLocator(0).evaluate).toHaveBeenCalledOnce();
	});

	it("allows unrelated forms alongside one exact password challenge", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const fixture = makePage({
			forms: [
				{ action: "/contact", inputIndexes: [], method: "POST" },
				{ action: "/password", inputIndexes: [0], method: "POST" },
			],
			inputs: [{}],
		});

		await unlockStorefront(fixture.page);

		expect(typeLikeHuman).toHaveBeenCalledOnce();
		expect(fixture.formLocator(0).evaluate).not.toHaveBeenCalled();
		expect(fixture.formLocator(1).evaluate).toHaveBeenCalledOnce();
	});

	it.each([
		{
			label: "password input outside a form",
			spec: { forms: [], inputs: [{}] },
		},
		{
			label: "password form without an input",
			spec: { forms: [{ action: "/password", method: "POST" }], inputs: [] },
		},
		{
			label: "unrelated action",
			spec: protectedPage({
				forms: [
					{ action: "/account/login", inputIndexes: [0], method: "POST" },
				],
			}),
		},
		{
			label: "cross-origin action",
			spec: protectedPage({
				forms: [
					{
						action: "https://other.example/password",
						inputIndexes: [0],
						method: "POST",
					},
				],
			}),
		},
		{
			label: "query-bearing password action",
			spec: protectedPage({
				forms: [
					{
						action: "/password?token=query-secret",
						inputIndexes: [0],
						method: "POST",
					},
				],
			}),
		},
		{
			label: "GET method",
			spec: protectedPage({
				forms: [{ action: "/password", inputIndexes: [0], method: "GET" }],
			}),
		},
		{
			label: "hidden form",
			spec: protectedPage({
				forms: [
					{
						action: "/password",
						inputIndexes: [0],
						method: "POST",
						visible: false,
					},
				],
			}),
		},
		{
			label: "hidden input",
			spec: protectedPage({ inputs: [{ visible: false }] }),
		},
		{
			label: "disabled input",
			spec: protectedPage({ inputs: [{ enabled: false }] }),
		},
		{
			label: "multiple password inputs",
			spec: {
				forms: [
					{
						action: "/password",
						inputIndexes: [0, 1],
						method: "POST",
					},
				],
				inputs: [{}, {}],
			},
		},
	])("rejects $label before typing", async ({ spec }) => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);

		await expectSanitizedFailure(
			unlockStorefront(makePage(spec).page),
			password,
		);

		expect(typeLikeHuman).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		"",
		"   ",
	])("rejects missing or blank password %s after challenge verification", async (configuredPassword) => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		if (configuredPassword !== undefined) {
			vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", configuredPassword);
		}

		const error = await expectSanitizedFailure(
			unlockStorefront(makePage(protectedPage()).page),
			password,
		);

		expect(error.message).toContain("SHOPIFY_STOREFRONT_PASSWORD");
		expect(typeLikeHuman).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "null navigation response", spec: { navigationResponse: null } },
		{
			label: "unsuccessful response",
			spec: { navigationResponse: response(false) },
		},
		{
			label: "navigation timeout",
			spec: {
				navigationError: new Error(
					"Timeout /private?token=query-secret controlled-test-password",
				),
			},
		},
		{
			label: "cross-origin redirect",
			spec: {
				afterNavigationUrl: "https://other.example/private?token=query-secret",
			},
		},
		{
			label: "replacement challenge",
			spec: {
				afterNavigationForms: [
					{
						action: "/password",
						inputIndexes: [0],
						method: "POST",
					},
				],
				afterNavigationInputs: [{}],
			},
		},
		{
			label: "malformed replacement password field",
			spec: {
				afterNavigationForms: [],
				afterNavigationInputs: [{}],
			},
		},
	])("sanitizes $label after submission", async ({ spec }) => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const page = makePage(protectedPage(spec)).page;

		await expectSanitizedFailure(unlockStorefront(page), password);

		expect(typeLikeHuman).toHaveBeenCalledOnce();
	});

	it("preserves safe configured-origin validation", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", "http://shop.example/private");

		await expect(unlockStorefront(makePage().page)).rejects.toThrow(
			/SHOPIFY_STORE_URL must use HTTPS/,
		);
		expect(typeLikeHuman).not.toHaveBeenCalled();
	});
});
