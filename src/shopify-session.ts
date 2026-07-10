import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright-core";
import {
	emptyShopifyStorageState,
	loadAuthProfile,
	loadCaptureTargetAuthProfile,
	saveAuthProfile,
} from "./auth-profile.js";
import {
	assertLoopbackCdpUrl,
	delay,
	ensureChrome,
	type FetchLike,
	fetchWithTimeout,
	waitForCdp,
} from "./browser.js";
import {
	assertInteractiveInput,
	type InteractiveInput,
	type InteractiveSignals,
	waitForInteractiveConfirmation,
} from "./interactive-session.js";
import {
	missingLiveShopifyPrerequisites,
	type ResolvedShopifyAuthProfile,
	type ResolvedShopifyE2EConfig,
} from "./shopify-e2e-config.js";
import {
	adminStoreUrl,
	devtoolsListUrl,
	isShopifyAdminUrl,
	isShopifyLoginUrl,
} from "./urls.js";

export type ShopifySessionState =
	| "chrome-unreachable"
	| "login-required"
	| "missing-config"
	| "no-pages"
	| "ready";

export interface DevtoolsTarget {
	title?: string;
	type?: string;
	url?: string;
}

export interface ShopifySessionInspection {
	pageUrls: string[];
	reason?: string;
	state: ShopifySessionState;
}

export interface LiveShopifyPage {
	context: BrowserContext;
	page: Page;
}

export interface PreparedShopifySession extends LiveShopifyPage {
	authProfile: ResolvedShopifyAuthProfile;
	browser: Browser;
	chromeStarted: boolean;
}

export interface PrepareShopifySessionOptions {
	fetch?: FetchLike;
	log?: (message: string) => void;
	pollIntervalMs?: number;
	timeoutMs?: number;
	waitForLogin?: boolean;
}

export interface CaptureShopifyAuthProfileOptions {
	empty?: boolean;
	fromAuthProfile?: ResolvedShopifyAuthProfile;
	input?: InteractiveInput;
	log?: (message: string) => void;
	signals?: InteractiveSignals;
	warn?: (message: string) => void;
}

export interface CaptureShopifyAuthProfileResult {
	chromeStarted: boolean;
	profile: ResolvedShopifyAuthProfile;
	saved: boolean;
}

type RunnableShopifyConfig = ResolvedShopifyE2EConfig & { shopDomain: string };

let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

export async function prepareShopifySession(
	config: ResolvedShopifyE2EConfig,
	options: PrepareShopifySessionOptions = {},
): Promise<PreparedShopifySession> {
	assertRunnableConfig(config);

	const adminUrl = adminStoreUrl(config.shopDomain);
	const chrome = await ensureChrome(config, adminUrl, {
		fetch: options.fetch,
	});
	const { browser, context } = await liveShopifyBrowser(config);
	const page = await reusableLiveShopifyPage(context, config);

	await page.goto(adminUrl, {
		timeout: 45_000,
		waitUntil: "domcontentloaded",
	});
	await waitForLoggedInShopifyAdmin(page, config, options);

	return {
		authProfile: config.authProfile,
		browser,
		chromeStarted: chrome.started,
		context,
		page,
	};
}

export async function captureShopifyAuthProfile(
	config: ResolvedShopifyE2EConfig,
	options: CaptureShopifyAuthProfileOptions = {},
): Promise<CaptureShopifyAuthProfileResult> {
	assertRunnableConfig(config);

	if (options.empty && options.fromAuthProfile) {
		throw new Error(
			"Shopify auth profile capture cannot combine empty state with a base profile.",
		);
	}

	assertInteractiveInput(options.input);
	assertLoopbackCdpUrl(config.cdpUrl);

	const storageState = options.empty
		? emptyShopifyStorageState()
		: options.fromAuthProfile
			? await loadAuthProfile(options.fromAuthProfile)
			: ((await loadCaptureTargetAuthProfile(config.authProfile)) ??
				emptyShopifyStorageState());
	const adminUrl = adminStoreUrl(config.shopDomain);
	const chrome = await ensureChrome(config, adminUrl);
	const browser = await connectToChrome(config);
	let context: BrowserContext | undefined;

	try {
		context = await browser.newContext({ storageState });
		const page = await context.newPage();
		page.setDefaultTimeout(30_000);
		page.setDefaultNavigationTimeout(45_000);
		await page.goto(adminUrl, {
			timeout: 45_000,
			waitUntil: "domcontentloaded",
		});
		options.log?.(
			`Complete login for Shopify auth profile ${JSON.stringify(config.authProfile.name)}, then press Enter to save. Closing the page or pressing Ctrl-C cancels.`,
		);

		const confirmation = await waitForInteractiveConfirmation({
			input: options.input,
			page,
			signals: options.signals,
		});

		if (confirmation === "cancelled") {
			return {
				chromeStarted: chrome.started,
				profile: config.authProfile,
				saved: false,
			};
		}

		const capturedState = await context.storageState({ indexedDB: true });
		await saveAuthProfile(config.authProfile, capturedState, {
			warn: options.warn,
		});

		return {
			chromeStarted: chrome.started,
			profile: config.authProfile,
			saved: true,
		};
	} finally {
		try {
			await context?.close();
		} finally {
			if (browser.isConnected()) {
				await browser.close();
			}
		}
	}
}

export async function createLiveShopifyPage(
	config: ResolvedShopifyE2EConfig,
): Promise<LiveShopifyPage> {
	assertRunnableConfig(config);

	const { context } = await liveShopifyBrowser(config);
	const page = await reusableLiveShopifyPage(context, config);
	page.setDefaultTimeout(30_000);
	page.setDefaultNavigationTimeout(45_000);

	return {
		context,
		page,
	};
}

export async function openLiveShopifyPage(
	config: ResolvedShopifyE2EConfig,
	url: string,
): Promise<LiveShopifyPage> {
	const session = await createLiveShopifyPage(config);

	try {
		await gotoLiveShopifyPage(session.page, url);
	} catch (error) {
		throw new Error(`Could not open live Shopify page at ${url}.`, {
			cause: error,
		});
	}

	return session;
}

export async function gotoLiveShopifyPage(
	page: Page,
	url: string,
): Promise<void> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
}

export async function inspectShopifySession(
	config: ResolvedShopifyE2EConfig,
	options: { fetch?: FetchLike } = {},
): Promise<ShopifySessionInspection> {
	if (!config.shopDomain) {
		return {
			pageUrls: [],
			reason: "Missing Shopify shop domain.",
			state: "missing-config",
		};
	}

	const { shopDomain } = config;

	try {
		const response = await fetchWithTimeout(
			devtoolsListUrl(config.cdpUrl),
			{
				fetch: options.fetch,
				timeoutMs: 2_500,
			},
		);

		if (!response.ok) {
			return {
				pageUrls: [],
				reason: `Chrome DevTools responded with HTTP ${response.status}.`,
				state: "chrome-unreachable",
			};
		}

		const pageUrls = pageUrlsFromTargets(
			(await response.json()) as DevtoolsTarget[],
		);

		if (pageUrls.length === 0) {
			return {
				pageUrls,
				reason: "Chrome is open, but it has no inspectable page tabs.",
				state: "no-pages",
			};
		}

		if (pageUrls.some((url) => isReadyAdminUrl(url, shopDomain))) {
			return { pageUrls, state: "ready" };
		}

		return {
			pageUrls,
			reason: `Chrome is open, but no tab is logged into Shopify Admin for ${shopDomain}.`,
			state: "login-required",
		};
	} catch (error) {
		return {
			pageUrls: [],
			reason: `Could not connect to Chrome at ${config.cdpUrl}: ${errorMessage(error)}`,
			state: "chrome-unreachable",
		};
	}
}

export async function disconnectLiveShopifySession(): Promise<void> {
	const browser = sharedBrowser;
	const context = sharedContext;

	sharedBrowser = null;
	sharedContext = null;
	sharedPage = null;

	try {
		await context?.close();
	} finally {
		if (browser?.isConnected()) {
			await browser.close();
		}
	}
}

export function resetLiveShopifySessionForTests(): void {
	sharedBrowser = null;
	sharedContext = null;
	sharedPage = null;
}

async function liveShopifyBrowser(
	config: ResolvedShopifyE2EConfig,
): Promise<{ browser: Browser; context: BrowserContext }> {
	if (sharedBrowser?.isConnected() && sharedContext) {
		return { browser: sharedBrowser, context: sharedContext };
	}

	assertLoopbackCdpUrl(config.cdpUrl);
	const storageState = await loadAuthProfile(config.authProfile);
	const browser = await connectToChrome(config);
	let context: BrowserContext;

	try {
		context = await browser.newContext({ storageState });
	} catch (error) {
		if (browser.isConnected()) {
			await browser.close();
		}

		throw error;
	}

	sharedBrowser = browser;
	sharedContext = context;

	return { browser, context };
}

async function connectToChrome(
	config: ResolvedShopifyE2EConfig,
): Promise<Browser> {
	assertLoopbackCdpUrl(config.cdpUrl);
	await waitForCdp(config.cdpUrl);

	return chromium.connectOverCDP(config.cdpUrl, {
		isLocal: true,
		noDefaults: true,
		timeout: 30_000,
	});
}

async function reusableLiveShopifyPage(
	context: BrowserContext,
	config: ResolvedShopifyE2EConfig,
): Promise<Page> {
	const pages = context.pages().filter((page) => !page.isClosed());
	const page =
		sharedPage && !sharedPage.isClosed()
			? sharedPage
			: (findShopifyAdminPage(pages, config) ??
				pages[0] ??
				(await context.newPage()));

	sharedPage = page;

	for (const extraPage of pages) {
		if (extraPage !== page) {
			await extraPage.close().catch(() => undefined);
		}
	}

	return page;
}

function findShopifyAdminPage(
	pages: Page[],
	config: ResolvedShopifyE2EConfig,
): Page | undefined {
	const { shopDomain } = config;

	if (!shopDomain) {
		return undefined;
	}

	return pages.find((page) => isReadyAdminUrl(page.url(), shopDomain));
}

async function waitForLoggedInShopifyAdmin(
	page: Page,
	config: ResolvedShopifyE2EConfig,
	options: PrepareShopifySessionOptions,
): Promise<boolean> {
	const waitForLogin = options.waitForLogin ?? true;
	const timeoutMs = options.timeoutMs;
	const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
	let prompted = false;

	for (;;) {
		const url = page.url();

		if (config.shopDomain && isReadyAdminUrl(url, config.shopDomain)) {
			return true;
		}

		if (!waitForLogin) {
			return false;
		}

		if (!process.stdin.isTTY) {
			throw new Error(loginPrompt(config, url));
		}

		if (!prompted) {
			options.log?.(loginPrompt(config, url));
			prompted = true;
		}

		if (deadline && Date.now() > deadline) {
			throw new Error(
				`Timed out waiting for Shopify Admin login for ${config.shopDomain}.`,
			);
		}

		await delay(options.pollIntervalMs ?? 2_000);
	}
}

function pageUrlsFromTargets(targets: DevtoolsTarget[]): string[] {
	return targets
		.filter((target) => target.type === "page")
		.map((target) => target.url)
		.filter((url): url is string => Boolean(url));
}

function isReadyAdminUrl(url: string, shopDomain: string): boolean {
	return isShopifyAdminUrl(url, shopDomain) && !isShopifyLoginUrl(url);
}

function assertRunnableConfig(
	config: ResolvedShopifyE2EConfig,
): asserts config is RunnableShopifyConfig {
	const missing = missingLiveShopifyPrerequisites(config, {
		requireAppUrl: false,
	});

	if (missing.length > 0) {
		throw new Error(
			`Missing live Shopify e2e prerequisites: ${missing.join(", ")}`,
		);
	}
}

function loginPrompt(
	config: ResolvedShopifyE2EConfig,
	currentUrl: string,
): string {
	const adminUrl = config.shopDomain
		? adminStoreUrl(config.shopDomain)
		: "the configured Shopify Admin URL";

	return [
		"",
		"Shopify e2e is waiting for a logged-in Admin session.",
		`Open or complete login in Chrome: ${adminUrl}`,
		currentUrl ? `Current page: ${currentUrl}` : null,
		"The CLI will keep checking and continue automatically after login completes.",
		"",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
