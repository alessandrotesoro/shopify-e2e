import {
	access,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { SHOPIFY_E2E_EXECUTION_CONTEXT_ENV } from "../src/config/execution-environment.cjs";
import { loadShopifyConfig } from "../src/config/load-config.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

const temporaryDirectories: string[] = [];
const helperUrl = pathToFileURL(
	resolve(import.meta.dirname, "../dist/config/public.cjs"),
).href;

const makeProject = async (): Promise<string> => {
	const project = await mkdtemp(join(tmpdir(), "shopify-e2e-config-"));
	temporaryDirectories.push(project);
	await mkdir(join(project, "shopify-tests"), { recursive: true });
	await writeFile(
		join(project, "shopify-tests", "lane.spec.ts"),
		"// candidate\n",
	);
	return realpath(project);
};

const markedConfigSource = (
	fields = 'testDir: "shopify-tests", roles: ["admin", "customer"]',
): string =>
	`import { defineShopifyE2EConfig } from ${JSON.stringify(helperUrl)};\nexport default defineShopifyE2EConfig({ ${fields} });\n`;

const writeConfig = async (
	project: string,
	source: string,
	name = "shopify-e2e.config.ts",
): Promise<string> => {
	const configPath = join(project, name);
	await mkdir(resolve(configPath, ".."), { recursive: true });
	await writeFile(configPath, source);
	return configPath;
};

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("dedicated Shopify configuration", () => {
	it("loads only the marked fixed root and returns its derived boundary", async () => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				'testDir: "shopify-tests", roles: ["admin", "customer"], fullyParallel: true, retries: 2, testMatch: /checkout\\.spec\\.ts$/, use: { screenshot: "only-on-failure", trace: "retain-on-failure" }',
			),
		);

		const loaded = await loadShopifyConfig({
			environment: {},
			projectRoot: project,
		});

		expect(loaded).toEqual({
			browserLaunchOptions: {
				handleSIGHUP: true,
				handleSIGINT: false,
				handleSIGTERM: false,
				headless: false,
				host: "127.0.0.1",
				port: 0,
			},
			configPath: join(project, "shopify-e2e.config.ts"),
			projectRoot: project,
			roles: ["admin", "customer"],
			testDir: join(project, "shopify-tests"),
		});
	});

	it("creates an immutable allowlisted headed Chromium launch projection", async () => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				'testDir: "shopify-tests", roles: ["admin"], use: { channel: "chrome", launchOptions: { args: ["--start-maximized"], artifactsDir: "artifacts", channel: "msedge", chromiumSandbox: true, downloadsPath: "downloads", env: { SAFE_FLAG: "1" }, executablePath: "/consumer/chromium", headless: true, handleSIGHUP: false, handleSIGINT: true, handleSIGTERM: true, ignoreDefaultArgs: ["--disable-popup-blocking"], proxy: { server: "http://proxy.example", bypass: "localhost", username: "user", password: "secret" }, timeout: 1234 } }',
			),
		);

		const loaded = await loadShopifyConfig({
			environment: {},
			projectRoot: project,
		});

		expect(loaded.browserLaunchOptions).toEqual({
			args: ["--start-maximized"],
			artifactsDir: "artifacts",
			channel: "chrome",
			chromiumSandbox: true,
			downloadsPath: "downloads",
			env: { SAFE_FLAG: "1" },
			executablePath: "/consumer/chromium",
			handleSIGHUP: true,
			handleSIGINT: false,
			handleSIGTERM: false,
			headless: false,
			host: "127.0.0.1",
			ignoreDefaultArgs: ["--disable-popup-blocking"],
			port: 0,
			proxy: {
				bypass: "localhost",
				password: "secret",
				server: "http://proxy.example",
				username: "user",
			},
			timeout: 1234,
		});
		expect(Object.isFrozen(loaded.browserLaunchOptions)).toBe(true);
		expect(Object.isFrozen(loaded.browserLaunchOptions.args)).toBe(true);
		expect(Object.isFrozen(loaded.browserLaunchOptions.env)).toBe(true);
		expect(Object.isFrozen(loaded.browserLaunchOptions.ignoreDefaultArgs)).toBe(
			true,
		);
		expect(Object.isFrozen(loaded.browserLaunchOptions.proxy)).toBe(true);
	});

	it.each([
		["deprecated logger", "logger: {}", /launchOptions\.logger/i],
		[
			"Firefox preferences",
			"firefoxUserPrefs: { foo: true }",
			/launchOptions\.firefoxUserPrefs/i,
		],
		[
			"launch-server trace directory",
			'tracesDir: "traces"',
			/launchOptions\.tracesDir/i,
		],
		["unknown option", "custom: true", /launchOptions\.custom/i],
	])("rejects the unsupported %s", async (_label, launchField, message) => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				`testDir: "shopify-tests", roles: ["admin"], use: { launchOptions: { ${launchField} } }`,
			),
		);

		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: project }),
		).rejects.toThrow(message);
	});

	it.each([
		"--remote-debugging-port=0",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-pipe",
	])("rejects Chromium CDP argument %s", async (argument) => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				`testDir: "shopify-tests", roles: ["admin"], use: { launchOptions: { args: [${JSON.stringify(argument)}] } }`,
			),
		);

		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: project }),
		).rejects.toThrow(/remote-debugging/i);
	});

	it.each([
		"--headless",
		"--headless=new",
		" --HEADLESS=old",
	])("rejects Chromium headless argument %s", async (argument) => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				`testDir: "shopify-tests", roles: ["admin"], use: { launchOptions: { args: [${JSON.stringify(argument)}] } }`,
			),
		);

		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: project }),
		).rejects.toThrow(/headless Chromium/i);
	});

	it.each([
		["all defaults", "true"],
		["the native transport", '["--remote-debugging-pipe"]'],
	])("rejects ignoreDefaultArgs removing %s", async (_label, value) => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				`testDir: "shopify-tests", roles: ["admin"], use: { launchOptions: { ignoreDefaultArgs: ${value} } }`,
			),
		);

		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: project }),
		).rejects.toThrow(/ignoreDefaultArgs.*native transport/i);
	});

	it.each([
		"pw:server",
		"pw:*",
		"*",
	])("rejects endpoint-revealing DEBUG=%s before config evaluation", async (debug) => {
		const project = await makeProject();
		const marker = join(project, "config-loaded");
		await writeConfig(
			project,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); ${markedConfigSource()}`,
		);

		const error = await loadShopifyConfig({
			environment: { DEBUG: debug },
			projectRoot: project,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect((error as Error).message).toMatch(/DEBUG.*browser endpoint/i);
		expect((error as Error).message).not.toContain(debug);
		await expect(access(marker)).rejects.toThrow();
	});

	it("rejects endpoint logging enabled by trusted config evaluation", async () => {
		const project = await makeProject();
		await writeConfig(
			project,
			`process.env.DEBUG = "pw:server"; ${markedConfigSource()}`,
		);
		const previousDebug = process.env.DEBUG;
		delete process.env.DEBUG;

		try {
			const error = await loadShopifyConfig({
				environment: process.env,
				projectRoot: project,
			}).catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
			expect((error as Error).message).toMatch(/DEBUG.*browser endpoint/i);
			expect((error as Error).message).not.toContain("pw:server");
		} finally {
			if (previousDebug === undefined) delete process.env.DEBUG;
			else process.env.DEBUG = previousDebug;
		}
	});

	it("ignores alternate and ordinary Playwright configs", async () => {
		const project = await makeProject();
		const ordinaryMarker = join(project, "ordinary-loaded");
		const alternateMarker = join(project, "alternate-loaded");
		await writeConfig(project, markedConfigSource());
		await writeFile(
			join(project, "playwright.config.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ordinaryMarker)}, "loaded"); export default {};\n`,
		);
		await writeConfig(
			project,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(alternateMarker)}, "loaded"); export default {};\n`,
			"configs/alternate.ts",
		);

		const loaded = await loadShopifyConfig({
			environment: {},
			projectRoot: project,
		});

		expect(loaded.configPath).toBe(join(project, "shopify-e2e.config.ts"));
		await expect(access(ordinaryMarker)).rejects.toThrow();
		await expect(access(alternateMarker)).rejects.toThrow();
	});

	it.each([
		["raw", 'export default { testDir: "shopify-tests", roles: ["admin"] };\n'],
		[
			"spread-cloned",
			`import { defineShopifyE2EConfig } from ${JSON.stringify(helperUrl)}; const marked = defineShopifyE2EConfig({ testDir: "shopify-tests", roles: ["admin"] }); export default { ...marked };\n`,
		],
	])("rejects a %s export with direct helper guidance", async (_label, source) => {
		const project = await makeProject();
		await writeConfig(project, source);

		const promise = loadShopifyConfig({
			environment: {},
			projectRoot: project,
		});

		await expect(promise).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		await expect(promise).rejects.toThrow(/defineShopifyE2EConfig/i);
		await expect(promise).rejects.toThrow(/@sematico\/shopify-e2e\/config/i);
	});

	it.each([
		["projects", "projects: []"],
		["workers", "workers: 2"],
		["grep", "grep: /checkout/"],
		["grepInvert", "grepInvert: /draft/"],
		["use.storageState", 'use: { storageState: "state.json" }'],
	])("reports the protected %s conflict", async (setting, field) => {
		const project = await makeProject();
		await writeConfig(
			project,
			markedConfigSource(
				`testDir: "shopify-tests", roles: ["admin"], ${field}`,
			),
		);

		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: project }),
		).rejects.toThrow(new RegExp(setting.replace(".", "\\."), "i"));
	});

	it("rejects a reserved key before trusted config evaluation without its value", async () => {
		const project = await makeProject();
		const marker = join(project, "config-loaded");
		const secretValue = join(project, "secret-context.json");
		await writeConfig(
			project,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); ${markedConfigSource()}`,
		);

		const error = await loadShopifyConfig({
			environment: { [SHOPIFY_E2E_EXECUTION_CONTEXT_ENV]: secretValue },
			projectRoot: project,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect((error as Error).message).toMatch(/reserved/i);
		expect((error as Error).message).not.toContain(secretValue);
		await expect(access(marker)).rejects.toThrow();
	});

	it("loads roles without inspecting specs", async () => {
		const project = await makeProject();
		await rm(join(project, "shopify-tests", "lane.spec.ts"));
		await writeConfig(project, markedConfigSource());

		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: project }),
		).resolves.toMatchObject({ roles: ["admin", "customer"] });
	});

	it("does not leave transformed config in Jiti filesystem cache", async () => {
		const project = await makeProject();
		const temporaryRoot = join(project, "temporary-root");
		await mkdir(temporaryRoot);
		await writeConfig(project, markedConfigSource());
		vi.stubEnv("TEMP", temporaryRoot);
		vi.stubEnv("TMP", temporaryRoot);
		vi.stubEnv("TMPDIR", temporaryRoot);

		await loadShopifyConfig({ environment: {}, projectRoot: project });

		await expect(access(join(temporaryRoot, "jiti"))).rejects.toThrow();
	});

	it("sanitizes trusted evaluation failures", async () => {
		const project = await makeProject();
		const configPath = await writeConfig(
			project,
			'throw new Error("consumer secret"); export default {};\n',
		);

		const promise = loadShopifyConfig({
			environment: {},
			projectRoot: project,
		});

		await expect(promise).rejects.toThrow(/could not load/i);
		await expect(promise).rejects.toThrow(configPath);
		await expect(promise).rejects.not.toThrow(/consumer secret/i);
	});

	it("rejects missing and symlinked fixed-root configs", async () => {
		const missingProject = await makeProject();
		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: missingProject }),
		).rejects.toThrow(/does not exist/i);

		const symlinkProject = await makeProject();
		const target = await writeConfig(
			symlinkProject,
			markedConfigSource(),
			"target.ts",
		);
		await symlink(target, join(symlinkProject, "shopify-e2e.config.ts"));
		await expect(
			loadShopifyConfig({ environment: {}, projectRoot: symlinkProject }),
		).rejects.toThrow(/symbolic link/i);
	});
});
