import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright-core";
import { waitForCdp } from "./browser.js";
import { isRecord } from "./guards.js";
import {
	ensureParentDirectory,
	type ResolvedShopifyE2EConfig,
} from "./shopify-e2e-config.js";
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
	cookies?: Parameters<BrowserContext["addCookies"]>[0];
	origins?: StorageStateOrigin[];
}

interface StorageStateOrigin {
	localStorage?: StorageStateLocalStorageEntry[];
	origin?: string;
}

interface StorageStateLocalStorageEntry {
	name: string;
	value: string;
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
	return withChromeContext(config, context, async (targetContext) => {
		await ensureParentDirectory(config.authStatePath);
		await targetContext.storageState({ path: config.authStatePath });

		return { path: config.authStatePath };
	});
}

export function authStateExists(config: ResolvedShopifyE2EConfig): boolean {
	return existsSync(config.authStatePath);
}

export async function restoreAuthState(
	config: ResolvedShopifyE2EConfig,
	context?: BrowserContext,
	page?: Page,
): Promise<AuthStateRestoreResult> {
	const contents = await readAuthStateFile(config.authStatePath);

	if (contents === null) {
		return { path: config.authStatePath, restored: false };
	}

	return withChromeContext(config, context, async (targetContext) => {
		const state = parseStorageStateFile({
			contents,
			path: config.authStatePath,
		});

		if (Array.isArray(state.cookies) && state.cookies.length > 0) {
			await targetContext.addCookies(state.cookies);
		}

		const targetPage = page ?? (await firstOpenPage(targetContext));

		await restoreLocalStorage(
			targetPage,
			state.origins,
			config.authStatePath,
		);

		if (config.shopDomain) {
			await targetPage.goto(adminStoreUrl(config.shopDomain), {
				timeout: 45_000,
				waitUntil: "domcontentloaded",
			});
		}

		return { path: config.authStatePath, restored: true };
	});
}

async function withChromeContext<T>(
	config: ResolvedShopifyE2EConfig,
	context: BrowserContext | undefined,
	callback: (context: BrowserContext) => Promise<T>,
): Promise<T> {
	let connection: ConnectedChrome | null = null;
	let targetContext = context;

	if (!targetContext) {
		connection = await connectToChrome(config);
		targetContext = connection.context;
	}

	try {
		return await callback(targetContext);
	} finally {
		if (connection?.browser.isConnected()) {
			await connection.browser.close();
		}
	}
}

async function readAuthStateFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

interface ParseStorageStateFileArgs {
	contents: string;
	path: string;
}

function parseStorageStateFile({
	contents,
	path,
}: ParseStorageStateFileArgs): StorageStateFile {
	try {
		const parsed = JSON.parse(contents) as unknown;

		return validateStorageStateFile({ path, value: parsed });
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("Invalid auth state")
		) {
			throw error;
		}

		throw new Error(
			`Invalid auth state at ${path}: could not parse JSON.`,
			{
				cause: error,
			},
		);
	}
}

interface ValidateStorageStateFileArgs {
	path: string;
	value: unknown;
}

function validateStorageStateFile({
	path,
	value,
}: ValidateStorageStateFileArgs): StorageStateFile {
	if (!isRecord(value)) {
		throw new Error(`Invalid auth state at ${path}: expected an object.`);
	}

	const { cookies, origins } = value;

	if (cookies !== undefined && !isCookieArray(cookies)) {
		throw new Error(
			`Invalid auth state at ${path}: cookies must be an array of cookie objects.`,
		);
	}

	if (origins !== undefined && !isStorageStateOriginArray(origins)) {
		throw new Error(
			`Invalid auth state at ${path}: origins must include origin strings and localStorage name/value pairs.`,
		);
	}

	return {
		cookies,
		origins,
	};
}

function isCookieArray(
	value: unknown,
): value is Parameters<BrowserContext["addCookies"]>[0] {
	return Array.isArray(value) && value.every((cookie) => isRecord(cookie));
}

function isStorageStateOriginArray(
	value: unknown,
): value is StorageStateOrigin[] {
	return (
		Array.isArray(value) &&
		value.every(
			(origin) =>
				isRecord(origin) &&
				(origin.origin === undefined ||
					typeof origin.origin === "string") &&
				(origin.localStorage === undefined ||
					isLocalStorageEntryArray(origin.localStorage)),
		)
	);
}

function isLocalStorageEntryArray(
	value: unknown,
): value is StorageStateLocalStorageEntry[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.name === "string" &&
				typeof entry.value === "string",
		)
	);
}

export async function firstOpenPage(context: BrowserContext): Promise<Page> {
	return (
		context.pages().find((page) => !page.isClosed()) ?? context.newPage()
	);
}

async function restoreLocalStorage(
	page: Page,
	origins: StorageStateFile["origins"],
	path: string,
): Promise<void> {
	if (!Array.isArray(origins)) {
		return;
	}

	for (const origin of origins) {
		if (!origin?.origin || !Array.isArray(origin.localStorage)) {
			continue;
		}

		try {
			await page.goto(origin.origin, {
				timeout: 15_000,
				waitUntil: "domcontentloaded",
			});
		} catch (error) {
			throw new Error(
				`Could not restore localStorage for ${origin.origin} from auth state at ${path}: navigation failed.`,
				{ cause: error },
			);
		}

		if (!page.url().startsWith(origin.origin)) {
			throw new Error(
				`Could not restore localStorage for ${origin.origin} from auth state at ${path}: browser left the origin.`,
			);
		}

		try {
			await page.evaluate((entries) => {
				for (const entry of entries) {
					window.localStorage.setItem(entry.name, entry.value);
				}
			}, origin.localStorage);
		} catch (error) {
			throw new Error(
				`Could not restore localStorage for ${origin.origin} from auth state at ${path}: write failed.`,
				{ cause: error },
			);
		}
	}
}
