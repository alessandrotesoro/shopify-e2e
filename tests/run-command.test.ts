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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	orchestrateShopifyRun,
	type RunCommandDependencies,
} from "../src/commands/run.js";
import { loadRunnableShopifyConfig } from "../src/config/load-config.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../src/errors.js";
import { PACKAGE_ROOT } from "../src/package-root.js";
import type { GeneratedPlaywrightConfig } from "../src/playwright/generated-config.js";
import { CommandSignalError } from "../src/process/command-signals.js";
import {
	EMPTY_STORAGE_STATE,
	type ProfileSelection,
	type RunnableProfileSummary,
} from "../src/profiles/profile-store.js";

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
	await writeFile(
		configPath,
		'export default { testDir: "shopify-tests", roles: { guest: { authentication: "none" } } };\n',
	);
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
		createStore: vi.fn(() => {
			throw new Error("profile store should not be used for guest");
		}),
		loadConfig: vi.fn(loadRunnableShopifyConfig),
		loadEnvironment: vi.fn(async ({ cwd }) => realpath(cwd)),
		reportSelection: vi.fn(),
		resolveDataRoot: vi.fn(async () => "/external/profile-data"),
		resolvePeer: vi.fn(async () => ({
			executablePath: "/consumer/playwright/cli.js",
			modulePath: "/consumer/playwright/index.js",
		})),
		runChild: vi.fn(async () => exitCode),
		selectProfile: vi.fn(async () => "guest"),
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

beforeEach(() => vi.stubEnv("SHOPIFY_STORE_URL", "https://shop.example"));

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("run command orchestration", () => {
	const useStore = (
		dependencies: RunCommandDependencies,
		options: {
			readonly profiles?: readonly RunnableProfileSummary[];
			readonly resolve?: (name: string) => Promise<ProfileSelection>;
		} = {},
	): void => {
		vi.mocked(dependencies.createStore).mockReturnValue({
			resolve:
				options.resolve ??
				(async (name: string) => ({
					kind: "saved",
					name,
					role: "admin",
					state: { cookies: [], origins: [] },
				})),
			runnableProfiles: vi.fn(async () => options.profiles ?? []),
		} as never);
	};

	it("shows one interactive profile prompt, freezes the chosen tuple, and starts immediately", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		const selectedState = {
			cookies: [],
			origins: [
				{
					localStorage: [{ name: "session", value: "selected" }],
					origin: "https://shop.example",
				},
			],
		};
		useStore(dependencies, {
			profiles: [
				{ kind: "saved", name: "admin-primary", role: "admin" },
				{ kind: "unauthenticated", name: "guest", role: "guest" },
			],
			resolve: async (name) => ({
				kind: "saved",
				name,
				role: "admin",
				state: selectedState,
			}),
		});
		vi.mocked(dependencies.selectProfile).mockResolvedValue("admin-primary");

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "data"),
					interactive: true,
				},
			}),
		).resolves.toBe(0);

		expect(dependencies.selectProfile).toHaveBeenCalledTimes(1);
		expect(dependencies.selectProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [
					{ name: "admin-primary - admin", value: "admin-primary" },
					{ name: "guest - unauthenticated", value: "guest" },
				],
			}),
		);
		expect(dependencies.createGeneratedConfig).toHaveBeenCalledWith({
			packageRoot: PACKAGE_ROOT,
			projectRoot: consumer.projectRoot,
			selection: {
				kind: "saved",
				name: "admin-primary",
				role: "admin",
				state: selectedState,
			},
			testDir: consumer.testDir,
		});
		expect(dependencies.reportSelection).toHaveBeenCalledTimes(1);
		expect(dependencies.runChild).toHaveBeenCalledTimes(1);
	});

	it("uses an explicit saved profile without prompting", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		useStore(dependencies);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "data"),
					profile: "admin-primary",
				},
			}),
		).resolves.toBe(0);

		expect(dependencies.selectProfile).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).toHaveBeenCalledWith({
			packageRoot: PACKAGE_ROOT,
			projectRoot: consumer.projectRoot,
			selection: expect.objectContaining({
				kind: "saved",
				name: "admin-primary",
				role: "admin",
			}),
			testDir: consumer.testDir,
		});
	});

	it("rejects bare non-interactive use before peer resolution or config generation", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		useStore(dependencies);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "data"),
					interactive: false,
				},
			}),
		).rejects.toThrow(/--profile/);
		expect(dependencies.selectProfile).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("rejects a missing store URL before config, profile, or Playwright work", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.stubEnv("SHOPIFY_STORE_URL", "");

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot, profile: "guest" },
			}),
		).rejects.toThrow(/SHOPIFY_STORE_URL is required/);
		expect(dependencies.createStore).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).not.toHaveBeenCalled();
	});

	it("rejects URL userinfo with .env remediation before Playwright work", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.stubEnv(
			"SHOPIFY_STORE_URL",
			"https://customer:storefront-password@shop.example",
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot, profile: "guest" },
			}),
		).rejects.toThrow(/SHOPIFY_STORE_URL.*\.env/i);
		expect(dependencies.createStore).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).not.toHaveBeenCalled();
	});

	it.each([
		{ changedUrl: undefined, label: "removes" },
		{ changedUrl: "https://other-shop.example", label: "changes" },
	])("fails closed when trusted config $label SHOPIFY_STORE_URL", async ({
		changedUrl,
	}) => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		const environment: NodeJS.ProcessEnv = {
			SHOPIFY_STORE_URL: "https://shop.example/path",
		};
		vi.mocked(dependencies.loadConfig).mockImplementationOnce(
			async (options) => {
				const loaded = await loadRunnableShopifyConfig(options);
				environment.SHOPIFY_STORE_URL = changedUrl;
				return loaded;
			},
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					environment,
					profile: "guest",
				},
			}),
		).rejects.toThrow(/SHOPIFY_STORE_URL.*(?:removed|changed).*\.env/i);
		expect(dependencies.createStore).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("rejects an empty interactive registry with capture/configuration guidance", async () => {
		const consumer = await makeConsumer();
		await writeFile(
			consumer.configPath,
			'export default { testDir: "shopify-tests", roles: { admin: { authentication: "required" } } };\n',
		);
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		useStore(dependencies);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "data"),
					interactive: true,
				},
			}),
		).rejects.toThrow(/Capture one or configure an unauthenticated role/);
		expect(dependencies.selectProfile).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("fails closed when the interactive prompt returns an unavailable profile", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		useStore(dependencies, {
			profiles: [
				{ kind: "saved", name: "admin-primary", role: "admin" },
				{ kind: "unauthenticated", name: "guest", role: "guest" },
			],
		});
		vi.mocked(dependencies.selectProfile).mockResolvedValue("removed-profile");

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "data"),
					interactive: true,
				},
			}),
		).rejects.toThrow(/selected profile is unavailable/i);
		expect(dependencies.selectProfile).toHaveBeenCalledTimes(1);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createGeneratedConfig).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("fails closed when a saved profile collides with an unauthenticated role", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		useStore(dependencies, {
			profiles: [
				{ kind: "saved", name: "guest", role: "admin" },
				{ kind: "unauthenticated", name: "guest", role: "guest" },
			],
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "data"),
					interactive: true,
				},
			}),
		).rejects.toThrow(/collides with an unauthenticated role/);
		expect(dependencies.selectProfile).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("resolves explicit guest without touching an absent or corrupt profile registry", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.mocked(dependencies.resolveDataRoot).mockRejectedValue(
			new Error("corrupt registry must stay unused"),
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					dataDir: join(consumer.projectRoot, "corrupt-data"),
					profile: "guest",
				},
			}),
		).resolves.toBe(0);
		expect(dependencies.resolveDataRoot).not.toHaveBeenCalled();
		expect(dependencies.createStore).not.toHaveBeenCalled();
	});

	it("loads the invocation environment before evaluating trusted config", async () => {
		const consumer = await makeConsumer();
		const sentinel = "SHOPIFY_E2E_DOTENV_ORDER_SENTINEL";
		await writeFile(
			consumer.configPath,
			`export default { testDir: process.env.${sentinel} === "loaded-before-config" ? "shopify-tests" : "missing-tests", roles: { guest: { authentication: "none" } } };\n`,
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
					options: { cwd: consumer.projectRoot, profile: "guest" },
				}),
			).resolves.toBe(0);

			expect(dependencies.loadEnvironment).toHaveBeenCalledWith({
				cwd: consumer.projectRoot,
				environment: process.env,
			});
			expect(dependencies.createGeneratedConfig).toHaveBeenCalledWith({
				packageRoot: PACKAGE_ROOT,
				projectRoot: consumer.projectRoot,
				selection: {
					kind: "unauthenticated",
					name: "guest",
					role: "guest",
					state: { cookies: [], origins: [] },
				},
				testDir: consumer.testDir,
			});
		} finally {
			delete process.env[sentinel];
		}
	});

	it("stops before config and Playwright preflight when environment loading fails", async () => {
		const consumer = await makeConsumer();
		const configMarker = join(consumer.projectRoot, "config-loaded");
		await writeFile(
			consumer.configPath,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(configMarker)}, "loaded"); export default { testDir: "shopify-tests", roles: { guest: { authentication: "none" } } };\n`,
		);
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		vi.mocked(dependencies.loadEnvironment).mockRejectedValueOnce(
			new ShopifyE2EPreflightError("Consumer .env could not be read"),
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: { cwd: consumer.projectRoot, profile: "guest" },
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

	it.each([
		"environment",
		"data-root",
		"runnable-list",
		"profile-prompt",
		"profile-resolve",
		"peer",
		"generated-config",
	] as const)("stops at the %s preflight signal checkpoint without starting Playwright", async (checkpoint) => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		const controller = new AbortController();
		let profile: string | undefined = "guest";
		let interactive = false;

		if (checkpoint === "environment") {
			vi.mocked(dependencies.loadEnvironment).mockImplementationOnce(
				async ({ cwd }) => {
					controller.abort("SIGTERM");
					return realpath(cwd);
				},
			);
		}
		if (checkpoint === "data-root") {
			profile = "admin-primary";
			vi.mocked(dependencies.resolveDataRoot).mockImplementationOnce(
				async () => {
					controller.abort("SIGTERM");
					return "/external/profile-data";
				},
			);
		}
		if (
			checkpoint === "runnable-list" ||
			checkpoint === "profile-prompt" ||
			checkpoint === "profile-resolve"
		) {
			profile = undefined;
			interactive = true;
			const resolve = vi.fn(async (name: string) => ({
				kind: "saved" as const,
				name,
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			}));
			const runnableProfiles = vi.fn(async () => [
				{ kind: "saved" as const, name: "admin-primary", role: "admin" },
			]);
			if (checkpoint === "runnable-list") {
				runnableProfiles.mockImplementationOnce(async () => {
					controller.abort("SIGTERM");
					return [
						{
							kind: "saved" as const,
							name: "admin-primary",
							role: "admin",
						},
					];
				});
			}
			if (checkpoint === "profile-prompt") {
				vi.mocked(dependencies.selectProfile).mockImplementationOnce(
					async () => {
						controller.abort("SIGTERM");
						return "admin-primary";
					},
				);
			}
			if (checkpoint === "profile-resolve") {
				vi.mocked(dependencies.selectProfile).mockResolvedValueOnce(
					"admin-primary",
				);
				resolve.mockImplementationOnce(async (name) => {
					controller.abort("SIGTERM");
					return {
						kind: "saved" as const,
						name,
						role: "admin",
						state: EMPTY_STORAGE_STATE,
					};
				});
			}
			vi.mocked(dependencies.createStore).mockReturnValue({
				resolve,
				runnableProfiles,
			} as never);
		}
		if (checkpoint === "peer") {
			vi.mocked(dependencies.resolvePeer).mockImplementationOnce(async () => {
				controller.abort("SIGTERM");
				return {
					executablePath: "/consumer/playwright/cli.js",
					modulePath: "/consumer/playwright/index.js",
				};
			});
		}
		if (checkpoint === "generated-config") {
			vi.mocked(dependencies.createGeneratedConfig).mockImplementationOnce(
				async () => {
					controller.abort("SIGTERM");
					return generated;
				},
			);
		}

		const error = await orchestrateShopifyRun({
			dependencies,
			options: {
				cwd: consumer.projectRoot,
				dataDir: join(consumer.projectRoot, "data"),
				interactive,
				profile,
				signal: controller.signal,
			},
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CommandSignalError);
		expect(error).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
		expect(dependencies.buildInvocation).not.toHaveBeenCalled();
		expect(dependencies.reportSelection).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
		if (checkpoint === "generated-config") {
			expect(generated.cleanup).toHaveBeenCalledOnce();
		}
	});

	it("waits for pending generated-config creation and cleanup before reporting interruption", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		const controller = new AbortController();
		let resolveCreation:
			| ((value: GeneratedPlaywrightConfig) => void)
			| undefined;
		const creation = new Promise<GeneratedPlaywrightConfig>((resolveValue) => {
			resolveCreation = resolveValue;
		});
		vi.mocked(dependencies.createGeneratedConfig).mockReturnValueOnce(creation);

		const outcome = orchestrateShopifyRun({
			dependencies,
			options: {
				cwd: consumer.projectRoot,
				profile: "guest",
				signal: controller.signal,
			},
		}).catch((error: unknown) => error);
		await vi.waitFor(() =>
			expect(dependencies.createGeneratedConfig).toHaveBeenCalledOnce(),
		);
		controller.abort("SIGTERM");
		let settled = false;
		void outcome.then(() => {
			settled = true;
		});
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		expect(settled).toBe(false);

		resolveCreation?.(generated);
		await expect(outcome).resolves.toMatchObject({
			exitCode: 143,
			signal: "SIGTERM",
		});
		expect(generated.cleanup).toHaveBeenCalledOnce();
		expect(dependencies.buildInvocation).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("retries interrupted generated-config cleanup and reports persistent failure", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		const controller = new AbortController();
		let resolveCreation:
			| ((value: GeneratedPlaywrightConfig) => void)
			| undefined;
		const creation = new Promise<GeneratedPlaywrightConfig>((resolveValue) => {
			resolveCreation = resolveValue;
		});
		vi.mocked(dependencies.createGeneratedConfig).mockReturnValueOnce(creation);
		generated.cleanup.mockRejectedValue(new Error("private cleanup cause"));

		const outcome = orchestrateShopifyRun({
			dependencies,
			options: {
				cwd: consumer.projectRoot,
				profile: "guest",
				signal: controller.signal,
			},
		}).catch((error: unknown) => error);
		await vi.waitFor(() =>
			expect(dependencies.createGeneratedConfig).toHaveBeenCalledOnce(),
		);
		controller.abort("SIGTERM");
		resolveCreation?.(generated);

		await expect(outcome).resolves.toMatchObject({
			exitCode: 143,
			message:
				"Shopify test run interrupted; temporary Playwright cleanup could not complete.",
			signal: "SIGTERM",
		});
		expect(generated.cleanup).toHaveBeenCalledTimes(2);
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it.each([
		{ abortDuring: "child", expectedExitCode: 143, reason: "SIGTERM" },
		{ abortDuring: "cleanup", expectedExitCode: 130, reason: "SIGINT" },
	] as const)("reports $expectedExitCode when interrupted during $abortDuring even if the child returns zero", async ({
		abortDuring,
		expectedExitCode,
		reason,
	}) => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });
		const controller = new AbortController();
		if (abortDuring === "child") {
			vi.mocked(dependencies.runChild).mockImplementationOnce(async () => {
				controller.abort(reason);
				return 0;
			});
		} else {
			generated.cleanup.mockImplementationOnce(async () => {
				await rm(dirname(generated.configPath), {
					force: true,
					recursive: true,
				});
				controller.abort(reason);
			});
		}

		const error = await orchestrateShopifyRun({
			dependencies,
			options: {
				cwd: consumer.projectRoot,
				profile: "guest",
				signal: controller.signal,
			},
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CommandSignalError);
		expect(error).toMatchObject({ exitCode: expectedExitCode, signal: reason });
		expect(generated.cleanup).toHaveBeenCalledOnce();
	});

	it("completes preflight, reports selected paths, starts one child, and cleans up", async () => {
		const consumer = await makeConsumer();
		const generated = await makeGeneratedConfig(consumer.projectRoot);
		const dependencies = makeDependencies({ generatedConfig: generated });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: {
					cwd: consumer.projectRoot,
					grep: "checkout with spaces",
					profile: "guest",
				},
			}),
		).resolves.toBe(0);

		expect(dependencies.reportSelection).toHaveBeenCalledWith({
			configPath: consumer.configPath,
			profile: "guest",
			role: "guest",
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
				options: {
					cwd: consumer.projectRoot,
					grepInvert: ".*",
					profile: "guest",
				},
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
				options: { cwd: consumer.projectRoot, profile: "guest" },
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
				options: { cwd: consumer.projectRoot, profile: "guest" },
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
				options: { cwd: consumer.projectRoot, grep: "", profile: "guest" },
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
				options: { cwd: consumer.projectRoot, profile: "guest" },
			}),
		).rejects.toThrow(process.execPath);
		expect(generated.cleanup).toHaveBeenCalledTimes(1);
	});
});
