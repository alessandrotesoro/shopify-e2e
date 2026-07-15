import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoleStateStore } from "../src/role-states/role-state-store.js";
import {
	cleanupInstalledCliFixture,
	makeTemporaryDirectory,
	packVerifiedPackage,
} from "./support/installed-cli-harness.js";
import {
	installedCliPath,
	installPackedPackage,
} from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const origin = "https://shop.example";

interface InstalledConsumer {
	readonly dataRoot: string;
	readonly root: string;
}

const runCli = (
	consumer: InstalledConsumer,
	args: readonly string[],
	overrides: NodeJS.ProcessEnv = {},
) =>
	spawnSync(installedCliPath(consumer.root), args, {
		cwd: consumer.root,
		encoding: "utf8",
		env: {
			...process.env,
			NO_COLOR: "1",
			SHOPIFY_E2E_DATA_DIR: consumer.dataRoot,
			SHOPIFY_STORE_URL: origin,
			...overrides,
		},
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
	});

const seedRole = async (
	consumer: InstalledConsumer,
	role: string,
	value: string,
): Promise<void> => {
	await createRoleStateStore({
		dataRoot: consumer.dataRoot,
		origin,
		roles: ["admin", "customer"],
	}).capture({
		role,
		state: {
			cookies: [
				{
					domain: "shop.example",
					expires: -1,
					httpOnly: true,
					name: "installed-role-sentinel",
					path: "/",
					sameSite: "Lax",
					secure: true,
					value,
				},
			],
			origins: [],
		},
	});
};

const prepareEsmConsumer = async (
	tarballPath: string,
): Promise<InstalledConsumer> => {
	const root = await makeTemporaryDirectory("shopify-e2e-installed-esm-");
	const dataRoot = await makeTemporaryDirectory(
		"shopify-e2e-installed-role-states-",
	);
	await writeFile(
		join(root, "package.json"),
		'{"name":"installed-esm-consumer","private":true,"type":"module"}\n',
	);
	await installPackedPackage({
		consumerRoot: root,
		hasPlaywright: true,
		tarballPath,
	});
	await mkdir(join(root, "node_modules", "fixture-dependency"));
	await writeFile(
		join(root, "node_modules", "fixture-dependency", "package.json"),
		'{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n',
	);
	await writeFile(
		join(root, "node_modules", "fixture-dependency", "index.js"),
		"export const retryCount = 1;\n",
	);
	await mkdir(join(root, "shopify-tests"));
	await mkdir(join(root, "ordinary-tests"));
	await writeFile(
		join(root, "config-helper.ts"),
		`import type { PlaywrightTestConfig } from "@playwright/test";
import { devices } from "@playwright/test";
import { retryCount } from "fixture-dependency";
export const normalSettings = {
  metadata: { installed: true },
  retries: retryCount,
  use: { ...devices["Desktop Chrome"], screenshot: "off", trace: "off", video: "off" },
} satisfies PlaywrightTestConfig;
`,
	);
	await writeFile(
		join(root, "shopify-e2e.config.ts"),
		`import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";
import { normalSettings } from "./config-helper.ts";
export default defineShopifyE2EConfig({
  ...normalSettings,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  outputDir: "artifacts/output",
  reporter: [["json", { outputFile: "artifacts/results.json" }]],
  roles: ["admin", "customer"],
  testDir: "shopify-tests",
});
`,
	);
	await writeFile(
		join(root, "setup.ts"),
		'import { writeFile } from "node:fs/promises"; export default async () => writeFile("setup.marker", "setup");\n',
	);
	await writeFile(
		join(root, "teardown.ts"),
		'import { writeFile } from "node:fs/promises"; export default async () => writeFile("teardown.marker", "teardown");\n',
	);
	await writeFile(
		join(root, "playwright.config.ts"),
		'import { writeFileSync } from "node:fs"; writeFileSync("ordinary-config.marker", "loaded"); export default { testDir: "ordinary-tests" };\n',
	);
	await writeFile(
		join(root, "ordinary-tests", "ordinary.spec.ts"),
		'import { writeFileSync } from "node:fs"; writeFileSync("ordinary-spec.marker", "loaded");\n',
	);
	await writeFile(
		join(root, "shopify-tests", "roles.spec.ts"),
		`import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
test("admin packed lane", { tag: "@shopify-e2e-role-admin" }, ({}, testInfo) => {
  expect(testInfo.config.metadata.installed).toBe(true);
  const state = testInfo.project.use.storageState;
  expect(typeof state).toBe("object");
  expect(state.cookies[0].value).toBe("admin-state");
  writeFileSync("admin-body.marker", "ran");
});
test("customer packed lane", { tag: "@shopify-e2e-role-customer" }, () => writeFileSync("customer-body.marker", "ran"));
`,
	);
	const consumer = { dataRoot, root };
	await seedRole(consumer, "admin", "admin-state");
	await seedRole(consumer, "customer", "customer-state");
	return consumer;
};

const prepareCjsConsumer = async (
	tarballPath: string,
): Promise<InstalledConsumer> => {
	const root = await makeTemporaryDirectory("shopify-e2e-installed-cjs-");
	const dataRoot = await makeTemporaryDirectory(
		"shopify-e2e-installed-cjs-role-states-",
	);
	await writeFile(
		join(root, "package.json"),
		'{"name":"installed-cjs-consumer","private":true,"type":"commonjs"}\n',
	);
	await installPackedPackage({
		consumerRoot: root,
		hasPlaywright: true,
		tarballPath,
	});
	await mkdir(join(root, "shopify-tests"));
	await writeFile(
		join(root, "config-helper.ts"),
		`import type { PlaywrightTestConfig } from "@playwright/test";
export const settings = { retries: 0 } satisfies PlaywrightTestConfig;
`,
	);
	await writeFile(
		join(root, "shopify-e2e.config.ts"),
		`const { defineShopifyE2EConfig } = require("@sematico/shopify-e2e/config");
const { settings } = require("./config-helper.ts");
export default defineShopifyE2EConfig({ ...settings, roles: ["admin"], testDir: "shopify-tests" });
`,
	);
	await writeFile(
		join(root, "shopify-tests", "admin.spec.ts"),
		'const { test } = require("@playwright/test"); test("cjs admin", { tag: "@shopify-e2e-role-admin" }, () => {});\n',
	);
	const consumer = { dataRoot, root };
	await createRoleStateStore({ dataRoot, origin, roles: ["admin"] }).capture({
		role: "admin",
		state: { cookies: [], origins: [] },
	});
	return consumer;
};

describe.sequential("installed CLI release boundary", () => {
	let esm: InstalledConsumer;
	let cjs: InstalledConsumer;

	beforeAll(async () => {
		const tarballPath = await packVerifiedPackage(projectRoot);
		[esm, cjs] = await Promise.all([
			prepareEsmConsumer(tarballPath),
			prepareCjsConsumer(tarballPath),
		]);
	}, 240_000);

	afterAll(cleanupInstalledCliFixture);

	it("publishes one role-only CLI surface", () => {
		const rootHelp = runCli(esm, ["--help"]);
		const runHelp = runCli(esm, ["run", "--help"]);
		const authHelp = runCli(esm, ["auth", "--help"]);
		const version = runCli(esm, ["--version"]);
		for (const result of [rootHelp, runHelp, authHelp, version]) {
			expect(result.status, result.stderr).toBe(0);
		}
		expect(runHelp.stdout).toContain("--role");
		expect(runHelp.stdout).not.toContain("--profile");
		expect(runHelp.stdout).not.toContain("--config");
		expect(authHelp.stdout).not.toContain("--profile");
		expect(version.stdout).toContain("0.5.0");
	});

	it("runs the packed ESM config natively and ignores the ordinary lane", async () => {
		const result = runCli(esm, ["run", "--role", "admin"]);
		expect(result.status, result.stderr).toBe(0);
		await expect(
			access(join(esm.root, "admin-body.marker")),
		).resolves.toBeUndefined();
		await expect(
			access(join(esm.root, "customer-body.marker")),
		).rejects.toThrow();
		await expect(
			access(join(esm.root, "ordinary-config.marker")),
		).rejects.toThrow();
		await expect(
			access(join(esm.root, "ordinary-spec.marker")),
		).rejects.toThrow();
		await expect(
			access(join(esm.root, "setup.marker")),
		).resolves.toBeUndefined();
		await expect(
			access(join(esm.root, "teardown.marker")),
		).resolves.toBeUndefined();
		const report = JSON.parse(
			await readFile(join(esm.root, "artifacts", "results.json"), "utf8"),
		) as { config: { workers: number } };
		expect(report.config.workers).toBe(1);
	});

	it("loads and runs the packed helper from a CommonJS consumer", () => {
		const helper = spawnSync(
			process.execPath,
			[
				"-e",
				'const c=require("@sematico/shopify-e2e/config"); if(typeof c.defineShopifyE2EConfig!=="function") process.exit(9)',
			],
			{ cwd: cjs.root, encoding: "utf8" },
		);
		expect(helper.status, helper.stderr).toBe(0);
		const result = runCli(cjs, ["run", "--role", "admin"]);
		expect(result.status, result.stderr).toBe(0);
	});

	it("lists and removes exactly one packed role state without loading Playwright", () => {
		const list = runCli(esm, ["auth", "list"]);
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).toContain("admin\tready");
		expect(list.stdout).toContain("customer\tready");
		const removed = runCli(esm, [
			"auth",
			"remove",
			"--role",
			"customer",
			"--yes",
		]);
		expect(removed.status, removed.stderr).toBe(0);
		const after = runCli(esm, ["auth", "list"]);
		expect(after.stdout).toContain("admin\tready");
		expect(after.stdout).toContain("customer\tmissing");
	});

	it("leaves no package-created execution context after packed runs", async () => {
		const entries = await readdir(resolve(process.env.TMPDIR ?? "/tmp"));
		expect(
			entries.some((entry) => entry.startsWith("shopify-e2e-context-")),
		).toBe(false);
	});
});
