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
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	orchestrateShopifyRun,
	type RunCommandDependencies,
} from "../src/commands/run.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../src/errors.js";
import type { GeneratedPlaywrightConfig } from "../src/playwright/generated-config.js";

const temporaryDirectories: string[] = [];

const makeConsumer = async (): Promise<{
	readonly configPath: string;
	readonly projectRoot: string;
	readonly testDir: string;
}> => {
	const projectRoot = await mkdtemp(join(tmpdir(), "shopify-e2e-run-"));
	temporaryDirectories.push(projectRoot);
	const testDir = join(projectRoot, "shopify-tests");
	const configPath = join(projectRoot, "shopify-e2e.config.ts");
	await mkdir(testDir);
	await writeFile(configPath, 'export default { testDir: "shopify-tests" };\n');
	await writeFile(join(testDir, "checkout.spec.ts"), "// candidate\n");
	await mkdir(join(projectRoot, "node_modules", "@playwright"), {
		recursive: true,
	});
	await symlink(
		join(process.cwd(), "node_modules", "@playwright", "test"),
		join(projectRoot, "node_modules", "@playwright", "test"),
		"dir",
	);
	const physicalRoot = await realpath(projectRoot);
	return {
		configPath: join(physicalRoot, "shopify-e2e.config.ts"),
		projectRoot: physicalRoot,
		testDir: join(physicalRoot, "shopify-tests"),
	};
};

interface MakeDependenciesArgs {
	readonly exitCode?: number;
	readonly generatedConfig: GeneratedPlaywrightConfig;
}

const makeDependencies = ({
	exitCode = 0,
	generatedConfig,
}: MakeDependenciesArgs): RunCommandDependencies => {
	return {
		buildInvocation: vi.fn(({ controls, generatedConfig: generated }) => ({
			args: [
				"/consumer/playwright/cli.js",
				"test",
				"--config",
				generated.configPath,
				...(controls?.grep ? ["--grep", controls.grep] : []),
				...(controls?.grepInvert ? ["--grep-invert", controls.grepInvert] : []),
			],
			executable: process.execPath,
		})),
		createGeneratedConfig: vi.fn(async () => generatedConfig),
		loadEnvironment: vi.fn(async ({ cwd }) => realpath(cwd)),
		reportSelection: vi.fn(),
		resolvePeer: vi.fn(async () => ({
			executablePath: "/consumer/playwright/cli.js",
		})),
		runChild: vi.fn(async () => exitCode),
	};
};

const makeGeneratedConfig = async (
	projectRoot: string,
): Promise<
	GeneratedPlaywrightConfig & { cleanup: ReturnType<typeof vi.fn> }
> => {
	const directoryPath = join(projectRoot, "temporary-config");
	const configPath = join(directoryPath, "playwright.config.mjs");
	await mkdir(directoryPath);
	await writeFile(configPath, "export default {};\n");
	const cleanup = vi.fn(async () =>
		rm(directoryPath, { force: true, recursive: true }),
	);
	return { cleanup, configPath };
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("run command orchestration", () => {
	it("loads the invocation environment before evaluating trusted config", async () => {
		const consumer = await makeConsumer();
		const sentinel = "SHOPIFY_E2E_DOTENV_ORDER_SENTINEL";
		await writeFile(
			consumer.configPath,
			`export default { testDir: process.env.${sentinel} === "loaded-before-config" ? "shopify-tests" : "missing-tests" };\n`,
		);
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.mocked(dependencies.loadEnvironment).mockImplementationOnce(
			async ({ cwd, environment }) => {
				environment[sentinel] = "loaded-before-config";
				return realpath(cwd);
			},
		);

		try {
			await expect(
				orchestrateShopifyRun({
					dependencies,
					options: { cwd: consumer.projectRoot },
				}),
			).resolves.toBe(0);

			expect(dependencies.loadEnvironment).toHaveBeenCalledWith({
				cwd: consumer.projectRoot,
				environment: process.env,
			});
			expect(dependencies.createGeneratedConfig).toHaveBeenCalledWith(
				consumer.testDir,
			);
		} finally {
			delete process.env[sentinel];
		}
	});

	it("stops before config and Playwright preflight when environment loading fails", async () => {
		const consumer = await makeConsumer();
		const configMarker = join(consumer.projectRoot, "config-loaded");
		await writeFile(
			consumer.configPath,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(configMarker)}, "loaded"); export default { testDir: "shopify-tests" };\n`,
		);
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.mocked(dependencies.loadEnvironment).mockRejectedValueOnce(
			new ShopifyE2EPreflightError("Consumer .env could not be read"),
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot },
			}),
		).rejects.toThrow("Consumer .env could not be read");
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).not.toHaveBeenCalled();
		expect(dependencies.buildInvocation).not.toHaveBeenCalled();
		expect(dependencies.reportSelection).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
		expect(generated.cleanup).not.toHaveBeenCalled();
		await expect(access(configMarker)).rejects.toThrow();
	});

	it("completes preflight, reports selected paths, starts one child, and cleans up", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot, grep: "checkout with spaces" },
			}),
		).resolves.toBe(0);

		expect(dependencies.reportSelection).toHaveBeenCalledWith({
			configPath: consumer.configPath,
			testDir: consumer.testDir,
		});
		expect(dependencies.runChild).toHaveBeenCalledTimes(1);
		expect(dependencies.buildInvocation).toHaveBeenCalledWith(
			expect.objectContaining({
				controls: { grep: "checkout with spaces" },
			}),
		);
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
		await expect(access(dirname(generated.configPath))).rejects.toThrow();
	});

	it("passes through a valid no-match filter and the child no-tests exit", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({
			exitCode: 1,
			generatedConfig: generated,
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot, grepInvert: ".*" },
			}),
		).resolves.toBe(1);
		expect(dependencies.runChild).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ exitCode: 1, label: "test failure" },
		{ exitCode: 17, label: "runner infrastructure" },
		{ exitCode: 130, label: "SIGINT" },
		{ exitCode: 143, label: "SIGTERM" },
	])("preserves $label child exit $exitCode", async ({ exitCode }) => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({
			exitCode,
			generatedConfig: generated,
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot },
			}),
		).resolves.toBe(exitCode);
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});

	it("never resolves the peer or spawns when dedicated config preflight fails", async () => {
		const consumer = await makeConsumer();
		await rm(consumer.configPath);
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot },
			}),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("cleans temporary state when invocation construction rejects a filter", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.mocked(dependencies.buildInvocation).mockImplementationOnce(() => {
			throw new ShopifyE2EPreflightError(
				"--grep filter must be a non-empty string",
			);
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot, grep: "" },
			}),
		).rejects.toThrow(/non-empty/i);
		expect(dependencies.runChild).not.toHaveBeenCalled();
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});

	it("cleans temporary state after a spawn infrastructure failure", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.mocked(dependencies.runChild).mockRejectedValueOnce(
			new ShopifyE2EInfrastructureError(
				`Could not start Playwright with ${process.execPath}`,
			),
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot },
			}),
		).rejects.toThrow(process.execPath);
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});
});
