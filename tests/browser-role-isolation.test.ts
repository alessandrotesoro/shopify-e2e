import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
	Browser,
	BrowserContext,
	BrowserServer,
	BrowserType,
	Page,
} from "playwright";
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
		readonly connect: BrowserType["connect"];
		readonly launchServer: BrowserType["launchServer"];
	}>;
	readonly resolvePlaywrightPeer: (consumerRoot: string) => Promise<{
		readonly executablePath: string;
		readonly modulePath: string;
	}>;
}

type InstalledExecutionModules = Pick<
	typeof import("../src/config/execution-environment.js"),
	"buildPlaywrightChildEnvironment"
> &
	Pick<
		typeof import("../src/playwright/execution-context.js"),
		"createPlaywrightExecutionContext"
	> &
	Pick<
		typeof import("../src/playwright/invocation.js"),
		"buildPlaywrightInvocation"
	>;

const makeTemporaryDirectory = async (prefix: string): Promise<string> => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	temporaryDirectories.push(directory);
	return directory;
};

const runInvocation = async (
	invocation: ReturnType<
		InstalledExecutionModules["buildPlaywrightInvocation"]
	>,
	cwd: string,
): Promise<{
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}> =>
	new Promise((resolveRun, rejectRun) => {
		const child = spawn(invocation.executable, invocation.args, {
			cwd,
			env: invocation.environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		let stdout = "";
		child.stderr.setEncoding("utf8");
		child.stdout.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		timer.unref();
		child.once("error", (error) => {
			clearTimeout(timer);
			rejectRun(error);
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			resolveRun({ status, stderr, stdout });
		});
	});

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

describe.sequential("consumer browser role isolation", () => {
	let browserServer: BrowserServer;
	let browserPidMarker: string;
	let configPath: string;
	let consumerRoot: string;
	let chromium: Awaited<
		ReturnType<InstalledPeerModule["loadConsumerChromium"]>
	>;
	let executionModules: InstalledExecutionModules;
	let peer: Awaited<ReturnType<InstalledPeerModule["resolvePlaywrightPeer"]>>;
	let server: Awaited<ReturnType<typeof startLoopbackServer>>;
	let testDir: string;

	beforeAll(async () => {
		const packDirectory = await makeTemporaryDirectory(
			"shopify-e2e-browser-pack-",
		);
		consumerRoot = await makeTemporaryDirectory(
			"shopify-e2e-browser-consumer-",
		);
		await writeFile(
			join(consumerRoot, "package.json"),
			'{"name":"role-isolation-consumer","private":true,"type":"module"}\n',
		);
		const packed = await packPackageForConsumer({ projectRoot, packDirectory });
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
		peer = await peerModule.resolvePlaywrightPeer(consumerRoot);
		expect(peer.modulePath.startsWith(`${consumerRoot}/node_modules/`)).toBe(
			true,
		);
		chromium = await peerModule.loadConsumerChromium(peer);
		const packageRoot = join(
			consumerRoot,
			"node_modules",
			"@sematico",
			"shopify-e2e",
			"dist",
		);
		const [environmentModule, executionContextModule, invocationModule] =
			await Promise.all([
				import(
					pathToFileURL(join(packageRoot, "config", "execution-environment.js"))
						.href
				),
				import(
					pathToFileURL(join(packageRoot, "playwright", "execution-context.js"))
						.href
				),
				import(
					pathToFileURL(join(packageRoot, "playwright", "invocation.js")).href
				),
			]);
		executionModules = {
			buildPlaywrightChildEnvironment:
				environmentModule.buildPlaywrightChildEnvironment,
			buildPlaywrightInvocation: invocationModule.buildPlaywrightInvocation,
			createPlaywrightExecutionContext:
				executionContextModule.createPlaywrightExecutionContext,
		} as InstalledExecutionModules;
		testDir = join(consumerRoot, "shopify-tests");
		configPath = join(consumerRoot, "shopify-e2e.config.ts");
		browserPidMarker = join(consumerRoot, "browser-pids.jsonl");
		await mkdir(testDir);
		await writeFile(
			configPath,
			`import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";
export default defineShopifyE2EConfig({
  reporter: "line",
  roles: ["admin", "customer"],
  testDir: "shopify-tests",
  use: { screenshot: "off", trace: "off", video: "off" }
});
`,
		);
		await writeFile(
			join(testDir, "role-state.spec.ts"),
			`import { appendFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
for (const role of ["admin", "customer"]) {
  test(role + " restores isolated state", { tag: "@shopify-e2e-role-" + role }, async ({ browser, page }) => {
    const origin = process.env.ROLE_TEST_ORIGIN;
    const expected = process.env.EXPECTED_ROLE_IDENTITY;
    if (!origin || !expected) throw new Error("role identity environment is required");
    await page.goto(origin);
    const actual = await page.evaluate(async () => {
      const cookie = document.cookie.split("; ").find((entry) => entry.startsWith("identity="))?.slice("identity=".length) ?? null;
      const request = indexedDB.open("role-identity", 1);
      const indexedDBIdentity = await new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("identity", "readonly");
          const get = transaction.objectStore("identity").get("current");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => { request.result.close(); resolve(get.result ?? null); };
        };
      });
      return { cookie, indexedDB: indexedDBIdentity, localStorage: localStorage.getItem("identity") };
    });
    expect(actual).toEqual({ cookie: expected, indexedDB: expected, localStorage: expected });
    const marker = process.env.BROWSER_PID_MARKER;
    if (!marker) throw new Error("browser PID marker is required");
    const session = await browser.newBrowserCDPSession();
    const processInfo = await session.send("SystemInfo.getProcessInfo");
    await session.detach();
    const browserProcess = processInfo.processInfo.find((entry) => entry.type === "browser");
    if (!browserProcess) throw new Error("browser process is unavailable");
    appendFileSync(marker, JSON.stringify({ browserPid: browserProcess.id, expected }) + "\\n");
  });
}
`,
		);
		try {
			browserServer = await chromium.launchServer({
				handleSIGHUP: true,
				handleSIGINT: false,
				handleSIGTERM: false,
				headless: false,
				host: "127.0.0.1",
				port: 0,
			});
		} catch (error) {
			throw new Error(
				"Consumer Chromium is unavailable. Install Chromium for @playwright/test 1.61.1 in a consumer project with `npm exec playwright install chromium`, then retry the browser role gate.",
				{ cause: error },
			);
		}
		server = await startLoopbackServer();
	}, 180_000);

	afterAll(async () => {
		await browserServer?.close();
		await server?.close();
		await Promise.all(
			temporaryDirectories
				.splice(0)
				.map((directory) => rm(directory, { force: true, recursive: true })),
		);
	});

	it("keeps one headed server alive across isolated A-B-A Playwright CLI children", async () => {
		const serverPid = browserServer.process().pid;
		expect(serverPid).toBeTypeOf("number");
		const endpoint = browserServer.wsEndpoint();
		const captureConnection = await chromium.connect(endpoint);
		const stateA = await captureIdentity(captureConnection, server.origin, "A");
		const stateB = await captureIdentity(captureConnection, server.origin, "B");
		await captureConnection.close();
		expect(JSON.stringify(stateA)).toContain("indexedDB");
		expect(JSON.stringify(stateB)).toContain('"B"');

		for (const [role, state, expected] of [
			["admin", stateA, "A"],
			["customer", stateB, "B"],
			["admin", stateA, "A"],
		] as const) {
			expect(browserServer.process().pid).toBe(serverPid);
			const context = await executionModules.createPlaywrightExecutionContext({
				configPath,
				normalizedOrigin: "https://shop.example",
				projectRoot: consumerRoot,
				role,
				state,
				testDir,
			});
			try {
				const environment = executionModules.buildPlaywrightChildEnvironment({
					parentEnvironment: {
						...process.env,
						BROWSER_PID_MARKER: browserPidMarker,
						EXPECTED_ROLE_IDENTITY: expected,
						NO_COLOR: "1",
						ROLE_TEST_ORIGIN: server.origin,
						SHOPIFY_STORE_URL: "https://shop.example",
					},
					contextPath: context.contextPath,
					wsEndpoint: endpoint,
				});
				const invocation = executionModules.buildPlaywrightInvocation({
					configPath,
					environment,
					peer,
				});
				const result = await runInvocation(invocation, consumerRoot);
				expect(
					result.status,
					`role ${role} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
				).toBe(0);
				expect(result.stdout).not.toContain(endpoint);
				expect(result.stderr).not.toContain(endpoint);
			} finally {
				await context.cleanup();
			}
			const inspection = await chromium.connect(endpoint);
			expect(inspection.contexts()).toEqual([]);
			await inspection.close();
		}
		expect(browserServer.process().pid).toBe(serverPid);
		expect(
			(await readFile(browserPidMarker, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{ browserPid: serverPid, expected: "A" },
			{ browserPid: serverPid, expected: "B" },
			{ browserPid: serverPid, expected: "A" },
		]);
	});
});
