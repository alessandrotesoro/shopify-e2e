import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright-core";

import {
	ensureParentDirectory,
	type ResolvedShopifyE2EConfig,
} from "./config.js";
import { waitForCdp } from "./browser.js";
import { adminStoreUrl } from "./urls.js";

export interface ConnectedChrome {
	browser: Browser;
	context: BrowserContext;
}

export interface AuthStateRestoreResult {
	path: string;
	restored: boolean;
}

interface StorageStateFile {
	cookies?: unknown[];
	origins?: Array<{
		localStorage?: Array<{ name: string; value: string }>;
		origin?: string;
	}>;
}

export async function connectToChrome(
	config: ResolvedShopifyE2EConfig,
): Promise<ConnectedChrome> {
	await waitForCdp(config.cdpUrl);

	const browser = await chromium.connectOverCDP(config.cdpUrl, {
		isLocal: true,
		noDefaults: true,
		timeout: 30_000,
	});
	const context = browser.contexts()[0];

	if (!context) {
		throw new Error(`No Chrome context was available at ${config.cdpUrl}.`);
	}

	return { browser, context };
}

export async function saveAuthState(
	config: ResolvedShopifyE2EConfig,
	context?: BrowserContext,
): Promise<{ path: string }> {
	const targetContext = context ?? (await connectToChrome(config)).context;

	await ensureParentDirectory(config.authStatePath);
	await targetContext.storageState({ path: config.authStatePath });

	return { path: config.authStatePath };
}

export async function restoreAuthState(
	config: ResolvedShopifyE2EConfig,
	context?: BrowserContext,
	page?: Page,
): Promise<AuthStateRestoreResult> {
	if (!existsSync(config.authStatePath)) {
		return { path: config.authStatePath, restored: false };
	}

	const targetContext = context ?? (await connectToChrome(config)).context;
	const state = JSON.parse(
		await readFile(config.authStatePath, "utf8"),
	) as StorageStateFile;

	if (Array.isArray(state.cookies) && state.cookies.length > 0) {
		await targetContext.addCookies(state.cookies as Parameters<BrowserContext["addCookies"]>[0]);
	}

	const targetPage = page ?? (await firstOpenPage(targetContext));

	await restoreLocalStorage(targetPage, state.origins);

	if (config.shopDomain) {
		await targetPage.goto(adminStoreUrl(config.shopDomain), {
			timeout: 45_000,
			waitUntil: "domcontentloaded",
		});
	}

	return { path: config.authStatePath, restored: true };
}

export async function firstOpenPage(context: BrowserContext): Promise<Page> {
	return context.pages().find((page) => !page.isClosed()) ?? context.newPage();
}

async function restoreLocalStorage(
	page: Page,
	origins: StorageStateFile["origins"],
): Promise<void> {
	if (!Array.isArray(origins)) {
		return;
	}

	for (const origin of origins) {
		if (!origin?.origin || !Array.isArray(origin.localStorage)) {
			continue;
		}

		await page
			.goto(origin.origin, { timeout: 15_000, waitUntil: "domcontentloaded" })
			.catch(() => undefined);

		if (!page.url().startsWith(origin.origin)) {
			continue;
		}

		await page
			.evaluate((entries) => {
				for (const entry of entries) {
					window.localStorage.setItem(entry.name, entry.value);
				}
			}, origin.localStorage)
			.catch(() => undefined);
	}
}
