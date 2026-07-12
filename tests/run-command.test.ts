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
import { join } from "node:path";

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

async function makeConsumer(): Promise<{
	readonly configPath: string;
	readonly projectRoot: string;
	readonly testDir: string;
}> {
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
}

function makeDependencies(
	generatedConfig: GeneratedPlaywrightConfig,
	exitCode = 0,
): RunCommandDependencies {
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
		reportSelection: vi.fn(),
		resolvePeer: vi.fn(async () => ({
			executablePath: "/consumer/playwright/cli.js",
			packageJsonPath: "/consumer/playwright/package.json",
			packageRoot: "/consumer/playwright",
			version: "1.61.1",
		})),
		runChild: vi.fn(async () => exitCode),
	};
}

async function makeGeneratedConfig(
	projectRoot: string,
): Promise<GeneratedPlaywrightConfig & { cleanup: ReturnType<typeof vi.fn> }> {
	const directoryPath = join(projectRoot, "temporary-config");
	const configPath = join(directoryPath, "playwright.config.mjs");
	await mkdir(directoryPath);
	await writeFile(configPath, "export default {};\n");
	const cleanup = vi.fn(async () =>
		rm(directoryPath, { force: true, recursive: true }),
	);
	return { cleanup, configPath, directoryPath };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("run command orchestration", () => {
	it("completes preflight, reports selected paths, starts one child, and cleans up", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies(generated);

		await expect(
			orchestrateShopifyRun(
				{ cwd: consumer.projectRoot, grep: "checkout with spaces" },
				dependencies,
			),
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
		await expect(access(generated.directoryPath)).rejects.toThrow();
	});

	it("passes through a valid no-match filter and the child no-tests exit", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies(generated, 1);

		await expect(
			orchestrateShopifyRun(
				{ cwd: consumer.projectRoot, grepInvert: ".*" },
				dependencies,
			),
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
		const dependencies = makeDependencies(generated, exitCode);

		await expect(
			orchestrateShopifyRun({ cwd: consumer.projectRoot }, dependencies),
		).resolves.toBe(exitCode);
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});

	it("never resolves the peer or spawns when dedicated config preflight fails", async () => {
		const consumer = await makeConsumer();
		await rm(consumer.configPath);
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies(generated);

		await expect(
			orchestrateShopifyRun({ cwd: consumer.projectRoot }, dependencies),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("cleans temporary state when invocation construction rejects a filter", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies(generated);
		vi.mocked(dependencies.buildInvocation).mockImplementationOnce(() => {
			throw new ShopifyE2EPreflightError(
				"--grep filter must be a non-empty string",
			);
		});

		await expect(
			orchestrateShopifyRun(
				{ cwd: consumer.projectRoot, grep: "" },
				dependencies,
			),
		).rejects.toThrow(/non-empty/i);
		expect(dependencies.runChild).not.toHaveBeenCalled();
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});

	it("cleans temporary state after a spawn infrastructure failure", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies(generated);
		vi.mocked(dependencies.runChild).mockRejectedValueOnce(
			new ShopifyE2EInfrastructureError(
				`Could not start Playwright with ${process.execPath}`,
			),
		);

		await expect(
			orchestrateShopifyRun({ cwd: consumer.projectRoot }, dependencies),
		).rejects.toThrow(process.execPath);
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});
});
