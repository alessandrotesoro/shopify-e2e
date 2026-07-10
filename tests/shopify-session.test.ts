import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/browser.js";
import type {
	ResolvedShopifyAuthProfile,
	ResolvedShopifyE2EConfig,
} from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	connectOverCDP: vi.fn(),
	loadAuthProfile: vi.fn(),
	waitForCdp: vi.fn(),
}));

vi.mock("playwright-core", () => ({
	chromium: { connectOverCDP: mocks.connectOverCDP },
}));

vi.mock("../src/auth-profile.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../src/auth-profile.js")>();

	return {
		...original,
		loadAuthProfile: mocks.loadAuthProfile,
	};
});

vi.mock("../src/browser.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/browser.js")>();

	return {
		...original,
		waitForCdp: mocks.waitForCdp,
	};
});

const {
	createLiveShopifyPage,
	createShopifyRuntimeSession,
	inspectShopifySession,
	resetShopifyRuntimeLeaseForTests,
} = await import("../src/shopify-session.js");

function profile(name: string): ResolvedShopifyAuthProfile {
	return {
		name,
		storageStatePath: `/tmp/profiles/${name}.json`,
	};
}

function config(
	authProfile = profile("customer-a"),
	cdpUrl = "http://127.0.0.1:9222",
): ResolvedShopifyE2EConfig {
	return {
		appUrl: "https://app.test",
		authProfile,
		cdpPort: "9222",
		cdpUrl,
		chromeProfilePath: "/tmp/chrome",
		cwd: "/tmp",
		live: true,
		shopDomain: "example.myshopify.com",
		testCommand: {
			args: ["playwright", "test"],
			command: "npx",
			mode: "playwright",
			shell: false,
		},
		testFiles: [],
	};
}

function fakeBrowser(
	options: { contextCloseError?: Error; newContextError?: Error } = {},
) {
	const page = {
		isClosed: vi.fn(() => false),
		setDefaultNavigationTimeout: vi.fn(),
		setDefaultTimeout: vi.fn(),
	};
	const contextClose = options.contextCloseError
		? vi.fn(async () => {
				throw options.contextCloseError;
			})
		: vi.fn(async () => undefined);
	const newPage = vi.fn(async () => page);
	const context = {
		close: contextClose,
		newPage,
	};
	const newContext = options.newContextError
		? vi.fn(async () => {
				throw options.newContextError;
			})
		: vi.fn(async () => context);
	const browserClose = vi.fn(async () => undefined);
	const browser = {
		close: browserClose,
		isConnected: vi.fn(() => true),
		newContext,
	};

	return {
		browser,
		browserClose,
		context,
		contextClose,
		newContext,
		newPage,
		page,
	};
}

describe("Shopify runtime session", () => {
	beforeEach(() => {
		resetShopifyRuntimeLeaseForTests();
		mocks.connectOverCDP.mockReset();
		mocks.loadAuthProfile.mockReset();
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.waitForCdp.mockReset();
		mocks.waitForCdp.mockResolvedValue(undefined);
	});

	it("acquires the lease at creation before any browser work", async () => {
		resetShopifyRuntimeLeaseForTests();
		const customerA = createShopifyRuntimeSession(config());

		expect(() =>
			createShopifyRuntimeSession(config(profile("customer-b"))),
		).toThrow("A Shopify runtime session is already active");
		expect(mocks.loadAuthProfile).not.toHaveBeenCalled();
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();

		await customerA.close();
	});

	it("copies and freezes the selected profile and runtime config", async () => {
		resetShopifyRuntimeLeaseForTests();
		const selectedProfile = profile("customer-a");
		const selectedConfig = config(selectedProfile);
		const fake = fakeBrowser();
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		mocks.waitForCdp.mockResolvedValue(undefined);
		const session = createShopifyRuntimeSession(selectedConfig);

		selectedProfile.name = "customer-b";
		selectedProfile.storageStatePath = "/tmp/profiles/customer-b.json";
		selectedConfig.cdpUrl = "http://127.0.0.1:9333";

		await session.page();

		expect(session.authProfile).toEqual({
			name: "customer-a",
			storageStatePath: "/tmp/profiles/customer-a.json",
		});
		expect(Object.isFrozen(session.authProfile)).toBe(true);
		expect(Object.isFrozen(session.config)).toBe(true);
		expect(mocks.loadAuthProfile).toHaveBeenCalledWith({
			name: "customer-a",
			storageStatePath: "/tmp/profiles/customer-a.json",
		});
		expect(mocks.connectOverCDP).toHaveBeenCalledWith(
			"http://127.0.0.1:9222",
			expect.any(Object),
		);
		expect(fake.newContext).toHaveBeenCalledWith({
			storageState: "/tmp/profiles/customer-a.json",
			viewport: null,
		});

		await session.close();
	});

	it("rejects remote CDP before reading the selected bearer profile", async () => {
		resetShopifyRuntimeLeaseForTests();
		const session = createShopifyRuntimeSession(
			config(profile("customer-a"), "https://cdp.example.com"),
		);

		await expect(session.page()).rejects.toThrow(
			"Shopify auth profiles require a loopback CDP URL",
		);
		expect(mocks.loadAuthProfile).not.toHaveBeenCalled();
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();

		const replacement = createShopifyRuntimeSession(
			config(profile("customer-b")),
		);
		await replacement.close();
	});

	it("creates one isolated context and reuses exactly one owned page", async () => {
		resetShopifyRuntimeLeaseForTests();
		const fake = fakeBrowser();
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		mocks.waitForCdp.mockResolvedValue(undefined);
		const session = createShopifyRuntimeSession(config());

		const [firstPage, secondPage] = await Promise.all([
			session.page(),
			session.page(),
		]);

		expect(firstPage).toBe(fake.page);
		expect(secondPage).toBe(fake.page);
		expect(fake.newContext).toHaveBeenCalledOnce();
		expect(fake.newPage).toHaveBeenCalledOnce();
		expect("contexts" in fake.browser).toBe(false);

		await session.close();
	});

	it("releases an unactivated lease and permits close-then-create switching", async () => {
		resetShopifyRuntimeLeaseForTests();
		const customerA = createShopifyRuntimeSession(config());

		await customerA.close();
		await customerA.close();

		const customerB = createShopifyRuntimeSession(
			config(profile("customer-b")),
		);
		expect(customerB.authProfile.name).toBe("customer-b");
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();
		await customerB.close();
	});

	it("releases the lease and disconnects when initialization fails", async () => {
		resetShopifyRuntimeLeaseForTests();
		const fake = fakeBrowser({
			newContextError: new Error("context failed"),
		});
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		mocks.waitForCdp.mockResolvedValue(undefined);
		const customerA = createShopifyRuntimeSession(config());

		await expect(customerA.page()).rejects.toThrow("context failed");
		expect(fake.browserClose).toHaveBeenCalledOnce();

		const customerB = createShopifyRuntimeSession(
			config(profile("customer-b")),
		);
		await customerB.close();
	});

	it("releases ownership and disconnects even when context close fails", async () => {
		resetShopifyRuntimeLeaseForTests();
		const closeError = new Error("context close failed");
		const fake = fakeBrowser({ contextCloseError: closeError });
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		mocks.waitForCdp.mockResolvedValue(undefined);
		const customerA = createShopifyRuntimeSession(config());
		await customerA.page();

		await expect(customerA.close()).rejects.toThrow("context close failed");
		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
		expect(fake.contextClose.mock.invocationCallOrder[0]).toBeLessThan(
			fake.browserClose.mock.invocationCallOrder[0] ??
				Number.POSITIVE_INFINITY,
		);

		const customerB = createShopifyRuntimeSession(
			config(profile("customer-b")),
		);
		await customerB.close();
	});

	it("validates a missing or malformed selected profile without fallback", async () => {
		resetShopifyRuntimeLeaseForTests();
		mocks.loadAuthProfile.mockRejectedValue(
			new Error("selected profile is malformed"),
		);
		const session = createShopifyRuntimeSession(config());

		await expect(session.page()).rejects.toThrow(
			"selected profile is malformed",
		);
		expect(mocks.connectOverCDP).not.toHaveBeenCalled();

		const replacement = createShopifyRuntimeSession(
			config(profile("customer-b")),
		);
		await replacement.close();
	});

	it("closes only the owned context and CDP connection", async () => {
		resetShopifyRuntimeLeaseForTests();
		const fake = fakeBrowser();
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		mocks.waitForCdp.mockResolvedValue(undefined);
		const session = createShopifyRuntimeSession(config());
		await session.page();

		await session.close();
		await session.close();

		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
		expect("kill" in fake.browser).toBe(false);
	});

	it("gives the advanced live-page handle an idempotent real close", async () => {
		const fake = fakeBrowser();
		mocks.connectOverCDP.mockResolvedValue(fake.browser);
		const livePage = await createLiveShopifyPage(config());

		await livePage.close();
		await livePage.close();

		expect(fake.contextClose).toHaveBeenCalledOnce();
		expect(fake.browserClose).toHaveBeenCalledOnce();
	});
});

describe("inspectShopifySession", () => {
	it("reports ready when an admin tab for the shop exists", async () => {
		const fetchImpl: FetchLike = async () => ({
			json: async () => [
				{
					type: "page",
					url: "https://admin.shopify.com/store/example/apps/app",
				},
			],
			ok: true,
			status: 200,
		});

		await expect(
			inspectShopifySession(config(), { fetch: fetchImpl }),
		).resolves.toMatchObject({
			state: "ready",
		});
	});

	it("reports login-required when pages do not include the configured admin", async () => {
		const fetchImpl: FetchLike = async () => ({
			json: async () => [
				{
					type: "page",
					url: "https://accounts.shopify.com/login",
				},
			],
			ok: true,
			status: 200,
		});

		await expect(
			inspectShopifySession(config(), { fetch: fetchImpl }),
		).resolves.toMatchObject({
			state: "login-required",
		});
	});
});
