import type { ElementHandle, Locator, Page, Response } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

const typeLikeHuman = vi.hoisted(() =>
	vi.fn(async (_locator: Locator, _text: string): Promise<void> => undefined),
);

vi.mock("../src/playwright/type-like-human.js", () => ({ typeLikeHuman }));

import {
	openStorefront,
	unlockStorefront,
} from "../src/playwright/storefront.js";

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
	readonly formHandleError?: Error;
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
	let navigatedAway = false;
	let opened = false;
	let replaced = false;
	let submitted = false;
	const initialInputs = spec.inputs ?? [];
	const initialForms = spec.forms ?? [];
	const afterInputs = spec.afterNavigationInputs ?? [];
	const afterForms = spec.afterNavigationForms ?? [];
	const inputHandles = new Map<string, ElementHandle<HTMLInputElement>>();
	const formHandles = new Map<string, ElementHandle<HTMLFormElement>>();
	const formActionOverrides = new Map<string, string>();

	const generation = () =>
		submitted ? "after" : replaced ? "replacement" : "initial";
	const currentInputs = () => (submitted ? afterInputs : initialInputs);
	const currentForms = () => (submitted ? afterForms : initialForms);
	const isAttached = (handleGeneration: string) =>
		handleGeneration === generation() && !navigatedAway;

	const inputHandle = (
		index: number,
		handleGeneration = generation(),
	): ElementHandle<HTMLInputElement> => {
		const key = `${handleGeneration}:${index}`;
		const cached = inputHandles.get(key);
		if (cached) return cached;
		const handle = {
			dispose: vi.fn(async () => undefined),
			evaluate: vi.fn(async (_callback, candidate?: unknown) =>
				candidate === undefined
					? isAttached(handleGeneration)
					: (candidate as { readonly nodeKey?: string }).nodeKey === key,
			),
			isEnabled: vi.fn(async () => currentInputs()[index]?.enabled ?? true),
			isVisible: vi.fn(async () => currentInputs()[index]?.visible ?? true),
			nodeKey: key,
			nodeKind: "input",
			type: vi.fn(async () => {
				if (!isAttached(handleGeneration))
					throw new Error("detached private node");
			}),
		} as unknown as ElementHandle<HTMLInputElement>;
		inputHandles.set(key, handle);
		return handle;
	};

	const inputCollection = (indexes: readonly number[]): Locator =>
		({
			elementHandles: vi.fn(async () =>
				indexes.map((index) => inputHandle(index)),
			),
		}) as unknown as Locator;

	const formLocator = (
		index: number,
		handleGeneration = generation(),
	): ElementHandle<HTMLFormElement> => {
		const key = `${handleGeneration}:${index}`;
		const cached = formHandles.get(key);
		if (cached) return cached;
		const formSpec = currentForms()[index];
		const submitSpy = vi.fn();
		const handle = {
			$$: vi.fn(async () =>
				(formSpec?.inputIndexes ?? []).map((inputIndex) =>
					inputHandle(inputIndex, handleGeneration),
				),
			),
			dispose: vi.fn(async () => undefined),
			evaluate: vi.fn(async (callback, candidate?: unknown) => {
				if (candidate !== undefined) {
					if (
						typeof candidate === "object" &&
						candidate !== null &&
						"configuredOrigin" in candidate &&
						"input" in candidate
					) {
						const submission = candidate as {
							readonly configuredOrigin: string;
							readonly input: { readonly nodeKey?: string };
						};
						const containsInput = (formSpec?.inputIndexes ?? []).some(
							(inputIndex) =>
								submission.input.nodeKey ===
								`${handleGeneration}:${inputIndex}`,
						);
						const action = formActionOverrides.get(key) ?? formSpec?.action;
						if (
							!isAttached(handleGeneration) ||
							!containsInput ||
							formSpec?.method?.toUpperCase() !== "POST" ||
							(action === undefined || action === null
								? undefined
								: new URL(action, origin).href) !==
								`${submission.configuredOrigin}/password`
						) {
							throw new Error("unsafe private form");
						}
						submitted = true;
						submitSpy();
						return true;
					}
					const candidateNode = candidate as {
						readonly nodeKey?: string;
						readonly nodeKind?: string;
					};
					if (candidateNode.nodeKind === "form") {
						return candidateNode.nodeKey === key;
					}
					return (formSpec?.inputIndexes ?? []).some(
						(inputIndex) =>
							candidateNode.nodeKey === `${handleGeneration}:${inputIndex}`,
					);
				}
				if (String(callback).includes("requestSubmit")) submitted = true;
				return isAttached(handleGeneration);
			}),
			getAttribute: vi.fn(async (name: string) => {
				return name === "action"
					? (formActionOverrides.get(key) ?? formSpec?.action ?? null)
					: (formSpec?.method ?? null);
			}),
			isVisible: vi.fn(async () => formSpec?.visible ?? true),
			nodeKey: key,
			nodeKind: "form",
			submitSpy,
		} as unknown as ElementHandle<HTMLFormElement>;
		formHandles.set(key, handle);
		return handle;
	};

	const formCollection = (): Locator =>
		({
			elementHandles: vi.fn(async () => {
				if (spec.formHandleError) throw spec.formHandleError;
				return currentForms().map((_form, index) => formLocator(index));
			}),
		}) as unknown as Locator;

	const locator = vi.fn((selector: string) =>
		selector === 'input[type="password"]'
			? inputCollection(currentInputs().map((_input, index) => index))
			: formCollection(),
	);
	const goto = vi.fn(async () => {
		if (spec.gotoError) throw spec.gotoError;
		opened = true;
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
		if (navigatedAway)
			return "https://other.example/private?token=query-secret";
		if (opened) return spec.gotoUrl ?? origin;
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
		formLocator: (index: number) => formLocator(index, "initial"),
		goto,
		inputHandle,
		locator,
		mutateFormAction: (index: number, action: string) => {
			formActionOverrides.set(`initial:${index}`, action);
		},
		navigateAway: () => {
			navigatedAway = true;
		},
		page,
		replaceChallenge: () => {
			replaced = true;
		},
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

const wasSubmitted = (form: ElementHandle<HTMLFormElement>): boolean =>
	(form as unknown as { readonly submitSpy: ReturnType<typeof vi.fn> })
		.submitSpy.mock.calls.length > 0;

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
	typeLikeHuman.mockReset();
	typeLikeHuman.mockResolvedValue(undefined);
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
		const originalEnvironment = process.env;
		let passwordReads = 0;
		process.env = new Proxy(originalEnvironment, {
			get(target, property, receiver) {
				if (property === "SHOPIFY_STOREFRONT_PASSWORD") passwordReads += 1;
				return Reflect.get(target, property, receiver);
			},
		});

		try {
			await expectSanitizedFailure(unlockStorefront(page), password);
		} finally {
			process.env = originalEnvironment;
		}

		expect(waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
		expect(passwordReads).toBe(0);
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

	it("ignores an ordinary non-password form without reading the password", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const fixture = makePage({
			forms: [{ action: "/contact", inputIndexes: [], method: "POST" }],
		});
		const originalEnvironment = process.env;
		let passwordReads = 0;
		process.env = new Proxy(originalEnvironment, {
			get(target, property, receiver) {
				if (property === "SHOPIFY_STOREFRONT_PASSWORD") passwordReads += 1;
				return Reflect.get(target, property, receiver);
			},
		});

		try {
			await unlockStorefront(fixture.page);
		} finally {
			process.env = originalEnvironment;
		}

		expect(passwordReads).toBe(0);
		expect(typeLikeHuman).not.toHaveBeenCalled();
		expect(wasSubmitted(fixture.formLocator(0))).toBe(false);
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
		expect(wasSubmitted(fixture.formLocator(0))).toBe(true);
	});

	it("fails instead of retargeting when the verified input is replaced before typing", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const fixture = makePage(protectedPage());
		const pinnedInput = fixture.inputHandle(0);
		const originalEnvironment = process.env;
		process.env = new Proxy(originalEnvironment, {
			get(target, property, receiver) {
				if (property === "SHOPIFY_STOREFRONT_PASSWORD") {
					fixture.replaceChallenge();
				}
				return Reflect.get(target, property, receiver);
			},
		});
		typeLikeHuman.mockImplementationOnce(async (target, text) => {
			await target.pressSequentially(text, { delay: 50 });
		});

		try {
			await expectSanitizedFailure(unlockStorefront(fixture.page), password);
		} finally {
			process.env = originalEnvironment;
		}

		expect(pinnedInput.type).toHaveBeenCalledWith(password, { delay: 50 });
		expect(fixture.inputHandle(0).type).not.toHaveBeenCalled();
		expect(wasSubmitted(fixture.formLocator(0))).toBe(false);
	});

	it("fails without typing when navigation detaches the verified challenge", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const fixture = makePage(protectedPage());
		const pinnedInput = fixture.inputHandle(0);
		const originalEnvironment = process.env;
		process.env = new Proxy(originalEnvironment, {
			get(target, property, receiver) {
				if (property === "SHOPIFY_STOREFRONT_PASSWORD") fixture.navigateAway();
				return Reflect.get(target, property, receiver);
			},
		});
		typeLikeHuman.mockImplementationOnce(async (target, text) => {
			await target.pressSequentially(text, { delay: 50 });
		});

		try {
			await expectSanitizedFailure(unlockStorefront(fixture.page), password);
		} finally {
			process.env = originalEnvironment;
		}

		expect(pinnedInput.type).toHaveBeenCalledWith(password, { delay: 50 });
		expect(wasSubmitted(fixture.formLocator(0))).toBe(false);
	});

	it("blocks submission when the verified form action mutates during typing", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", password);
		const fixture = makePage(protectedPage());
		typeLikeHuman.mockImplementationOnce(async (target, text) => {
			await target.pressSequentially(text, { delay: 50 });
			fixture.mutateFormAction(0, "/account/login");
		});

		await expectSanitizedFailure(unlockStorefront(fixture.page), password);

		expect(fixture.inputHandle(0).type).toHaveBeenCalledWith(password, {
			delay: 50,
		});
		expect(wasSubmitted(fixture.formLocator(0))).toBe(false);
	});

	it("disposes every unreturned handle on safe-null and unsafe branches", async () => {
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		const ordinary = makePage({
			forms: [{ action: "/contact", inputIndexes: [], method: "POST" }],
		});

		await unlockStorefront(ordinary.page);

		expect(ordinary.formLocator(0).dispose).toHaveBeenCalled();

		const unsafe = makePage({
			forms: [
				{
					action: "/password",
					inputIndexes: [0, 1],
					method: "POST",
				},
			],
			inputs: [{}, {}],
		});
		await expect(unlockStorefront(unsafe.page)).rejects.toThrow(
			/password challenge/i,
		);
		expect(unsafe.formLocator(0).dispose).toHaveBeenCalled();
		expect(unsafe.inputHandle(0).dispose).toHaveBeenCalled();
		expect(unsafe.inputHandle(1).dispose).toHaveBeenCalled();

		const inspectionFailure = makePage({
			formHandleError: new Error("private form inspection failure"),
			inputs: [{}],
		});
		await expectSanitizedFailure(
			unlockStorefront(inspectionFailure.page),
			"private",
		);
		expect(inspectionFailure.inputHandle(0).dispose).toHaveBeenCalled();
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
		expect(wasSubmitted(fixture.formLocator(0))).toBe(false);
		expect(wasSubmitted(fixture.formLocator(1))).toBe(true);
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
