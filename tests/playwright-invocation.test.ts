import { spawnSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createGeneratedPlaywrightConfig,
	type GeneratedPlaywrightConfig,
} from "../src/playwright/generated-config.js";
import { buildPlaywrightInvocation } from "../src/playwright/invocation.js";
import { resolvePlaywrightPeer } from "../src/playwright/peer.js";
import { EMPTY_STORAGE_STATE } from "../src/profiles/profile-store.js";

const temporaryDirectories: string[] = [];

const runListedTests = (
	invocation: ReturnType<typeof buildPlaywrightInvocation>,
	cwd: string,
) =>
	spawnSync(invocation.executable, [...invocation.args, "--list"], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});

const makeTestRoot = async (): Promise<string> => {
	const project = await mkdtemp(join(tmpdir(), "shopify-e2e-invocation-"));
	temporaryDirectories.push(project);
	const testDir = join(project, "shopify-tests");
	await mkdir(testDir);
	const packageScope = join(project, "node_modules", "@playwright");
	await mkdir(packageScope, { recursive: true });
	await symlink(
		join(process.cwd(), "node_modules", "@playwright", "test"),
		join(packageScope, "test"),
		"dir",
	);
	await writeFile(
		join(testDir, "baseline.spec.ts"),
		'import { test } from "@playwright/test";\ntest("baseline", { tag: "@shopify-e2e-role-guest" }, () => {});\n',
	);
	return testDir;
};

const createGuestConfig = (testDir: string) =>
	createGeneratedPlaywrightConfig({
		selection: {
			kind: "unauthenticated",
			name: "guest",
			role: "guest",
			state: EMPTY_STORAGE_STATE,
		},
		testDir,
	});

const expectCleaned = async (
	config: GeneratedPlaywrightConfig,
): Promise<void> => {
	await config.cleanup();
	await config.cleanup();
	await expect(access(dirname(config.configPath))).rejects.toThrow();
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("generated Playwright configuration", () => {
	it("writes the absolute root, selected role/state, and one-worker settings with user-only permissions", async () => {
		const testDir = await makeTestRoot();
		const config = await createGuestConfig(testDir);

		try {
			const source = await readFile(config.configPath, "utf8");
			expect(source).toContain(`testDir: ${JSON.stringify(testDir)}`);
			expect(source).toContain("workers: 1");
			expect(source).toContain("@shopify-e2e-role-guest");
			expect(source).toContain(
				`storageState: JSON.parse(${JSON.stringify('{"cookies":[],"origins":[]}')})`,
			);
			expect((await stat(dirname(config.configPath))).mode & 0o777).toBe(0o700);
			expect((await stat(config.configPath)).mode & 0o777).toBe(0o600);
		} finally {
			await config.cleanup();
		}
	});

	it("rejects a relative test root", async () => {
		await expect(createGuestConfig("shopify-tests")).rejects.toThrow(
			/absolute/i,
		);
	});

	it("provides idempotent cleanup", async () => {
		const config = await createGuestConfig(await makeTestRoot());

		await expectCleaned(config);
	});

	it("is accepted by the pinned consumer Playwright baseline", async () => {
		const testDir = await makeTestRoot();
		const project = join(testDir, "..");
		const config = await createGuestConfig(testDir);
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			const result = spawnSync(
				process.execPath,
				[
					peer.executablePath,
					"test",
					"--config",
					config.configPath,
					"--workers=1",
					"--list",
				],
				{ cwd: project, encoding: "utf8" },
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("baseline.spec.ts:2:");
		} finally {
			await config.cleanup();
		}
	});
});

describe("owned Playwright invocation", () => {
	it("constructs only the consumer peer, test command, generated config, and one worker", async () => {
		const generatedConfig = await createGuestConfig(await makeTestRoot());
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			expect(buildPlaywrightInvocation({ generatedConfig, peer })).toEqual({
				args: [
					peer.executablePath,
					"test",
					"--config",
					generatedConfig.configPath,
					"--workers=1",
				],
				executable: process.execPath,
			});
		} finally {
			await generatedConfig.cleanup();
		}
	});

	it("keeps filter names and values in separate owned argv entries", async () => {
		const generatedConfig = await createGuestConfig(await makeTestRoot());
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			const invocation = buildPlaywrightInvocation({
				controls: {
					grep: "checkout with spaces",
					grepInvert: "--project=ordinary",
				},
				generatedConfig,
				peer,
			});

			expect(invocation.args.slice(-4)).toEqual([
				"--grep",
				"checkout with spaces",
				"--grep-invert",
				"--project=ordinary",
			]);
		} finally {
			await generatedConfig.cleanup();
		}
	});

	it("keeps a leading-dash filter value from becoming a Playwright option", async () => {
		const testDir = await makeTestRoot();
		const generatedConfig = await createGuestConfig(testDir);
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			const invocation = buildPlaywrightInvocation({
				controls: { grepInvert: "--project=ordinary" },
				generatedConfig,
				peer,
			});
			const result = spawnSync(
				invocation.executable,
				[...invocation.args, "--list"],
				{
					cwd: dirname(testDir),
					encoding: "utf8",
					env: { ...process.env, NO_COLOR: "1" },
				},
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("baseline.spec.ts:2:");
			expect(result.stderr).not.toMatch(/project.*ordinary/i);
		} finally {
			await generatedConfig.cleanup();
		}
	});

	it.each([
		{
			controls: undefined,
			excluded: ["admin-extra role", "customer role", "untagged role"],
			included: ["admin role", "multi role"],
			label: "mandatory role lane",
		},
		{
			controls: { grep: "multi role" },
			excluded: ["admin role", "admin-extra role", "customer role"],
			included: ["multi role"],
			label: "additive grep",
		},
		{
			controls: { grepInvert: "multi role" },
			excluded: ["multi role", "admin-extra role", "customer role"],
			included: ["admin role"],
			label: "additive grep-invert",
		},
	])("ANDs $label with the exact admin token", async ({
		controls,
		excluded,
		included,
	}) => {
		const project = await mkdtemp(join(tmpdir(), "shopify-e2e-role-and-"));
		temporaryDirectories.push(project);
		const testDir = join(project, "shopify-tests");
		await mkdir(testDir);
		await writeFile(
			join(testDir, "roles.spec.ts"),
			`import { test } from ${JSON.stringify(join(process.cwd(), "node_modules", "@playwright", "test", "index.js"))};
test("admin role", { tag: "@shopify-e2e-role-admin" }, () => {});
test("admin-extra role", { tag: "@shopify-e2e-role-admin-extra" }, () => {});
test("customer role", { tag: "@shopify-e2e-role-customer" }, () => {});
test("multi role", { tag: ["@shopify-e2e-role-admin", "@shopify-e2e-role-customer"] }, () => {});
test("untagged role", () => {});
`,
		);
		const generatedConfig = await createGeneratedPlaywrightConfig({
			selection: {
				kind: "saved",
				name: "admin-primary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			},
			testDir,
		});
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			const result = runListedTests(
				buildPlaywrightInvocation({ controls, generatedConfig, peer }),
				project,
			);
			expect(result.status, result.stderr).toBe(0);
			for (const title of included) expect(result.stdout).toContain(title);
			for (const title of excluded) expect(result.stdout).not.toContain(title);
		} finally {
			await generatedConfig.cleanup();
		}
	});

	it("executes only admin and multi-role bodies while preserving discovery boundaries", async () => {
		const consumer = join(process.cwd(), "tests", "fixtures", "consumer");
		const testDir = join(consumer, "shopify-passing");
		const markerDirectory = await mkdtemp(
			join(tmpdir(), "shopify-e2e-role-markers-"),
		);
		temporaryDirectories.push(markerDirectory);
		const generatedConfig = await createGeneratedPlaywrightConfig({
			selection: {
				kind: "saved",
				name: "admin-primary",
				role: "admin",
				state: EMPTY_STORAGE_STATE,
			},
			testDir,
		});
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			const invocation = buildPlaywrightInvocation({ generatedConfig, peer });
			const result = spawnSync(invocation.executable, invocation.args, {
				cwd: consumer,
				encoding: "utf8",
				env: {
					...process.env,
					NO_COLOR: "1",
					SHOPIFY_E2E_MARKER_DIR: markerDirectory,
				},
			});
			expect(result.status, result.stderr).toBe(0);
			await expect(
				access(join(markerDirectory, "admin-role.marker")),
			).resolves.toBeUndefined();
			await expect(
				access(join(markerDirectory, "multi-role.marker")),
			).resolves.toBeUndefined();
			await expect(
				access(join(markerDirectory, "wrong-role-module-loaded.marker")),
			).resolves.toBeUndefined();
			for (const marker of [
				"customer-role.marker",
				"guest-role.marker",
				"untagged-role.marker",
				"wrong-role-body.marker",
				"ordinary-spec-loaded.marker",
			]) {
				await expect(access(join(markerDirectory, marker))).rejects.toThrow();
			}
		} finally {
			await generatedConfig.cleanup();
		}
	});

	it.each([
		{ controls: { grep: "" }, label: "empty grep" },
		{ controls: { grepInvert: "   " }, label: "blank grep-invert" },
		{ controls: { workers: "2" }, label: "worker override" },
		{ controls: { config: "playwright.config.ts" }, label: "config override" },
		{ controls: { files: ["ordinary.spec.ts"] }, label: "file selection" },
		{ controls: { passthrough: ["--", "--ui"] }, label: "passthrough" },
		{ controls: { reporter: "html" }, label: "deferred option" },
	])("rejects $label before argv construction", async ({ controls }) => {
		const generatedConfig = await createGuestConfig(await makeTestRoot());
		const peer = await resolvePlaywrightPeer(process.cwd());

		try {
			expect(() =>
				buildPlaywrightInvocation({
					controls: controls as never,
					generatedConfig,
					peer,
				}),
			).toThrow(/filter|unsupported/i);
		} finally {
			await generatedConfig.cleanup();
		}
	});
});
