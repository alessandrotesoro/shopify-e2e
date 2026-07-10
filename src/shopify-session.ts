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
	close(): Promise<void>;
	context: BrowserContext;
	page: Page;
}

export interface PreparedShopifySession extends LiveShopifyPage {
	authProfile: Readonly<ResolvedShopifyAuthProfile>;
	browser: Browser;
	chromeStarted: boolean;
}

export interface ShopifyRuntimeSession {
	readonly authProfile: Readonly<ResolvedShopifyAuthProfile>;
	readonly config: ResolvedShopifyE2EConfig;
	close(): Promise<void>;
	page(): Promise<Page>;
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

interface ActiveShopifyRuntime {
	browser: Browser;
	context: BrowserContext;
	page: Page;
}

interface ShopifyRuntimeDependencies {
	connectToBrowser(config: ResolvedShopifyE2EConfig): Promise<Browser>;
}

const defaultRuntimeDependencies: ShopifyRuntimeDependencies = {
	connectToBrowser: connectToChrome,
};

let activeRuntimeLease: symbol | undefined;

class OwnedShopifyRuntimeSession implements ShopifyRuntimeSession {
	readonly authProfile: Readonly<ResolvedShopifyAuthProfile>;
	readonly config: ResolvedShopifyE2EConfig;

	private activeRuntime?: ActiveShopifyRuntime;
	private activation?: Promise<ActiveShopifyRuntime>;
	private closePromise?: Promise<void>;
	private closed = false;

	constructor(
		config: ResolvedShopifyE2EConfig,
		private readonly lease: symbol,
		private readonly dependencies: ShopifyRuntimeDependencies,
	) {
		this.config = config;
		this.authProfile = config.authProfile;
	}

	async page(): Promise<Page> {
		return (await this.activate()).page;
	}

	async close(): Promise<void> {
		if (this.closePromise) {
			return this.closePromise;
		}

		if (this.closed) {
			return;
		}

		this.closed = true;
		this.closePromise = this.closeOwnedRuntime();

		return this.closePromise;
	}

	async activate(): Promise<ActiveShopifyRuntime> {
		if (this.closed) {
			throw new Error("This Shopify runtime session is closed.");
		}

		if (this.activeRuntime) {
			return this.activeRuntime;
		}

		this.activation ??= this.initialize();

		return this.activation;
	}

	private async initialize(): Promise<ActiveShopifyRuntime> {
		let browser: Browser | undefined;
		let context: BrowserContext | undefined;

		try {
			assertLoopbackCdpUrl(this.config.cdpUrl);
			await loadAuthProfile(this.authProfile);
			browser = await this.dependencies.connectToBrowser(this.config);
			context = await browser.newContext({
				storageState: this.authProfile.storageStatePath,
				viewport: null,
			});
			const page = await context.newPage();
			page.setDefaultTimeout(30_000);
			page.setDefaultNavigationTimeout(45_000);
			this.activeRuntime = { browser, context, page };

			return this.activeRuntime;
		} catch (error) {
			this.closed = true;
			await cleanupOwnedRuntime({ browser, context }, this.lease, error);
			throw error;
		}
	}

	private async closeOwnedRuntime(): Promise<void> {
		if (this.activation && !this.activeRuntime) {
			await this.activation.catch(() => undefined);
		}

		const runtime = this.activeRuntime;
		this.activeRuntime = undefined;

		await cleanupOwnedRuntime(runtime ?? {}, this.lease);
	}
}

export function createShopifyRuntimeSession(
	config: ResolvedShopifyE2EConfig,
	dependencies: ShopifyRuntimeDependencies = defaultRuntimeDependencies,
): ShopifyRuntimeSession {
	return createOwnedShopifyRuntimeSession(config, dependencies);
}

function createOwnedShopifyRuntimeSession(
	config: ResolvedShopifyE2EConfig,
	dependencies: ShopifyRuntimeDependencies = defaultRuntimeDependencies,
): OwnedShopifyRuntimeSession {
	assertRunnableConfig(config);

	if (activeRuntimeLease) {
		throw new Error(
			"A Shopify runtime session is already active. Close it before creating another client.",
		);
	}

	const immutableConfig = freezeRuntimeConfig(config);
	const lease = Symbol(immutableConfig.authProfile.name);
	activeRuntimeLease = lease;

	return new OwnedShopifyRuntimeSession(immutableConfig, lease, dependencies);
}

export async function prepareShopifySession(
	config: ResolvedShopifyE2EConfig,
	options: PrepareShopifySessionOptions = {},
): Promise<PreparedShopifySession> {
	const session = createOwnedShopifyRuntimeSession(config);
	const runnableConfig = session.config as RunnableShopifyConfig;
	const adminUrl = adminStoreUrl(runnableConfig.shopDomain);

	try {
		const chrome = await ensureChrome(runnableConfig, adminUrl, {
			fetch: options.fetch,
		});
		const { browser, context, page } = await session.activate();

		await page.goto(adminUrl, {
			timeout: 45_000,
			waitUntil: "domcontentloaded",
		});
		await waitForLoggedInShopifyAdmin(page, runnableConfig, options);

		return {
			authProfile: session.authProfile,
			browser,
			chromeStarted: chrome.started,
			close: () => session.close(),
			context,
			page,
		};
	} catch (error) {
		return closeAfterFailure(session, error);
	}
}

export async function validateShopifySession(
	config: ResolvedShopifyE2EConfig,
): Promise<void> {
	assertRunnableConfig(config);
	assertLoopbackCdpUrl(config.cdpUrl);
	await loadAuthProfile(config.authProfile);
	await ensureChrome(config, adminStoreUrl(config.shopDomain));
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
	const session = createOwnedShopifyRuntimeSession(config);

	try {
		const { context, page } = await session.activate();

		return {
			close: () => session.close(),
			context,
			page,
		};
	} catch (error) {
		return closeAfterFailure(session, error);
	}
}

export async function openLiveShopifyPage(
	config: ResolvedShopifyE2EConfig,
	url: string,
): Promise<LiveShopifyPage> {
	const session = await createLiveShopifyPage(config);

	try {
		await gotoLiveShopifyPage(session.page, url);
	} catch (error) {
		return closeAfterFailure(
			session,
			new Error(`Could not open live Shopify page at ${url}.`, {
				cause: error,
			}),
		);
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

export function resetShopifyRuntimeLeaseForTests(): void {
	activeRuntimeLease = undefined;
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

async function cleanupOwnedRuntime(
	runtime: { browser?: Browser; context?: BrowserContext },
	lease: symbol,
	priorError?: unknown,
): Promise<void> {
	const cleanupErrors: unknown[] = [];

	try {
		await runtime.context?.close();
	} catch (error) {
		cleanupErrors.push(error);
	} finally {
		releaseRuntimeLease(lease);
	}

	try {
		if (runtime.browser?.isConnected()) {
			await runtime.browser.close();
		}
	} catch (error) {
		cleanupErrors.push(error);
	}

	if (cleanupErrors.length === 1 && priorError === undefined) {
		throw cleanupErrors[0];
	}

	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			priorError === undefined
				? cleanupErrors
				: [priorError, ...cleanupErrors],
			"Could not cleanly close Shopify runtime.",
		);
	}
}

function releaseRuntimeLease(lease: symbol): void {
	if (activeRuntimeLease === lease) {
		activeRuntimeLease = undefined;
	}
}

function freezeRuntimeConfig(
	config: ResolvedShopifyE2EConfig,
): ResolvedShopifyE2EConfig {
	const authProfile = Object.freeze({ ...config.authProfile });

	return Object.freeze({ ...config, authProfile });
}

async function closeAfterFailure(
	session: Pick<ShopifyRuntimeSession, "close">,
	error: unknown,
): Promise<never> {
	try {
		await session.close();
	} catch (closeError) {
		throw new AggregateError(
			[error, closeError],
			"Shopify runtime failed and could not close cleanly.",
		);
	}

	throw error;
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
