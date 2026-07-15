import {
	access,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { defineShopifyE2EConfig } from "../src/config/define-config.cjs";
import type { LoadedShopifyConfig } from "../src/config/load-config.js";
import {
	DOCTOR_CHECK_ORDER,
	type DoctorDependencies,
	orchestrateDoctor,
} from "../src/doctor/doctor-orchestrator.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";
import type { CommandSignalError } from "../src/process/command-signals.js";
import { configuredOriginFromEnvironment } from "../src/profiles/configured-origin.js";

const projectRoot = "/physical/consumer";
const temporaryDirectories: string[] = [];
const loadedConfig: LoadedShopifyConfig = {
	configPath: `${projectRoot}/shopify-e2e.config.ts`,
	legacyRoles: { guest: { authentication: "required" } },
	playwrightConfig: defineShopifyE2EConfig({
		roles: ["guest"],
		testDir: "shopify-tests",
	}),
	projectRoot,
	roles: ["guest"],
	testDir: `${projectRoot}/shopify-tests`,
};

const makeDependencies = (): DoctorDependencies => ({
	configuredOriginFromEnvironment: vi.fn(configuredOriginFromEnvironment),
	discoverSpecs: vi.fn(async () => [
		`${projectRoot}/shopify-tests/checkout.spec.ts`,
	]),
	loadChromium: vi.fn(async () => ({
		executablePath: () => "/browser/chromium",
		launch: vi.fn(),
	})),
	loadConfig: vi.fn(async () => loadedConfig),
	loadProjectEnvironment: vi.fn(async () => undefined),
	resolvePeer: vi.fn(async () => ({
		executablePath: `${projectRoot}/node_modules/@playwright/test/cli.js`,
		modulePath: `${projectRoot}/node_modules/@playwright/test/index.js`,
	})),
	resolveProjectRoot: vi.fn(async () => projectRoot),
});

const makeReadyConsumer = async (): Promise<{
	readonly chromiumPath: string;
	readonly configPath: string;
	readonly launchSentinel: string;
	readonly project: string;
	readonly testDir: string;
}> => {
	const project = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-doctor-")),
	);
	temporaryDirectories.push(project);
	const configPath = join(project, "shopify-e2e.config.ts");
	const testDir = join(project, "shopify-tests");
	const packageRoot = join(project, "node_modules", "@playwright", "test");
	const chromiumPath = join(packageRoot, "chromium");
	const launchSentinel = join(project, "browser-launched");
	await mkdir(testDir, { recursive: true });
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(project, "package.json"), '{"type":"module"}\n');
	await writeFile(
		configPath,
		"export default { testDir: 'shopify-tests', roles: { guest: { authentication: 'none' } } };\n",
	);
	await writeFile(join(testDir, "checkout.spec.ts"), "// candidate only\n");
	await writeFile(chromiumPath, "fake chromium binary\n");
	await writeFile(join(packageRoot, "cli.js"), "// fake Playwright CLI\n");
	await writeFile(
		join(packageRoot, "index.js"),
		`import { writeFile } from "node:fs/promises";\nexport const chromium = { executablePath() { return ${JSON.stringify(chromiumPath)}; }, async launch() { await writeFile(${JSON.stringify(launchSentinel)}, "launched"); throw new Error("doctor must not launch Chromium"); } };\n`,
	);
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({
			bin: { playwright: "cli.js" },
			exports: {
				".": "./index.js",
				"./package.json": "./package.json",
			},
			name: "@playwright/test",
			type: "module",
			version: "1.61.1",
		}),
	);
	return { chromiumPath, configPath, launchSentinel, project, testDir };
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

const runDoctor = (
	dependencies = makeDependencies(),
	environment: NodeJS.ProcessEnv = {
		SHOPIFY_STORE_URL: "https://shop.example/products?preview=1",
	},
) =>
	orchestrateDoctor({
		dependencies,
		options: {
			cwd: "/logical/consumer",
			environment,
			signal: new AbortController().signal,
		},
	});

describe("doctor orchestration", () => {
	it("returns seven ordered passes for a ready dependency graph", async () => {
		const dependencies = makeDependencies();
		const launch = vi.fn(async () => {
			throw new Error("doctor must not launch Chromium");
		});
		vi.mocked(dependencies.loadChromium).mockResolvedValueOnce({
			executablePath: () => "/browser/chromium",
			launch,
		});

		const report = await runDoctor(dependencies);

		expect(report.checks.map(({ id }) => id)).toEqual(DOCTOR_CHECK_ORDER);
		expect(report.checks.map(({ status }) => status)).toEqual([
			"PASS",
			"PASS",
			"PASS",
			"PASS",
			"PASS",
			"PASS",
			"PASS",
		]);
		expect(report.exitCode).toBe(0);
		expect(dependencies.resolveProjectRoot).toHaveBeenCalledOnce();
		expect(dependencies.loadProjectEnvironment).toHaveBeenCalledWith({
			environment: expect.any(Object),
			projectRoot,
		});
		expect(dependencies.loadConfig).toHaveBeenCalledWith({ projectRoot });
		expect(dependencies.discoverSpecs).toHaveBeenCalledWith(
			loadedConfig.testDir,
		);
		expect(dependencies.resolvePeer).toHaveBeenCalledWith(projectRoot);
		expect(dependencies.loadChromium).toHaveBeenCalledOnce();
		expect(launch).not.toHaveBeenCalled();
		expect(
			vi.mocked(dependencies.loadProjectEnvironment).mock
				.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(dependencies.loadConfig).mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("fails project resolution and skips every downstream check", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.resolveProjectRoot).mockRejectedValueOnce(
			new ShopifyE2EPreflightError(
				"Consuming project directory does not exist: /logical/consumer",
			),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks.map(({ id }) => id)).toEqual(DOCTOR_CHECK_ORDER);
		expect(report.checks.map(({ status }) => status)).toEqual([
			"FAIL",
			"SKIP",
			"SKIP",
			"SKIP",
			"SKIP",
			"SKIP",
			"SKIP",
		]);
		expect(report.exitCode).toBe(2);
		expect(dependencies.loadProjectEnvironment).not.toHaveBeenCalled();
		expect(dependencies.configuredOriginFromEnvironment).not.toHaveBeenCalled();
		expect(dependencies.loadConfig).not.toHaveBeenCalled();
		expect(dependencies.discoverSpecs).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
	});

	it("uses production boundaries for a browserless ready consumer", async () => {
		const consumer = await makeReadyConsumer();
		const environment = {
			SHOPIFY_STORE_URL: "https://shop.example/products?preview=1",
		};

		const report = await orchestrateDoctor({
			options: {
				cwd: consumer.project,
				environment,
				signal: new AbortController().signal,
			},
		});

		expect(report.checks.map(({ status }) => status)).toEqual(
			Array.from({ length: 7 }, () => "PASS"),
		);
		expect(report.checks[3]?.detail).toContain(consumer.configPath);
		expect(report.checks[4]?.detail).toContain(consumer.testDir);
		expect(report.checks[4]?.detail).toContain(
			"1 Playwright spec candidate(s) found",
		);
		expect(report.checks[4]?.detail).not.toContain("checkout.spec.ts");
		expect(JSON.stringify(report)).not.toContain(consumer.chromiumPath);
		expect(JSON.stringify(report)).not.toContain(environment.SHOPIFY_STORE_URL);
		await expect(access(consumer.launchSentinel)).rejects.toThrow();
	});

	it("fails config and skips specs while completing the peer branch", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.loadConfig).mockRejectedValueOnce(
			new ShopifyE2EPreflightError("Dedicated Shopify config is missing"),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks.slice(3).map(({ status }) => status)).toEqual([
			"FAIL",
			"SKIP",
			"PASS",
			"PASS",
		]);
		expect(dependencies.discoverSpecs).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).toHaveBeenCalledOnce();
		expect(dependencies.loadChromium).toHaveBeenCalledOnce();
	});

	it("fails a removed or changed origin but accepts path and query rewrites", async () => {
		const removed = makeDependencies();
		const removedEnvironment: NodeJS.ProcessEnv = {
			SHOPIFY_STORE_URL: "https://shop.example/initial",
		};
		vi.mocked(removed.loadConfig).mockImplementationOnce(async () => {
			delete removedEnvironment.SHOPIFY_STORE_URL;
			return loadedConfig;
		});

		const removedReport = await runDoctor(removed, removedEnvironment);

		expect(removedReport.checks[2]).toMatchObject({ status: "FAIL" });
		expect(removedReport.checks[3]).toMatchObject({ status: "PASS" });

		const changed = makeDependencies();
		const changedEnvironment: NodeJS.ProcessEnv = {
			SHOPIFY_STORE_URL: "https://shop.example/initial",
		};
		vi.mocked(changed.loadConfig).mockImplementationOnce(async () => {
			changedEnvironment.SHOPIFY_STORE_URL = "https://other.example/changed";
			return loadedConfig;
		});

		const changedReport = await runDoctor(changed, changedEnvironment);

		expect(changedReport.checks[2]).toMatchObject({ status: "FAIL" });
		expect(JSON.stringify(changedReport)).not.toContain("other.example");

		const stable = makeDependencies();
		const stableEnvironment: NodeJS.ProcessEnv = {
			SHOPIFY_STORE_URL: "https://shop.example/initial",
		};
		vi.mocked(stable.loadConfig).mockImplementationOnce(async () => {
			stableEnvironment.SHOPIFY_STORE_URL =
				"https://SHOP.example:443/rewritten?preview=1";
			return loadedConfig;
		});

		const stableReport = await runDoctor(stable, stableEnvironment);

		expect(stableReport.checks[2]).toMatchObject({ status: "PASS" });
	});

	it("fails a missing store URL while completing independent checks", async () => {
		const dependencies = makeDependencies();

		const report = await runDoctor(dependencies, {});

		expect(report.checks.map(({ id }) => id)).toEqual(DOCTOR_CHECK_ORDER);
		expect(report.checks.map(({ status }) => status)).toEqual([
			"PASS",
			"PASS",
			"FAIL",
			"PASS",
			"PASS",
			"PASS",
			"PASS",
		]);
		expect(report.checks[2]?.detail).toBe(
			"SHOPIFY_STORE_URL must be an absolute HTTPS URL without credentials",
		);
		expect(JSON.stringify(report)).not.toContain(
			"SHOPIFY_STORE_URL is required. Set it",
		);
		expect(report.exitCode).toBe(2);
		expect(dependencies.loadConfig).toHaveBeenCalledOnce();
		expect(dependencies.discoverSpecs).toHaveBeenCalledOnce();
		expect(dependencies.resolvePeer).toHaveBeenCalledOnce();
		expect(dependencies.loadChromium).toHaveBeenCalledOnce();
	});

	it("fails spec discovery without suppressing the peer branch", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.discoverSpecs).mockRejectedValueOnce(
			new ShopifyE2EPreflightError(
				`Shopify test directory contains no runnable Playwright specs: ${loadedConfig.testDir}`,
			),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks[3]).toMatchObject({ status: "PASS" });
		expect(report.checks[4]).toMatchObject({ status: "FAIL" });
		expect(report.checks[5]).toMatchObject({ status: "PASS" });
		expect(report.checks[6]).toMatchObject({ status: "PASS" });
		expect(dependencies.resolvePeer).toHaveBeenCalledOnce();
		expect(dependencies.loadChromium).toHaveBeenCalledOnce();
	});

	it("skips Chromium when the consumer peer is unavailable", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.resolvePeer).mockRejectedValueOnce(
			new ShopifyE2EPreflightError(
				"Consumer project must install compatible @playwright/test (>=1.61.1 <1.62.0)",
			),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks[5]).toMatchObject({ status: "FAIL" });
		expect(report.checks[6]).toMatchObject({ status: "SKIP" });
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
	});

	it("reports Chromium installation failure without calling launch", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.loadChromium).mockRejectedValueOnce(
			new ShopifyE2EPreflightError(
				"Consumer Chromium is unavailable. Install it from the consumer with `npx playwright install chromium` and retry.",
			),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks[5]).toMatchObject({ status: "PASS" });
		expect(report.checks[6]).toMatchObject({
			status: "FAIL",
		});
		expect(report.checks[6]?.detail).toMatch(/playwright install chromium/i);
	});

	it("skips environment descendants but still runs the independent peer branch", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.loadProjectEnvironment).mockRejectedValueOnce(
			new ShopifyE2EPreflightError("Consumer .env could not be read"),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks.map(({ status }) => status)).toEqual([
			"PASS",
			"FAIL",
			"SKIP",
			"SKIP",
			"SKIP",
			"PASS",
			"PASS",
		]);
		expect(report.exitCode).toBe(2);
		expect(dependencies.loadConfig).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).toHaveBeenCalledOnce();
		expect(report.checks[2]?.detail).toMatch(/environment/i);
	});

	it("sanitizes invalid URL failures without echoing the configured value", async () => {
		const secretUrl = "http://secret-user:secret-pass@shop.example";
		const dependencies = makeDependencies();
		vi.mocked(dependencies.configuredOriginFromEnvironment).mockImplementation(
			() => {
				throw new ShopifyE2EPreflightError("SHOPIFY_STORE_URL must use HTTPS");
			},
		);

		const report = await runDoctor(dependencies, {
			SHOPIFY_STORE_URL: secretUrl,
		});

		expect(report.checks[2]).toMatchObject({ status: "FAIL" });
		expect(JSON.stringify(report)).not.toContain(secretUrl);
		expect(JSON.stringify(report)).not.toContain("secret-pass");
		expect(report.exitCode).toBe(2);
	});

	it("makes a sanitized unexpected error take precedence over known failures", async () => {
		const dependencies = makeDependencies();
		vi.mocked(dependencies.loadProjectEnvironment).mockRejectedValueOnce(
			new ShopifyE2EPreflightError("Consumer .env could not be read"),
		);
		vi.mocked(dependencies.resolvePeer).mockRejectedValueOnce(
			new Error("internal module path /secret/value"),
		);

		const report = await runDoctor(dependencies);

		expect(report.checks[5]).toMatchObject({ status: "ERROR" });
		expect(report.checks[6]).toMatchObject({ status: "SKIP" });
		expect(JSON.stringify(report)).not.toContain("/secret/value");
		expect(report.exitCode).toBe(1);
	});

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)("preserves %s interruption semantics", async (reason, exitCode) => {
		const controller = new AbortController();
		controller.abort(reason);

		await expect(
			orchestrateDoctor({
				dependencies: makeDependencies(),
				options: {
					cwd: projectRoot,
					environment: {},
					signal: controller.signal,
				},
			}),
		).rejects.toMatchObject({ exitCode } satisfies Partial<CommandSignalError>);
	});
});
