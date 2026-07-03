import type { Browser, BrowserContext, Page } from "playwright-core";

import { delay, ensureChrome, fetchWithTimeout, type FetchLike } from "./browser.js";
import { connectToChrome, restoreAuthState, saveAuthState } from "./auth-state.js";
import {
	missingLiveShopifyPrerequisites,
	type ResolvedShopifyE2EConfig,
} from "./config.js";
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
	close(): Promise<void>;
}

export interface PreparedShopifySession extends LiveShopifyPage {
	authStatePath: string;
	authStateRestored: boolean;
	authStateSaved: boolean;
	browser: Browser;
	chromeStarted: boolean;
}

export interface PrepareShopifySessionOptions {
	fetch?: FetchLike;
	log?: (message: string) => void;
	pollIntervalMs?: number;
	saveAuthState?: boolean;
	timeoutMs?: number;
	waitForLogin?: boolean;
}

let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

export async function prepareShopifySession(
	config: ResolvedShopifyE2EConfig,
	options: PrepareShopifySessionOptions = {},
): Promise<PreparedShopifySession> {
	assertRunnableConfig(config);

	const adminUrl = adminStoreUrl(config.shopDomain as string);
	const chrome = await ensureChrome(config, adminUrl, { fetch: options.fetch });
	const { browser, context } = await liveShopifyBrowser(config);
	const page = await reusableLiveShopifyPage(context, config);
	const restore = await restoreAuthState(config, context, page);

	await page.goto(adminUrl, { timeout: 45_000, waitUntil: "domcontentloaded" });
	const loggedIn = await waitForLoggedInShopifyAdmin(page, config, options);
	const authStateSaved = loggedIn && options.saveAuthState !== false;

	if (authStateSaved) {
		await saveAuthState(config, context);
	}

	return {
		authStatePath: config.authStatePath,
		authStateRestored: restore.restored,
		authStateSaved,
		browser,
		chromeStarted: chrome.started,
		close: async () => undefined,
		context,
		page,
	};
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
		close: async () => undefined,
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
		await session.close();
		throw error;
	}

	return session;
}

export async function gotoLiveShopifyPage(page: Page, url: string): Promise<void> {
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

	try {
		const response = await fetchWithTimeout(devtoolsListUrl(config.cdpUrl), {
			fetch: options.fetch,
			timeoutMs: 2_500,
		});

		if (!response.ok) {
			return {
				pageUrls: [],
				reason: `Chrome DevTools responded with HTTP ${response.status}.`,
				state: "chrome-unreachable",
			};
		}

		const targets = (await response.json()) as DevtoolsTarget[];
		const pageUrls = targets
			.filter((target) => target.type === "page")
			.map((target) => target.url)
			.filter((url): url is string => Boolean(url));

		if (pageUrls.length === 0) {
			return {
				pageUrls,
				reason: "Chrome is open, but it has no inspectable page tabs.",
				state: "no-pages",
			};
		}

		if (
			pageUrls.some(
				(url) =>
					isShopifyAdminUrl(url, config.shopDomain as string) &&
					!isShopifyLoginUrl(url),
			)
		) {
			return { pageUrls, state: "ready" };
		}

		return {
			pageUrls,
			reason: `Chrome is open, but no tab is logged into Shopify Admin for ${config.shopDomain}.`,
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

	const { browser, context } = await connectToChrome(config);

	sharedBrowser = browser;
	sharedContext = context;

	return { browser, context };
}

async function reusableLiveShopifyPage(
	context: BrowserContext,
	config: ResolvedShopifyE2EConfig,
): Promise<Page> {
	const pages = context.pages().filter((page) => !page.isClosed());
	const page =
		sharedPage && !sharedPage.isClosed()
			? sharedPage
			: (findShopifyAdminPage(pages, config) ?? pages[0] ?? (await context.newPage()));

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
	if (!config.shopDomain) {
		return undefined;
	}

	return pages.find(
		(page) =>
			isShopifyAdminUrl(page.url(), config.shopDomain as string) &&
			!isShopifyLoginUrl(page.url()),
	);
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

		if (
			config.shopDomain &&
			isShopifyAdminUrl(url, config.shopDomain) &&
			!isShopifyLoginUrl(url)
		) {
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

function assertRunnableConfig(config: ResolvedShopifyE2EConfig): void {
	const missing = missingLiveShopifyPrerequisites(config, { requireAppUrl: false });

	if (missing.length > 0) {
		throw new Error(
			`Missing live Shopify e2e prerequisites: ${missing.join(", ")}`,
		);
	}
}

function loginPrompt(config: ResolvedShopifyE2EConfig, currentUrl: string): string {
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
