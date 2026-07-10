import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { type Browser, chromium } from "playwright-core";

import type { ResolvedShopifyE2EConfig } from "../../src/shopify-e2e-config.js";
import { createShopifyRuntimeSession } from "../../src/shopify-session.js";

const markerKey = "profile-marker";

test("restores conflicting profiles without cross-profile browser storage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "shopify-e2e-isolation-"));
	const server = await startMarkerServer();
	const origin = serverOrigin(server);

	try {
		await createProfile(
			join(directory, "customer-a.json"),
			origin,
			"customer-a",
		);
		await createProfile(
			join(directory, "customer-b.json"),
			origin,
			"customer-b",
		);

		await expectProfile(directory, origin, "customer-a");
		await expectProfile(directory, origin, "customer-b");
		await expectProfile(directory, origin, "customer-a");
	} finally {
		await closeServer(server);
		await rm(directory, { force: true, recursive: true });
	}
});

async function createProfile(
	storageStatePath: string,
	origin: string,
	marker: string,
): Promise<void> {
	const browser = await launchBundledChromium();

	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(origin);
		await context.addCookies([
			{
				domain: "127.0.0.1",
				name: markerKey,
				path: "/",
				value: marker,
			},
		]);
		await page.evaluate(
			async ({ key, value }) => {
				localStorage.setItem(key, value);
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.open("auth-profile-isolation", 1);
					request.onupgradeneeded = () => {
						request.result.createObjectStore("markers");
					};
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const transaction = database.transaction(
							"markers",
							"readwrite",
						);
						transaction.objectStore("markers").put(value, key);
						transaction.oncomplete = () => {
							database.close();
							resolve();
						};
						transaction.onerror = () => reject(transaction.error);
					};
				});
			},
			{ key: markerKey, value: marker },
		);
		await context.storageState({ indexedDB: true, path: storageStatePath });
		await context.close();
	} finally {
		await browser.close();
	}
}

async function expectProfile(
	directory: string,
	origin: string,
	profileName: string,
): Promise<void> {
	const session = createShopifyRuntimeSession(
		config(directory, profileName),
		{ connectToBrowser: launchBundledChromium },
	);

	try {
		const page = await session.page();
		await page.goto(origin);

		await expect
			.poll(() => readMarkers(page))
			.toEqual({
				cookie: profileName,
				indexedDB: profileName,
				localStorage: profileName,
			});
	} finally {
		await session.close();
	}
}

async function readMarkers(page: import("playwright-core").Page): Promise<{
	cookie: string | null;
	indexedDB: string | null;
	localStorage: string | null;
}> {
	return page.evaluate(async (key) => {
		const cookie = document.cookie
			.split("; ")
			.find((entry) => entry.startsWith(`${key}=`))
			?.split("=")[1];
		const indexedDBValue = await new Promise<string | null>(
			(resolve, reject) => {
				const request = indexedDB.open("auth-profile-isolation", 1);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction(
						"markers",
						"readonly",
					);
					const getRequest = transaction
						.objectStore("markers")
						.get(key);
					getRequest.onerror = () => reject(getRequest.error);
					getRequest.onsuccess = () => {
						database.close();
						resolve(
							typeof getRequest.result === "string"
								? getRequest.result
								: null,
						);
					};
				};
			},
		);

		return {
			cookie: cookie ?? null,
			indexedDB: indexedDBValue,
			localStorage: localStorage.getItem(key),
		};
	}, markerKey);
}

function config(
	directory: string,
	profileName: string,
): ResolvedShopifyE2EConfig {
	return {
		authProfile: {
			name: profileName,
			storageStatePath: join(directory, `${profileName}.json`),
		},
		cdpPort: "1",
		cdpUrl: "http://127.0.0.1:1",
		chromeProfilePath: join(directory, "chrome-profile"),
		cwd: directory,
		live: true,
		shopDomain: "isolation-test.myshopify.com",
		testCommand: { args: ["playwright", "test"], command: "npx" },
		testFiles: [],
	};
}

async function launchBundledChromium(): Promise<Browser> {
	try {
		return await chromium.launch({ headless: true });
	} catch (error) {
		throw new Error(
			"Bundled Chromium is required for the auth-profile isolation test. Run `npx playwright install chromium`.",
			{ cause: error },
		);
	}
}

async function startMarkerServer(): Promise<Server> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<!doctype html><title>Profile isolation</title>");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	return server;
}

function serverOrigin(server: Server): string {
	const address = server.address();

	if (!address || typeof address === "string") {
		throw new Error(
			"Could not resolve the browser-isolation server address.",
		);
	}

	return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
