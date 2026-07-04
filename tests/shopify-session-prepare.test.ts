import type { Browser, BrowserContext, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	connectToChrome: vi.fn(),
	ensureChrome: vi.fn(),
	restoreAuthState: vi.fn(),
	saveAuthState: vi.fn(),
}));

vi.mock("../src/browser.js", () => ({
	delay: vi.fn(async () => undefined),
	ensureChrome: mocks.ensureChrome,
	fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/auth-state.js", () => ({
	connectToChrome: mocks.connectToChrome,
	restoreAuthState: mocks.restoreAuthState,
	saveAuthState: mocks.saveAuthState,
}));

const { prepareShopifySession, resetLiveShopifySessionForTests } = await import(
	"../src/shopify-session.js"
);

const config: ResolvedShopifyE2EConfig = {
	appUrl: "https://app.test",
	authStatePath: "/tmp/auth.json",
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/profile",
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

function loginRedirectPage(): Page {
	const adminUrl = "https://admin.shopify.com/store/example";
	const loginUrl = "https://accounts.shopify.com/login";
	let currentUrl = "about:blank";

	return {
		goto: vi.fn(async (url: string) => {
			currentUrl = url === adminUrl ? loginUrl : url;
			return null;
		}),
		isClosed: vi.fn(() => false),
		setDefaultNavigationTimeout: vi.fn(),
		setDefaultTimeout: vi.fn(),
		url: vi.fn(() => currentUrl),
	} as unknown as Page;
}

describe("prepareShopifySession", () => {
	beforeEach(() => {
		resetLiveShopifySessionForTests();
		mocks.connectToChrome.mockReset();
		mocks.ensureChrome.mockReset();
		mocks.restoreAuthState.mockReset();
		mocks.saveAuthState.mockReset();
		mocks.ensureChrome.mockResolvedValue({
			cdpUrl: config.cdpUrl,
			profilePath: config.chromeProfilePath,
			started: false,
		});
		mocks.restoreAuthState.mockResolvedValue({
			path: config.authStatePath,
			restored: false,
		});
	});

	it("does not throw or save auth state when login waiting is disabled", async () => {
		const page = loginRedirectPage();
		const browser = {
			isConnected: () => true,
		} as Browser;
		const context = {
			pages: () => [page],
		} as unknown as BrowserContext;
		mocks.connectToChrome.mockResolvedValue({ browser, context });

		await expect(
			prepareShopifySession(config, { waitForLogin: false }),
		).resolves.toMatchObject({
			authStateSaved: false,
			page,
		});
		expect(page.url()).toBe("https://accounts.shopify.com/login");
		expect(mocks.saveAuthState).not.toHaveBeenCalled();
	});
});
