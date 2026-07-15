import { describe, expect, it, vi } from "vitest";

import type { LoadedShopifyConfig } from "../src/config/load-config.js";
import {
	DOCTOR_CHECK_ORDER,
	type DoctorDependencies,
	orchestrateDoctor,
} from "../src/doctor/doctor-orchestrator.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";
import type { CommandSignalError } from "../src/process/command-signals.js";

const projectRoot = "/physical/consumer";
const loadedConfig: LoadedShopifyConfig = {
	configPath: `${projectRoot}/shopify-e2e.config.ts`,
	projectRoot,
	roles: { guest: { authentication: "none" } },
	testDir: `${projectRoot}/shopify-tests`,
};

const makeDependencies = (): DoctorDependencies => ({
	discoverSpecs: vi.fn(async () => [
		`${projectRoot}/shopify-tests/checkout.spec.ts`,
	]),
	loadChromium: vi.fn(async () => ({
		executablePath: () => "/browser/chromium",
		launch: vi.fn(),
	})),
	loadConfig: vi.fn(async () => loadedConfig),
	loadProjectEnvironment: vi.fn(async () => undefined),
	normalizeOrigin: vi.fn(() => "https://shop.example"),
	resolvePeer: vi.fn(async () => ({
		executablePath: `${projectRoot}/node_modules/@playwright/test/cli.js`,
		modulePath: `${projectRoot}/node_modules/@playwright/test/index.js`,
	})),
	resolveProjectRoot: vi.fn(async () => projectRoot),
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
		vi.mocked(dependencies.normalizeOrigin).mockImplementation(() => {
			throw new ShopifyE2EPreflightError("SHOPIFY_STORE_URL must use HTTPS");
		});

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
