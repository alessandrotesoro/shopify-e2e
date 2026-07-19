import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	orchestrateShopifyRun,
	Run,
	type RunCommandDependencies,
} from "../src/commands/run.js";
import { loadShopifyConfig } from "../src/config/load-config.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../src/errors.js";
import { PACKAGE_ROOT } from "../src/package-root.js";
import type { PlaywrightExecutionContextArtifact } from "../src/playwright/execution-context.cjs";
import { CommandSignalError } from "../src/process/command-signals.js";
import type {
	RoleStateSelection,
	RoleStateStore,
	RoleStateSummary,
} from "../src/role-states/role-state-store.js";

const EMPTY_STATE = { cookies: [], origins: [] } as const;
const helperUrl = pathToFileURL(
	resolve(import.meta.dirname, "../dist/config/public.cjs"),
).href;
const temporaryDirectories: string[] = [];

const makeConsumer = async (
	roles: readonly string[] = ["admin", "customer"],
): Promise<{
	readonly configPath: string;
	readonly projectRoot: string;
	readonly testDir: string;
}> => {
	const projectRoot = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-run-")),
	);
	temporaryDirectories.push(projectRoot);
	const testDir = join(projectRoot, "shopify-tests");
	const configPath = join(projectRoot, "shopify-e2e.config.ts");
	await mkdir(testDir);
	await writeFile(
		configPath,
		`import { defineShopifyE2EConfig } from ${JSON.stringify(helperUrl)};\nexport default defineShopifyE2EConfig({ testDir: "shopify-tests", roles: ${JSON.stringify(roles)} });\n`,
	);
	return { configPath, projectRoot, testDir };
};

const selected = (
	role = "admin",
	state: RoleStateSelection["state"] = EMPTY_STATE,
): RoleStateSelection => ({ role, state });

interface StoreOptions {
	readonly list?: readonly RoleStateSummary[];
	readonly readyRoles?: readonly string[];
	readonly removableRoles?: readonly string[];
	readonly resolve?: (role: string) => Promise<RoleStateSelection>;
}

const makeStore = (options: StoreOptions = {}): RoleStateStore => {
	const summaries =
		options.list ??
		([
			{ role: "admin", status: "ready" },
			{ role: "customer", status: "missing" },
		] as const);
	return {
		list: vi.fn(async () => summaries),
		readyRoles: vi.fn(
			async () =>
				options.readyRoles ??
				summaries
					.filter((summary) => summary.status === "ready")
					.map((summary) => summary.role),
		),
		removableRoles: vi.fn(async () => options.removableRoles ?? []),
		resolve: vi.fn(options.resolve ?? (async (role) => selected(role))),
	} as unknown as RoleStateStore;
};

interface MakeDependenciesOptions {
	readonly artifact?: PlaywrightExecutionContextArtifact;
	readonly exitCode?: number;
	readonly store?: RoleStateStore;
}

const makeDependencies = (
	options: MakeDependenciesOptions = {},
): RunCommandDependencies => {
	const artifact = options.artifact ?? {
		cleanup: vi.fn(async () => undefined),
		contextPath: join(tmpdir(), "shopify-e2e-context-test.json"),
	};
	return {
		buildInvocation: vi.fn(({ configPath, controls, environment, peer }) => ({
			args: [
				peer.executablePath,
				"test",
				"--config",
				configPath,
				"--workers=1",
				...(controls?.grep ? ["--grep", controls.grep] : []),
				...(controls?.grepInvert ? ["--grep-invert", controls.grepInvert] : []),
			],
			environment,
			executable: process.execPath,
		})),
		createExecutionContext: vi.fn(async () => artifact),
		createStore: vi.fn(() => options.store ?? makeStore()),
		loadConfig: vi.fn(loadShopifyConfig),
		loadEnvironment: vi.fn(async ({ cwd }) => realpath(cwd)),
		launchBrowser: vi.fn(async () => ({
			close: vi.fn(async () => undefined),
			unexpectedClose: new Promise<ShopifyE2EInfrastructureError>(
				() => undefined,
			),
			wsEndpoint: "ws://127.0.0.1/playwright-test-endpoint",
		})),
		loadChromium: vi.fn(
			async () =>
				({
					executablePath: () => "/consumer/chromium",
					launch: vi.fn(),
					launchServer: vi.fn(),
				}) as never,
		),
		reportSelection: vi.fn(),
		reportSummary: vi.fn(),
		resolveDataRoot: vi.fn(async () => "/external/role-state-data"),
		resolvePeer: vi.fn(async () => ({
			executablePath: "/consumer/playwright/cli.js",
			modulePath: "/consumer/playwright/index.js",
		})),
		runChild: vi.fn(async () => options.exitCode ?? 0),
		selectRoles: vi.fn(async () => ["admin"]),
	};
};

const runOptions = (
	projectRoot: string,
	overrides: Partial<
		Parameters<typeof orchestrateShopifyRun>[0]["options"]
	> = {},
) => ({
	cwd: projectRoot,
	dataDir: join(projectRoot, "data"),
	role: ["admin"],
	...overrides,
});

beforeEach(() => vi.stubEnv("SHOPIFY_STORE_URL", "https://shop.example"));

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("role-only run orchestration", () => {
	it("exposes only role and title-filter flags", () => {
		expect(Object.keys(Run.flags).sort()).toEqual([
			"grep",
			"grep-invert",
			"role",
		]);
		expect(Run.flags.role.multiple).toBe(true);
	});

	it("deduplicates repeated explicit roles and freezes them in config order before peer work", async () => {
		const consumer = await makeConsumer(["admin", "customer", "staff"]);
		const store = makeStore({
			list: [
				{ role: "admin", status: "ready" },
				{ role: "customer", status: "ready" },
				{ role: "staff", status: "ready" },
			],
		});
		const dependencies = makeDependencies({ store });
		const events: string[] = [];
		vi.mocked(store.resolve).mockImplementation(async (role) => {
			events.push(`resolve:${role}`);
			return selected(role);
		});
		vi.mocked(dependencies.resolvePeer).mockImplementation(async () => {
			events.push("peer");
			return {
				executablePath: "/consumer/playwright/cli.js",
				modulePath: "/consumer/playwright/index.js",
			};
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					role: ["staff", "admin", "staff"],
				}),
			}),
		).resolves.toBe(0);

		expect(events.slice(0, 3)).toEqual([
			"resolve:admin",
			"resolve:staff",
			"peer",
		]);
	});

	it("preflights every explicit role before peer or Playwright work", async () => {
		const consumer = await makeConsumer(["admin", "customer"]);
		const store = makeStore({
			list: [
				{ role: "admin", status: "ready" },
				{ role: "customer", status: "missing" },
			],
		});
		const dependencies = makeDependencies({ store });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					role: ["admin", "customer"],
				}),
			}),
		).rejects.toThrow(/auth capture --role customer/i);

		expect(store.resolve).toHaveBeenCalledWith("admin");
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createExecutionContext).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("runs one explicit role through the real config and pointer-only context", async () => {
		const consumer = await makeConsumer();
		const state = {
			cookies: [
				{
					domain: "shop.example",
					expires: -1,
					httpOnly: true,
					name: "session",
					path: "/",
					sameSite: "Lax" as const,
					secure: true,
					value: "secret",
				},
			],
			origins: [],
		};
		const store = makeStore({ resolve: async (role) => selected(role, state) });
		const dependencies = makeDependencies({ store });
		const environment = { SHOPIFY_STORE_URL: "https://shop.example/path" };

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					environment,
					grep: "account",
					grepInvert: "draft",
				}),
			}),
		).resolves.toBe(0);

		expect(dependencies.selectRoles).not.toHaveBeenCalled();
		expect(dependencies.createExecutionContext).toHaveBeenCalledWith({
			configPath: consumer.configPath,
			normalizedOrigin: "https://shop.example",
			packageRoot: PACKAGE_ROOT,
			projectRoot: consumer.projectRoot,
			role: "admin",
			state,
			testDir: consumer.testDir,
		});
		expect(dependencies.buildInvocation).toHaveBeenCalledWith(
			expect.objectContaining({
				configPath: consumer.configPath,
				controls: { grep: "account", grepInvert: "draft" },
				environment: {
					PW_TEST_CONNECT_WS_ENDPOINT:
						"ws://127.0.0.1/playwright-test-endpoint",
					SHOPIFY_E2E_EXECUTION_CONTEXT: join(
						tmpdir(),
						"shopify-e2e-context-test.json",
					),
					SHOPIFY_STORE_URL: "https://shop.example/path",
				},
			}),
		);
		expect(environment).toEqual({
			SHOPIFY_STORE_URL: "https://shop.example/path",
		});
		expect(dependencies.reportSelection).toHaveBeenCalledWith({
			configPath: consumer.configPath,
			role: "admin",
			testDir: consumer.testDir,
		});
		expect(dependencies.runChild).toHaveBeenCalledOnce();
	});

	it("prompts once for a ready-role subset and resolves it in config order", async () => {
		const consumer = await makeConsumer(["admin", "customer", "staff"]);
		const store = makeStore({
			list: [
				{ role: "admin", status: "ready" },
				{ role: "customer", status: "missing" },
				{ role: "staff", status: "ready" },
			],
			readyRoles: ["admin", "staff"],
		});
		const dependencies = makeDependencies({ store });
		vi.mocked(dependencies.selectRoles).mockResolvedValue(["staff", "admin"]);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					interactive: true,
					role: undefined,
				}),
			}),
		).resolves.toBe(0);

		expect(dependencies.selectRoles).toHaveBeenCalledOnce();
		expect(dependencies.selectRoles).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [
					{ name: "admin", value: "admin" },
					{ name: "staff", value: "staff" },
				],
			}),
		);
		expect(store.resolve).toHaveBeenNthCalledWith(1, "admin");
		expect(store.resolve).toHaveBeenNthCalledWith(2, "staff");
	});

	it("runs selected roles serially against one browser and cleans between them", async () => {
		const consumer = await makeConsumer(["admin", "customer"]);
		const store = makeStore({
			list: [
				{ role: "admin", status: "ready" },
				{ role: "customer", status: "ready" },
			],
		});
		const dependencies = makeDependencies({ store });
		const events: string[] = [];
		vi.mocked(dependencies.createExecutionContext).mockImplementation(
			async ({ role }) => ({
				cleanup: vi.fn(async () => {
					events.push(`cleanup:${role}`);
				}),
				contextPath: join(tmpdir(), `shopify-e2e-${role}.json`),
			}),
		);
		vi.mocked(dependencies.runChild).mockImplementation(async (invocation) => {
			const contextPath = invocation.environment?.SHOPIFY_E2E_EXECUTION_CONTEXT;
			events.push(
				`child:${contextPath?.includes("admin") ? "admin" : "customer"}`,
			);
			return 0;
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					role: ["customer", "admin"],
				}),
			}),
		).resolves.toBe(0);

		expect(dependencies.launchBrowser).toHaveBeenCalledOnce();
		expect(events).toEqual([
			"child:admin",
			"cleanup:admin",
			"child:customer",
			"cleanup:customer",
		]);
		expect(dependencies.reportSummary).toHaveBeenCalledWith([
			{ role: "admin", status: "passed" },
			{ role: "customer", status: "passed" },
		]);
	});

	it("stops after the first failing role and reports later roles not run", async () => {
		const consumer = await makeConsumer(["admin", "customer", "guest"]);
		const store = makeStore({
			list: [
				{ role: "admin", status: "ready" },
				{ role: "customer", status: "ready" },
				{ role: "guest", status: "ready" },
			],
		});
		const dependencies = makeDependencies({ store });
		vi.mocked(dependencies.runChild)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(1);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					role: ["admin", "customer", "guest"],
				}),
			}),
		).resolves.toBe(1);

		expect(dependencies.runChild).toHaveBeenCalledTimes(2);
		expect(dependencies.reportSummary).toHaveBeenCalledWith([
			{ role: "admin", status: "passed" },
			{ exitCode: 1, role: "customer", status: "failed" },
			{ role: "guest", status: "not-run" },
		]);
	});

	it("gives final browser cleanup failure precedence over successful roles", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();
		vi.mocked(dependencies.launchBrowser).mockResolvedValueOnce({
			close: vi.fn(async () => {
				throw new ShopifyE2EInfrastructureError("browser cleanup failed");
			}),
			unexpectedClose: new Promise(() => undefined),
			wsEndpoint: "ws://127.0.0.1/playwright-test-endpoint",
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot),
			}),
		).rejects.toThrow(/browser cleanup failed/);
	});

	it("rejects omitted non-interactive role before state or Playwright work", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					interactive: false,
					role: undefined,
				}),
			}),
		).rejects.toThrow(/--role/);
		expect(dependencies.resolveDataRoot).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createExecutionContext).not.toHaveBeenCalled();
	});

	it("rejects an invalid role without echoing unsafe input", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();
		const unsafeRole = "admin\nsecret=/private/state";

		const error = await orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, { role: [unsafeRole] }),
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect(String(error)).toMatch(/role is invalid/i);
		expect(String(error)).not.toContain(unsafeRole);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("rejects an unknown role with list guidance before state inspection", async () => {
		const consumer = await makeConsumer();
		const store = makeStore();
		const dependencies = makeDependencies({ store });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, { role: ["merchant"] }),
			}),
		).rejects.toThrow(/merchant.*auth list/i);
		expect(store.list).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		{
			expected: /auth capture --role admin/i,
			label: "missing",
			removableRoles: [] as string[],
			status: "missing" as const,
		},
		{
			expected: /auth remove --role admin.*auth capture --role admin/i,
			label: "path-safe invalid",
			removableRoles: ["admin"],
			status: "invalid" as const,
		},
		{
			expected: /unsafe.*manual cleanup/i,
			label: "unsafe collision",
			removableRoles: [] as string[],
			status: "invalid" as const,
		},
	])("rejects $label state with exact remediation before peer work", async ({
		expected,
		removableRoles,
		status,
	}) => {
		const consumer = await makeConsumer();
		const store = makeStore({
			list: [{ role: "admin", status }],
			removableRoles,
		});
		const dependencies = makeDependencies({ store });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot),
			}),
		).rejects.toThrow(expected);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createExecutionContext).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("rejects an empty interactive ready set without opening a prompt", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies({
			store: makeStore({ readyRoles: [] }),
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					interactive: true,
					role: undefined,
				}),
			}),
		).rejects.toThrow(/auth capture --role <role>/i);
		expect(dependencies.selectRoles).not.toHaveBeenCalled();
	});

	it("rejects an empty interactive selection before peer or Playwright work", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();
		vi.mocked(dependencies.selectRoles).mockResolvedValue([]);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					interactive: true,
					role: undefined,
				}),
			}),
		).rejects.toThrow(/at least one role/i);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.createExecutionContext).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("revalidates a stale prompt result and returns state remediation", async () => {
		const consumer = await makeConsumer();
		const store = makeStore({
			list: [{ role: "admin", status: "missing" }],
			readyRoles: ["admin"],
		});
		const dependencies = makeDependencies({ store });

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, {
					interactive: true,
					role: undefined,
				}),
			}),
		).rejects.toThrow(/auth capture --role admin/i);
		expect(dependencies.selectRoles).toHaveBeenCalledOnce();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("does not perform filename discovery before a run", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot),
			}),
		).resolves.toBe(0);
		expect(dependencies.loadConfig).toHaveBeenCalledOnce();
		expect(dependencies.runChild).toHaveBeenCalledOnce();
	});

	it("loads environment before config and rejects origin drift before state work", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();
		const environment: NodeJS.ProcessEnv = {};
		vi.mocked(dependencies.loadEnvironment).mockImplementationOnce(
			async ({ cwd }) => {
				environment.SHOPIFY_STORE_URL = "https://shop.example/path";
				return realpath(cwd);
			},
		);
		vi.mocked(dependencies.loadConfig).mockImplementationOnce(
			async (options) => {
				const loaded = await loadShopifyConfig(options);
				environment.SHOPIFY_STORE_URL = "https://other.example";
				return loaded;
			},
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot, { environment }),
			}),
		).rejects.toThrow(/SHOPIFY_STORE_URL changed.*\.env/i);
		expect(dependencies.createStore).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		"not-a-url",
		"http://shop.example",
	])("classifies trusted config origin drift to %s as preflight", async (changedUrl) => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();
		const environment: NodeJS.ProcessEnv = {
			SHOPIFY_STORE_URL: "https://shop.example",
		};
		vi.mocked(dependencies.loadConfig).mockImplementationOnce(
			async (options) => {
				const loaded = await loadShopifyConfig(options);
				environment.SHOPIFY_STORE_URL = changedUrl;
				return loaded;
			},
		);

		const error = await orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, { environment }),
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect(error).toMatchObject({ exitCode: 2 });
		expect(String(error)).toMatch(/changed.*invalid.*\.env/i);
		expect(dependencies.createStore).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("rejects a reserved context key before config evaluation", async () => {
		const consumer = await makeConsumer();
		const dependencies = makeDependencies();
		const secret = "/private/context-secret.json";
		const error = await orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, {
				environment: {
					SHOPIFY_E2E_EXECUTION_CONTEXT: secret,
					SHOPIFY_STORE_URL: "https://shop.example",
				},
			}),
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect(String(error)).toMatch(/reserved/i);
		expect(String(error)).not.toContain(secret);
		expect(dependencies.createStore).not.toHaveBeenCalled();
	});

	it.each([
		0, 1, 17, 130, 143,
	])("preserves child exit %s and cleans context after settlement", async (exitCode) => {
		const consumer = await makeConsumer();
		const cleanup = vi.fn(async () => undefined);
		const dependencies = makeDependencies({
			artifact: {
				cleanup,
				contextPath: join(tmpdir(), "shopify-e2e-context-exit.json"),
			},
			exitCode,
		});

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot),
			}),
		).resolves.toBe(exitCode);
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("gives cleanup failure precedence over a child failure", async () => {
		const consumer = await makeConsumer();
		const cleanupError = new Error("context cleanup failed");
		const dependencies = makeDependencies({
			artifact: {
				cleanup: vi.fn(async () => {
					throw cleanupError;
				}),
				contextPath: join(tmpdir(), "shopify-e2e-context-cleanup.json"),
			},
		});
		vi.mocked(dependencies.runChild).mockRejectedValue(
			new ShopifyE2EInfrastructureError("child failed"),
		);

		await expect(
			orchestrateShopifyRun({
				dependencies,
				options: runOptions(consumer.projectRoot),
			}),
		).rejects.toBe(cleanupError);
	});

	it("cleans context after invocation construction or child spawn errors", async () => {
		const consumer = await makeConsumer();
		for (const failure of ["invocation", "child"] as const) {
			const cleanup = vi.fn(async () => undefined);
			const dependencies = makeDependencies({
				artifact: {
					cleanup,
					contextPath: join(tmpdir(), `shopify-e2e-${failure}.json`),
				},
			});
			if (failure === "invocation") {
				vi.mocked(dependencies.buildInvocation).mockImplementationOnce(() => {
					throw new ShopifyE2EPreflightError("invalid filter");
				});
			} else {
				vi.mocked(dependencies.runChild).mockRejectedValueOnce(
					new ShopifyE2EInfrastructureError("spawn failed"),
				);
			}

			await expect(
				orchestrateShopifyRun({
					dependencies,
					options: runOptions(consumer.projectRoot),
				}),
			).rejects.toThrow(failure === "invocation" ? /filter/ : /spawn/);
			expect(cleanup).toHaveBeenCalledOnce();
		}
	});

	it("waits for pending context creation and cleans it when a signal wins", async () => {
		const consumer = await makeConsumer();
		const cleanup = vi.fn(async () => undefined);
		const artifact = {
			cleanup,
			contextPath: join(tmpdir(), "shopify-e2e-context-pending.json"),
		};
		const dependencies = makeDependencies({ artifact });
		const controller = new AbortController();
		let resolveCreation:
			| ((value: PlaywrightExecutionContextArtifact) => void)
			| undefined;
		const creation = new Promise<PlaywrightExecutionContextArtifact>(
			(resolveValue) => {
				resolveCreation = resolveValue;
			},
		);
		vi.mocked(dependencies.createExecutionContext).mockReturnValueOnce(
			creation,
		);

		const outcome = orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, { signal: controller.signal }),
		}).catch((error: unknown) => error);
		await vi.waitFor(() =>
			expect(dependencies.createExecutionContext).toHaveBeenCalledOnce(),
		);
		controller.abort("SIGTERM");
		let settled = false;
		void outcome.then(() => {
			settled = true;
		});
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		expect(settled).toBe(false);
		resolveCreation?.(artifact);

		await expect(outcome).resolves.toMatchObject({
			exitCode: 143,
			signal: "SIGTERM",
		});
		expect(cleanup).toHaveBeenCalledOnce();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it.each([
		"data-root",
		"ready-list",
		"role-prompt",
		"state-resolve",
		"invalid-remediation",
		"peer",
	] as const)("stops at the %s signal checkpoint before context creation", async (checkpoint) => {
		const consumer = await makeConsumer();
		const controller = new AbortController();
		const store = makeStore();
		const dependencies = makeDependencies({ store });
		const abort = () => controller.abort("SIGTERM");
		let role: readonly string[] | undefined = ["admin"];
		let interactive = false;
		if (checkpoint === "data-root") {
			vi.mocked(dependencies.resolveDataRoot).mockImplementationOnce(
				async () => {
					abort();
					return "/external/role-state-data";
				},
			);
		}
		if (checkpoint === "ready-list" || checkpoint === "role-prompt") {
			role = undefined;
			interactive = true;
		}
		if (checkpoint === "ready-list") {
			vi.mocked(store.readyRoles).mockImplementationOnce(async () => {
				abort();
				return ["admin"];
			});
		}
		if (checkpoint === "role-prompt") {
			vi.mocked(dependencies.selectRoles).mockImplementationOnce(async () => {
				abort();
				return ["admin"];
			});
		}
		if (checkpoint === "state-resolve") {
			vi.mocked(store.resolve).mockImplementationOnce(async () => {
				abort();
				return selected();
			});
		}
		if (checkpoint === "invalid-remediation") {
			vi.mocked(store.list).mockResolvedValueOnce([
				{ role: "admin", status: "invalid" },
			]);
			vi.mocked(store.removableRoles).mockImplementationOnce(async () => {
				abort();
				return ["admin"];
			});
		}
		if (checkpoint === "peer") {
			vi.mocked(dependencies.resolvePeer).mockImplementationOnce(async () => {
				abort();
				return {
					executablePath: "/consumer/playwright/cli.js",
					modulePath: "/consumer/playwright/index.js",
				};
			});
		}

		const error = await orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, {
				interactive,
				role,
				signal: controller.signal,
			}),
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CommandSignalError);
		expect(error).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
		expect(dependencies.createExecutionContext).not.toHaveBeenCalled();
		expect(dependencies.runChild).not.toHaveBeenCalled();
	});

	it("keeps the signal authoritative during child execution and context cleanup", async () => {
		const consumer = await makeConsumer();
		const controller = new AbortController();
		const cleanup = vi.fn(async () => undefined);
		const dependencies = makeDependencies({
			artifact: {
				cleanup,
				contextPath: join(tmpdir(), "shopify-e2e-context-signal.json"),
			},
		});
		vi.mocked(dependencies.runChild).mockImplementationOnce(async () => {
			controller.abort("SIGINT");
			return 0;
		});

		const error = await orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, { signal: controller.signal }),
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CommandSignalError);
		expect(error).toMatchObject({ exitCode: 130, signal: "SIGINT" });
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("retries interrupted cleanup and sanitizes a persistent failure", async () => {
		const consumer = await makeConsumer();
		const controller = new AbortController();
		const cleanup = vi.fn(async () => {
			controller.abort("SIGTERM");
			throw new Error("private cleanup cause");
		});
		const dependencies = makeDependencies({
			artifact: {
				cleanup,
				contextPath: join(tmpdir(), "shopify-e2e-context-retry.json"),
			},
		});

		const error = await orchestrateShopifyRun({
			dependencies,
			options: runOptions(consumer.projectRoot, { signal: controller.signal }),
		}).catch((cause: unknown) => cause);

		expect(error).toMatchObject({
			exitCode: 143,
			message:
				"Shopify test run interrupted; temporary Playwright cleanup could not complete.",
			signal: "SIGTERM",
		});
		expect(String(error)).not.toContain("private cleanup cause");
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
});
