import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startLoopbackServer } from "./fixtures/role-isolation/server.js";
import {
	installPackedPackage,
	packPackageForConsumer,
} from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
type CapturedStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface InstalledPeerModule {
	readonly loadConsumerChromium: (peer: {
		readonly executablePath: string;
		readonly modulePath: string;
	}) => Promise<{
		readonly launch: (options: {
			readonly headless: boolean;
		}) => Promise<unknown>;
	}>;
	readonly resolvePlaywrightPeer: (consumerRoot: string) => Promise<{
		readonly executablePath: string;
		readonly modulePath: string;
	}>;
}

const makeTemporaryDirectory = async (prefix: string): Promise<string> => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	temporaryDirectories.push(directory);
	return directory;
};

const setIdentity = async (page: Page, identity: string): Promise<void> => {
	await page.evaluate(async (value) => {
		localStorage.setItem("identity", value);
		await new Promise<void>((resolveDatabase, rejectDatabase) => {
			const request = indexedDB.open("role-identity", 1);
			request.onupgradeneeded = () =>
				request.result.createObjectStore("identity");
			request.onerror = () => rejectDatabase(request.error);
			request.onsuccess = () => {
				const transaction = request.result.transaction("identity", "readwrite");
				transaction.objectStore("identity").put(value, "current");
				transaction.onerror = () => rejectDatabase(transaction.error);
				transaction.oncomplete = () => {
					request.result.close();
					resolveDatabase();
				};
			};
		});
	}, identity);
};

const readIdentity = async (
	page: Page,
): Promise<Record<string, string | null>> =>
	page.evaluate(async () => {
		const cookie =
			document.cookie
				.split("; ")
				.find((entry) => entry.startsWith("identity="))
				?.slice("identity=".length) ?? null;
		const databases = await indexedDB.databases();
		const indexedDBIdentity = databases.some(
			(database) => database.name === "role-identity",
		)
			? await new Promise<string | null>((resolveDatabase, rejectDatabase) => {
					const request = indexedDB.open("role-identity", 1);
					request.onerror = () => rejectDatabase(request.error);
					request.onsuccess = () => {
						if (!request.result.objectStoreNames.contains("identity")) {
							request.result.close();
							resolveDatabase(null);
							return;
						}
						const transaction = request.result.transaction(
							"identity",
							"readonly",
						);
						const get = transaction.objectStore("identity").get("current");
						get.onerror = () => rejectDatabase(get.error);
						get.onsuccess = () => {
							request.result.close();
							resolveDatabase((get.result as string | undefined) ?? null);
						};
					};
				})
			: null;
		return {
			cookie,
			indexedDB: indexedDBIdentity,
			localStorage: localStorage.getItem("identity"),
		};
	});

interface LoopbackContext {
	readonly assertNoExternalTraffic: () => void;
	readonly context: BrowserContext;
}

const createLoopbackContext = async (
	browser: Browser,
	origin: string,
	storageState: CapturedStorageState,
): Promise<LoopbackContext> => {
	const context = await browser.newContext({ storageState });
	const externalOrigins: string[] = [];
	await context.route("**/*", async (route) => {
		const requestedOrigin = new URL(route.request().url()).origin;
		if (requestedOrigin !== origin) {
			externalOrigins.push(requestedOrigin);
			await route.abort();
			return;
		}
		await route.continue();
	});
	return {
		assertNoExternalTraffic: () => expect(externalOrigins).toEqual([]),
		context,
	};
};

const captureIdentity = async (
	browser: Browser,
	origin: string,
	identity: string,
): Promise<CapturedStorageState> => {
	const isolated = await createLoopbackContext(browser, origin, {
		cookies: [],
		origins: [],
	});
	try {
		const page = await isolated.context.newPage();
		await page.goto(origin);
		await isolated.context.addCookies([
			{
				name: "identity",
				sameSite: "Lax",
				url: origin,
				value: identity,
			},
		]);
		await setIdentity(page, identity);
		return await isolated.context.storageState({ indexedDB: true });
	} finally {
		await isolated.context.close();
		isolated.assertNoExternalTraffic();
	}
};

const expectRestoredIdentity = async (
	browser: Browser,
	origin: string,
	state: CapturedStorageState,
	expected: Record<string, string | null>,
): Promise<void> => {
	const isolated = await createLoopbackContext(browser, origin, state);
	try {
		const page = await isolated.context.newPage();
		await page.goto(origin);
		expect(await readIdentity(page)).toEqual(expected);
	} finally {
		await isolated.context.close();
		isolated.assertNoExternalTraffic();
	}
};

describe.sequential("consumer browser role isolation", () => {
	let browser: Browser;
	let server: Awaited<ReturnType<typeof startLoopbackServer>>;

	beforeAll(async () => {
		const packDirectory = await makeTemporaryDirectory(
			"shopify-e2e-browser-pack-",
		);
		const consumerRoot = await makeTemporaryDirectory(
			"shopify-e2e-browser-consumer-",
		);
		await writeFile(
			join(consumerRoot, "package.json"),
			'{"name":"role-isolation-consumer","private":true,"type":"module"}\n',
		);
		const packed = await packPackageForConsumer(projectRoot, packDirectory);
		await installPackedPackage({
			consumerRoot,
			hasPlaywright: true,
			tarballPath: packed.tarballPath,
		});
		const peerModulePath = join(
			consumerRoot,
			"node_modules",
			"@sematico",
			"shopify-e2e",
			"dist",
			"playwright",
			"peer.js",
		);
		const peerModule = (await import(
			pathToFileURL(peerModulePath).href
		)) as InstalledPeerModule;
		const peer = await peerModule.resolvePlaywrightPeer(consumerRoot);
		expect(peer.modulePath.startsWith(`${consumerRoot}/node_modules/`)).toBe(
			true,
		);
		const chromium = await peerModule.loadConsumerChromium(peer);
		try {
			browser = (await chromium.launch({ headless: true })) as Browser;
		} catch (error) {
			throw new Error(
				"Consumer Chromium is unavailable. Install Chromium for @playwright/test 1.61.1 in a consumer project with `npm exec playwright install chromium`, then retry the browser role gate.",
				{ cause: error },
			);
		}
		server = await startLoopbackServer();
	}, 180_000);

	afterAll(async () => {
		await browser?.close();
		await server?.close();
		await Promise.all(
			temporaryDirectories
				.splice(0)
				.map((directory) => rm(directory, { force: true, recursive: true })),
		);
	});

	it("preserves A-B-A cookie, localStorage, and IndexedDB role identity", async () => {
		const stateA = await captureIdentity(browser, server.origin, "A");
		const stateB = await captureIdentity(browser, server.origin, "B");
		expect(JSON.stringify(stateA)).toContain("indexedDB");
		expect(JSON.stringify(stateB)).toContain('"B"');

		await expectRestoredIdentity(browser, server.origin, stateA, {
			cookie: "A",
			indexedDB: "A",
			localStorage: "A",
		});
		await expectRestoredIdentity(browser, server.origin, stateB, {
			cookie: "B",
			indexedDB: "B",
			localStorage: "B",
		});
		await expectRestoredIdentity(browser, server.origin, stateA, {
			cookie: "A",
			indexedDB: "A",
			localStorage: "A",
		});
	});
});
