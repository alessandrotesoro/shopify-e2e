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

const temporaryDirectories: string[] = [];

async function makeTestRoot(): Promise<string> {
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
		'import { test } from "@playwright/test";\ntest("baseline", () => {});\n',
	);
	return testDir;
}

async function expectCleaned(config: GeneratedPlaywrightConfig): Promise<void> {
	await config.cleanup();
	await config.cleanup();
	await expect(access(dirname(config.configPath))).rejects.toThrow();
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("generated Playwright configuration", () => {
	it("writes only an absolute test root and one-worker settings with user-only permissions", async () => {
		const testDir = await makeTestRoot();
		const config = await createGeneratedPlaywrightConfig(testDir);

		try {
			expect(await readFile(config.configPath, "utf8")).toBe(
				`export default { testDir: ${JSON.stringify(testDir)}, workers: 1 };\n`,
			);
			expect((await stat(dirname(config.configPath))).mode & 0o777).toBe(0o700);
			expect((await stat(config.configPath)).mode & 0o777).toBe(0o600);
		} finally {
			await config.cleanup();
		}
	});

	it("rejects a relative test root", async () => {
		await expect(
			createGeneratedPlaywrightConfig("shopify-tests"),
		).rejects.toThrow(/absolute/i);
	});

	it.each([
		"success",
		"numeric failure",
		"spawn failure",
		"signal completion",
	])("provides idempotent cleanup after %s", async () => {
		const config = await createGeneratedPlaywrightConfig(await makeTestRoot());

		await expectCleaned(config);
	});

	it("is accepted by the pinned consumer Playwright baseline", async () => {
		const testDir = await makeTestRoot();
		const project = join(testDir, "..");
		const config = await createGeneratedPlaywrightConfig(testDir);
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
		const generatedConfig = await createGeneratedPlaywrightConfig(
			await makeTestRoot(),
		);
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
		const generatedConfig = await createGeneratedPlaywrightConfig(
			await makeTestRoot(),
		);
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
		const generatedConfig = await createGeneratedPlaywrightConfig(testDir);
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
		{ controls: { grep: "" }, label: "empty grep" },
		{ controls: { grepInvert: "   " }, label: "blank grep-invert" },
		{ controls: { workers: "2" }, label: "worker override" },
		{ controls: { config: "playwright.config.ts" }, label: "config override" },
		{ controls: { files: ["ordinary.spec.ts"] }, label: "file selection" },
		{ controls: { passthrough: ["--", "--ui"] }, label: "passthrough" },
		{ controls: { reporter: "html" }, label: "deferred option" },
	])("rejects $label before argv construction", async ({ controls }) => {
		const generatedConfig = await createGeneratedPlaywrightConfig(
			await makeTestRoot(),
		);
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
