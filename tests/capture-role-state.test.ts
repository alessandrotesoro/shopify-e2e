import { describe, expect, it, vi } from "vitest";

import {
	CaptureSignalError,
	captureBrowserRoleState,
} from "../src/auth/capture-role-state.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../src/errors.js";
import type { PlaywrightStorageState } from "../src/storage-state/schema.js";

const EMPTY_STORAGE_STATE: PlaywrightStorageState = {
	cookies: [],
	origins: [],
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
};

const makeLifecycle = () => {
	const listeners = new Map<string, () => void>();
	const page = {
		close: vi.fn(async () => undefined),
		goto: vi.fn(async () => undefined),
		off: vi.fn((event: string) => listeners.delete(`page:${event}`)),
		on: vi.fn((event: string, listener: () => void) =>
			listeners.set(`page:${event}`, listener),
		),
	};
	const capturedState = {
		cookies: [],
		origins: [
			{
				indexedDB: [],
				localStorage: [{ name: "identity", value: "admin" }],
				origin: "https://shop.example",
			},
		],
	};
	const context = {
		close: vi.fn(async () => undefined),
		newPage: vi.fn(async () => page),
		off: vi.fn((event: string) => listeners.delete(`context:${event}`)),
		on: vi.fn((event: string, listener: () => void) =>
			listeners.set(`context:${event}`, listener),
		),
		storageState: vi.fn<() => Promise<unknown>>(async () => capturedState),
	};
	const browser = {
		close: vi.fn(async () => undefined),
		newContext: vi.fn(async () => context),
		off: vi.fn((event: string) => listeners.delete(`browser:${event}`)),
		on: vi.fn((event: string, listener: () => void) =>
			listeners.set(`browser:${event}`, listener),
		),
	};
	return { browser, capturedState, context, listeners, page };
};

describe("browser role-state capture lifecycle", () => {
	it("captures IndexedDB-inclusive state after explicit confirmation", async () => {
		const lifecycle = makeLifecycle();
		const report = vi.fn();
		const launchChromium = vi.fn(async () => lifecycle.browser);
		const result = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium,
				report,
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		});

		expect(result).toEqual({
			state: lifecycle.capturedState,
			status: "captured",
		});
		expect(lifecycle.browser.newContext).toHaveBeenCalledWith({
			storageState: EMPTY_STORAGE_STATE,
		});
		expect(launchChromium).toHaveBeenCalledOnce();
		expect(launchChromium).toHaveBeenCalledWith({ headless: false });
		expect(lifecycle.browser.newContext).toHaveBeenCalledOnce();
		expect(lifecycle.page.goto).toHaveBeenCalledWith("https://shop.example");
		expect(lifecycle.context.storageState).toHaveBeenCalledWith({
			indexedDB: true,
		});
		expect(report).toHaveBeenCalledWith(
			expect.stringMatching(/dedicated.*every origin/i),
		);
		expect(lifecycle.page.close).toHaveBeenCalledTimes(1);
		expect(lifecycle.context.close).toHaveBeenCalledTimes(1);
		expect(lifecycle.browser.close).toHaveBeenCalledTimes(1);
	});

	it("returns cancellation without state when save is declined", async () => {
		const lifecycle = makeLifecycle();
		await expect(
			captureBrowserRoleState({
				dependencies: {
					confirmSave: vi.fn(async () => false),
					launchChromium: vi.fn(async () => lifecycle.browser),
					report: vi.fn(),
				},
				initialState: EMPTY_STORAGE_STATE,
				origin: "https://shop.example",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ reason: "declined", status: "cancelled" });
		expect(lifecycle.context.storageState).not.toHaveBeenCalled();
	});

	it.each([
		["page", "page:close"],
		["context", "context:close"],
		["browser", "browser:disconnected"],
	])("cancels when the %s closes before confirmation", async (_label, event) => {
		const lifecycle = makeLifecycle();
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(() => new Promise<boolean>(() => undefined)),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		});
		await vi.waitFor(() => expect(lifecycle.page.on).toHaveBeenCalled());
		lifecycle.listeners.get(event)?.();

		await expect(resultPromise).resolves.toEqual({
			reason: "browser-closed",
			status: "cancelled",
		});
		expect(lifecycle.context.storageState).not.toHaveBeenCalled();
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it("interrupts a pending Chromium launch and closes a browser that resolves late", async () => {
		const lifecycle = makeLifecycle();
		const launch = deferred<typeof lifecycle.browser>();
		const controller = new AbortController();
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(() => launch.promise),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: controller.signal,
		});

		controller.abort("SIGINT");
		await expect(resultPromise).rejects.toMatchObject({ exitCode: 130 });
		launch.resolve(lifecycle.browser);
		await vi.waitFor(() =>
			expect(lifecycle.browser.close).toHaveBeenCalledOnce(),
		);
	});

	it("interrupts pending context and page creation and closes late resources", async () => {
		const lifecycle = makeLifecycle();
		const contextCreation = deferred<typeof lifecycle.context>();
		lifecycle.browser.newContext.mockImplementation(
			() => contextCreation.promise,
		);
		const contextController = new AbortController();
		const contextResult = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: contextController.signal,
		});
		await vi.waitFor(() =>
			expect(lifecycle.browser.newContext).toHaveBeenCalledOnce(),
		);
		contextController.abort("SIGTERM");
		await expect(contextResult).rejects.toMatchObject({ exitCode: 143 });
		contextCreation.resolve(lifecycle.context);
		await vi.waitFor(() =>
			expect(lifecycle.context.close).toHaveBeenCalledOnce(),
		);

		const secondLifecycle = makeLifecycle();
		const pageCreation = deferred<typeof secondLifecycle.page>();
		secondLifecycle.context.newPage.mockImplementation(
			() => pageCreation.promise,
		);
		const pageController = new AbortController();
		const pageResult = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => secondLifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: pageController.signal,
		});
		await vi.waitFor(() =>
			expect(secondLifecycle.context.newPage).toHaveBeenCalledOnce(),
		);
		pageController.abort("SIGINT");
		await expect(pageResult).rejects.toMatchObject({ exitCode: 130 });
		pageCreation.resolve(secondLifecycle.page);
		await vi.waitFor(() =>
			expect(secondLifecycle.page.close).toHaveBeenCalledOnce(),
		);
	});

	it("interrupts pending navigation without waiting for it to settle", async () => {
		const lifecycle = makeLifecycle();
		lifecycle.page.goto.mockImplementation(() => new Promise(() => undefined));
		const controller = new AbortController();
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(lifecycle.page.goto).toHaveBeenCalledOnce());
		controller.abort("SIGTERM");

		await expect(resultPromise).rejects.toMatchObject({ exitCode: 143 });
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it("treats page closure during pending navigation as cancellation", async () => {
		const lifecycle = makeLifecycle();
		lifecycle.page.goto.mockImplementation(() => new Promise(() => undefined));
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		});
		await vi.waitFor(() => expect(lifecycle.page.goto).toHaveBeenCalledOnce());
		lifecycle.listeners.get("page:close")?.();

		await expect(resultPromise).resolves.toEqual({
			reason: "browser-closed",
			status: "cancelled",
		});
		expect(lifecycle.context.storageState).not.toHaveBeenCalled();
	});

	it("treats prompt rejection after lifecycle abort as browser cancellation", async () => {
		const lifecycle = makeLifecycle();
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(
					({ signal }) =>
						new Promise<boolean>((_resolve, reject) => {
							signal.addEventListener(
								"abort",
								() => reject(new Error("prompt aborted after browser close")),
								{ once: true },
							);
						}),
				),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		});
		await vi.waitFor(() => expect(lifecycle.page.on).toHaveBeenCalled());
		lifecycle.listeners.get("browser:disconnected")?.();

		await expect(resultPromise).resolves.toEqual({
			reason: "browser-closed",
			status: "cancelled",
		});
	});

	it("uses only the supplied refresh state", async () => {
		const lifecycle = makeLifecycle();
		const previousState = {
			cookies: [],
			origins: [
				{
					localStorage: [{ name: "identity", value: "customer" }],
					origin: "https://shop.example",
				},
			],
		};
		await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: previousState,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		});

		expect(lifecycle.browser.newContext).toHaveBeenCalledWith({
			storageState: previousState,
		});
	});

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)("maps external %s abort and still closes every resource", async (signalName, exitCode) => {
		const lifecycle = makeLifecycle();
		const controller = new AbortController();
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(() => new Promise<boolean>(() => undefined)),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(lifecycle.page.on).toHaveBeenCalled());
		controller.abort(signalName);

		const error = await resultPromise.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(CaptureSignalError);
		expect(error).toMatchObject({ exitCode });
		expect(lifecycle.page.close).toHaveBeenCalledTimes(1);
		expect(lifecycle.context.close).toHaveBeenCalledTimes(1);
		expect(lifecycle.browser.close).toHaveBeenCalledTimes(1);
	});

	it.each([
		["page", "page:close"],
		["context", "context:close"],
		["browser", "browser:disconnected"],
	])("cancels when the %s closes after confirmation while state is being captured", async (_label, event) => {
		const lifecycle = makeLifecycle();
		lifecycle.context.storageState.mockImplementationOnce(
			() => new Promise<unknown>(() => undefined),
		);
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		});
		await vi.waitFor(() =>
			expect(lifecycle.context.storageState).toHaveBeenCalledWith({
				indexedDB: true,
			}),
		);
		lifecycle.listeners.get(event)?.();

		await expect(resultPromise).resolves.toEqual({
			reason: "browser-closed",
			status: "cancelled",
		});
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)("maps %s received after confirmation while capturing state to exit %s", async (signalName, exitCode) => {
		const lifecycle = makeLifecycle();
		lifecycle.context.storageState.mockImplementationOnce(
			() => new Promise<unknown>(() => undefined),
		);
		const controller = new AbortController();
		const resultPromise = captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: controller.signal,
		});
		await vi.waitFor(() =>
			expect(lifecycle.context.storageState).toHaveBeenCalled(),
		);
		controller.abort(signalName);

		const error = await resultPromise.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(CaptureSignalError);
		expect(error).toMatchObject({ exitCode });
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it("maps terminal prompt Ctrl+C to SIGINT without an infrastructure wrapper", async () => {
		const lifecycle = makeLifecycle();
		const promptError = new Error("internal Inquirer details");
		promptError.name = "ExitPromptError";

		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => {
					throw promptError;
				}),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CaptureSignalError);
		expect(error).toMatchObject({ exitCode: 130 });
		expect(error).not.toBe(promptError);
	});

	it.each([
		{
			arrange: (lifecycle: ReturnType<typeof makeLifecycle>) =>
				lifecycle.page.goto.mockRejectedValueOnce(
					new Error("secret navigation internals"),
				),
			label: "navigation",
		},
		{
			arrange: (lifecycle: ReturnType<typeof makeLifecycle>) =>
				lifecycle.context.storageState.mockRejectedValueOnce(
					new Error("secret state path"),
				),
			label: "storage capture",
		},
	])("sanitizes $label failures and closes all resources", async ({
		arrange,
	}) => {
		const lifecycle = makeLifecycle();
		arrange(lifecycle);
		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toBe(
			"Browser role-state capture could not complete",
		);
		expect((error as Error).message).not.toMatch(
			/secret|state path|internals/i,
		);
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it("sanitizes a generic confirmation prompt failure and closes resources", async () => {
		const lifecycle = makeLifecycle();
		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => {
					throw new Error("secret prompt internals");
				}),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toBe(
			"Browser role-state capture could not complete",
		);
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it.each([
		"https://shop.example/path?token=secret#fragment",
		"https://user:secret@shop.example",
	])("rejects a non-normalized origin before reporting or launching: %s", async (origin) => {
		const report = vi.fn();
		const launchChromium = vi.fn();
		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium,
				report,
			},
			initialState: EMPTY_STORAGE_STATE,
			origin,
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect((error as Error).message).not.toContain("secret");
		expect(report).not.toHaveBeenCalled();
		expect(launchChromium).not.toHaveBeenCalled();
	});

	it("sanitizes state-capture failures and closes all resources", async () => {
		const lifecycle = makeLifecycle();
		lifecycle.context.storageState.mockResolvedValueOnce({
			cookies: "secret-cookie",
			origins: [],
		});

		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect((error as Error).message).not.toContain("secret-cookie");
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it("surfaces sanitized cleanup failure after attempting every cleanup", async () => {
		const lifecycle = makeLifecycle();
		lifecycle.page.off.mockImplementationOnce(() => {
			throw new Error("secret listener internals");
		});
		lifecycle.page.close.mockRejectedValueOnce(
			new Error("secret browser role-state path"),
		);

		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => lifecycle.browser),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toBe(
			"Browser role-state capture cleanup could not complete",
		);
		expect(lifecycle.page.close).toHaveBeenCalledOnce();
		expect(lifecycle.context.close).toHaveBeenCalledOnce();
		expect(lifecycle.browser.close).toHaveBeenCalledOnce();
	});

	it("sanitizes browser launch failures as infrastructure errors", async () => {
		const error = await captureBrowserRoleState({
			dependencies: {
				confirmSave: vi.fn(async () => true),
				launchChromium: vi.fn(async () => {
					throw new Error("secret executable path and cookie");
				}),
				report: vi.fn(),
			},
			initialState: EMPTY_STORAGE_STATE,
			origin: "https://shop.example",
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toBe("Consumer Chromium could not launch");
		expect((error as Error).message).not.toMatch(
			/secret|cookie|executable path/i,
		);
	});
});
