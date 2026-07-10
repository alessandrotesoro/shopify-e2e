import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { Browser, BrowserContext, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	ResolvedShopifyAuthProfile,
	ResolvedShopifyE2EConfig,
} from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	connectOverCDP: vi.fn(),
	ensureChrome: vi.fn(),
	waitForCdp: vi.fn(),
}));

vi.mock("playwright-core", () => ({
	chromium: { connectOverCDP: mocks.connectOverCDP },
}));

vi.mock("../src/browser.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/browser.js")>();

	return {
		...original,
		ensureChrome: mocks.ensureChrome,
		waitForCdp: mocks.waitForCdp,
	};
});

const { captureShopifyAuthProfile } = await import("../src/shopify-session.js");

interface FakeBrowserParts {
	browser: Browser;
	browserClose: ReturnType<typeof vi.fn>;
	context: BrowserContext;
	contextClose: ReturnType<typeof vi.fn>;
	newContext: ReturnType<typeof vi.fn>;
	page: Page & EventEmitter;
	storageState: ReturnType<typeof vi.fn>;
}

function terminalInput(): PassThrough & { isTTY: boolean } {
	const input = new PassThrough() as PassThrough & { isTTY: boolean };
	input.isTTY = true;

	return input;
}

async function configFor(
	directory: string,
	name = "customer-a",
	cdpUrl = "http://127.0.0.1:9222",
): Promise<ResolvedShopifyE2EConfig> {
	return {
		appUrl: "https://app.test",
		authProfile: profile(directory, name),
		cdpPort: "9222",
		cdpUrl,
		chromeProfilePath: join(directory, "chrome"),
		cwd: directory,
		live: true,
		shopDomain: "example.myshopify.com",
		testCommand: {
			args: ["playwright", "test"],
			command: "npx",
		},
		testFiles: [],
	};
}

function profile(directory: string, name: string): ResolvedShopifyAuthProfile {
	return {
		name,
		storageStatePath: join(directory, "profiles", `${name}.json`),
	};
}

function fakeBrowser(
	state = {
		cookies: [],
		origins: [
			{
				indexedDB: [{ name: "shopify-auth", stores: [] }],
				localStorage: [],
				origin: "https://shop.app",
			},
		],
	},
): FakeBrowserParts {
	const page = new EventEmitter() as Page & EventEmitter;
	Object.assign(page, {
		goto: vi.fn(async () => null),
		isClosed: vi.fn(() => false),
		setDefaultNavigationTimeout: vi.fn(),
		setDefaultTimeout: vi.fn(),
		url: vi.fn(() => "https://admin.shopify.com/store/example"),
	});
	const contextClose = vi.fn(async () => undefined);
	const storageState = vi.fn(async () => state);
	const context = {
		close: contextClose,
		newPage: vi.fn(async () => page),
		storageState,
	} as unknown as BrowserContext;
	const newContext = vi.fn(async () => context);
	const browserClose = vi.fn(async () => undefined);
	const browser = {
		close: browserClose,
		isConnected: vi.fn(() => true),
		newContext,
	} as unknown as Browser;

	return {
		browser,
		browserClose,
		context,
		contextClose,
		newContext,
		page,
		storageState,
	};
}

async function writeProfile(
	selectedProfile: ResolvedShopifyAuthProfile,
	state: unknown,
): Promise<void> {
	await mkdir(join(selectedProfile.storageStatePath, ".."), {
		recursive: true,
	});
	await writeFile(
		selectedProfile.storageStatePath,
		typeof state === "string" ? state : JSON.stringify(state),
		"utf8",
	);
}

async function confirmCapture(
	config: ResolvedShopifyE2EConfig,
	options: Parameters<typeof captureShopifyAuthProfile>[1] = {},
): Promise<Awaited<ReturnType<typeof captureShopifyAuthProfile>>> {
	const input = terminalInput();
	const result = captureShopifyAuthProfile(config, {
		...options,
		input,
	});
	queueMicrotask(() => input.write("\n"));

	return result;
}

describe("captureShopifyAuthProfile", () => {
	beforeEach(() => {
		mocks.connectOverCDP.mockReset();
		mocks.ensureChrome.mockReset();
		mocks.waitForCdp.mockReset();
		mocks.ensureChrome.mockResolvedValue({
			cdpUrl: "http://127.0.0.1:9222",
			profilePath: "/tmp/chrome",
			started: false,
		});
		mocks.waitForCdp.mockResolvedValue(undefined);
	});

	it("seeds from an existing target and saves IndexedDB only after Enter", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const selectedState = {
			cookies: [],
			origins: [
				{
					localStorage: [{ name: "customer", value: "a" }],
					origin: "https://shop.app",
				},
			],
		};
		await writeProfile(config.authProfile, selectedState);
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await expect(confirmCapture(config)).resolves.toMatchObject({
			profile: config.authProfile,
			saved: true,
		});
		expect(fake.newContext).toHaveBeenCalledWith({
			storageState: selectedState,
		});
		expect(fake.storageState).toHaveBeenCalledWith({ indexedDB: true });
		expect(
			JSON.parse(
				await readFile(config.authProfile.storageStatePath, "utf8"),
			),
		).toEqual(await fake.storageState.mock.results[0]?.value);
		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});

	it("uses an explicit base without reading a malformed existing target", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const baseProfile = profile(directory, "admin-base");
		const baseState = { cookies: [], origins: [] };
		await writeProfile(config.authProfile, "{malformed");
		await writeProfile(baseProfile, baseState);
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await confirmCapture(config, { fromAuthProfile: baseProfile });

		expect(fake.newContext).toHaveBeenCalledWith({
			storageState: baseState,
		});
	});

	it("requires an explicitly selected base profile to exist", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const baseProfile = profile(directory, "missing-base");

		await expect(
			captureShopifyAuthProfile(config, {
				fromAuthProfile: baseProfile,
				input: terminalInput(),
			}),
		).rejects.toThrow(
			`Shopify auth profile "missing-base" was not found at ${baseProfile.storageStatePath}.`,
		);
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();
	});

	it("uses explicit empty state even when the target exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		await writeProfile(config.authProfile, {
			cookies: [],
			origins: [{ localStorage: [], origin: "https://previous.example" }],
		});
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await confirmCapture(config, { empty: true });

		expect(fake.newContext).toHaveBeenCalledWith({
			storageState: { cookies: [], origins: [] },
		});
	});

	it("rejects combining empty state with a base profile", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);

		await expect(
			captureShopifyAuthProfile(config, {
				empty: true,
				fromAuthProfile: profile(directory, "admin-base"),
				input: terminalInput(),
			}),
		).rejects.toThrow(
			"Shopify auth profile capture cannot combine empty state with a base profile.",
		);
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();
	});

	it("starts a new target from empty state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		await writeProfile(profile(directory, "default"), {
			cookies: [],
			origins: [
				{
					localStorage: [{ name: "customer", value: "wrong" }],
					origin: "https://shop.app",
				},
			],
		});
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await confirmCapture(config);

		expect(fake.newContext).toHaveBeenCalledWith({
			storageState: { cookies: [], origins: [] },
		});
	});

	it("rejects non-loopback CDP before reading bearer state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(
			directory,
			"customer-a",
			"https://cdp.example.com",
		);
		await writeProfile(config.authProfile, "{malformed");

		await expect(
			captureShopifyAuthProfile(config, { input: terminalInput() }),
		).rejects.toThrow(
			"Shopify auth profiles require a loopback CDP URL; received https://cdp.example.com.",
		);
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();
	});

	it("rejects a malformed selected seed before creating a context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		await writeProfile(config.authProfile, "{malformed");
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await expect(
			captureShopifyAuthProfile(config, { input: terminalInput() }),
		).rejects.toThrow(
			`Invalid Shopify auth profile "customer-a" at ${config.authProfile.storageStatePath}`,
		);
		expect(fake.newContext).not.toHaveBeenCalled();
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();
	});

	it("rejects non-TTY capture before opening a browser", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const input = new PassThrough() as PassThrough & { isTTY?: boolean };

		await expect(
			captureShopifyAuthProfile(config, { input }),
		).rejects.toThrow(
			"Guided Shopify auth profile capture requires an interactive TTY.",
		);
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();
	});

	it.each([
		"page-close",
		"sigint",
	] as const)("cancels on %s and closes the bounded context and connection", async (reason) => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const fake = fakeBrowser();
		const input = terminalInput();
		const signals = new EventEmitter();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		const result = captureShopifyAuthProfile(config, { input, signals });
		await vi.waitFor(() => {
			expect(
				reason === "page-close"
					? fake.page.listenerCount("close")
					: signals.listenerCount("SIGINT"),
			).toBe(1);
		});
		if (reason === "page-close") {
			fake.page.emit("close");
		} else {
			signals.emit("SIGINT");
		}

		await expect(result).resolves.toMatchObject({ saved: false });
		expect(fake.storageState).not.toHaveBeenCalled();
		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});

	it("closes the CDP connection when context creation fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const fake = fakeBrowser();
		fake.newContext.mockRejectedValue(new Error("context failed"));
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await expect(
			captureShopifyAuthProfile(config, { input: terminalInput() }),
		).rejects.toThrow("context failed");
		expect(fake.contextClose).not.toHaveBeenCalled();
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});

	it("closes the context and connection when navigation fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const fake = fakeBrowser();
		vi.mocked(fake.page.goto).mockRejectedValue(
			new Error("navigation failed"),
		);
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await expect(
			captureShopifyAuthProfile(config, { input: terminalInput() }),
		).rejects.toThrow("navigation failed");
		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});

	it("closes the context and connection when snapshot persistence fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		await mkdir(config.authProfile.storageStatePath, { recursive: true });
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);

		await expect(confirmCapture(config, { empty: true })).rejects.toThrow(
			`Could not save Shopify auth profile "customer-a" at ${config.authProfile.storageStatePath}.`,
		);
		expect(fake.storageState).toHaveBeenCalledWith({ indexedDB: true });
		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});

	it("closes the connection even when context cleanup fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-capture-"));
		const config = await configFor(directory);
		const fake = fakeBrowser();
		fake.contextClose.mockRejectedValue(new Error("context close failed"));
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		const input = terminalInput();
		const result = captureShopifyAuthProfile(config, { input });
		queueMicrotask(() => input.write("\n"));

		await expect(result).rejects.toThrow("context close failed");
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});
});
