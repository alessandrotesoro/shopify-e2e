import { spawnSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlaywrightChildEnvironment } from "../src/config/execution-environment.js";
import { createPlaywrightExecutionContext } from "../src/playwright/execution-context.js";
import { buildPlaywrightInvocation } from "../src/playwright/invocation.js";
import { resolvePlaywrightPeer } from "../src/playwright/peer.js";

const EMPTY_STATE = { cookies: [], origins: [] } as const;
const temporaryDirectories: string[] = [];

const makeProject = async () => {
	const projectRoot = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-invocation-")),
	);
	temporaryDirectories.push(projectRoot);
	const configPath = join(projectRoot, "shopify-e2e.config.ts");
	const testDir = join(projectRoot, "shopify-tests");
	await mkdir(testDir);
	await writeFile(
		join(projectRoot, "package.json"),
		'{"name":"invocation-consumer","private":true,"type":"module"}\n',
	);
	await mkdir(join(projectRoot, "node_modules", "@sematico"), {
		recursive: true,
	});
	await mkdir(join(projectRoot, "node_modules", "@playwright"), {
		recursive: true,
	});
	await symlink(
		process.cwd(),
		join(projectRoot, "node_modules", "@sematico", "shopify-e2e"),
		"dir",
	);
	await symlink(
		resolve(process.cwd(), "node_modules/@playwright/test"),
		join(projectRoot, "node_modules", "@playwright", "test"),
		"dir",
	);
	await writeFile(
		configPath,
		`import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";
export default defineShopifyE2EConfig({
  fullyParallel: true,
  metadata: { lane: "shopify" },
  outputDir: "artifacts/output",
  reporter: [["json", { outputFile: "artifacts/results.json" }]],
  retries: 1,
  roles: ["admin", "customer"],
  testDir: "shopify-tests",
  use: { screenshot: "off", trace: "off", video: "off" }
});
`,
	);
	return { configPath, projectRoot, testDir };
};

const invocationFor = async (
	project: Awaited<ReturnType<typeof makeProject>>,
	options: {
		readonly controls?: {
			readonly grep?: string;
			readonly grepInvert?: string;
		};
		readonly markerDirectory?: string;
		readonly role?: string;
	} = {},
) => {
	const context = await createPlaywrightExecutionContext({
		...project,
		normalizedOrigin: "https://shop.example",
		role: options.role ?? "admin",
		state: EMPTY_STATE,
	});
	const environment = buildPlaywrightChildEnvironment({
		parentEnvironment: {
			...process.env,
			NO_COLOR: "1",
			...(options.markerDirectory === undefined
				? {}
				: { SHOPIFY_E2E_MARKER_DIR: options.markerDirectory }),
			SHOPIFY_STORE_URL: "https://shop.example/path",
		},
		contextPath: context.contextPath,
	});
	const peer = await resolvePlaywrightPeer(process.cwd());
	return {
		context,
		invocation: buildPlaywrightInvocation({
			configPath: project.configPath,
			controls: options.controls,
			environment,
			peer,
		}),
	};
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("owned Playwright invocation", () => {
	it("rejects a relative config path", async () => {
		const peer = await resolvePlaywrightPeer(process.cwd());
		expect(() =>
			buildPlaywrightInvocation({
				configPath: "shopify-e2e.config.ts",
				peer,
			}),
		).toThrow(/absolute/i);
	});

	it("constructs exactly one real config, one worker, filters, and child environment", async () => {
		const project = await makeProject();
		const peer = await resolvePlaywrightPeer(process.cwd());
		const environment = {
			PATH: "/usr/bin",
			SHOPIFY_E2E_EXECUTION_CONTEXT: "/tmp/context.json",
		};

		expect(
			buildPlaywrightInvocation({
				configPath: project.configPath,
				controls: {
					grep: "account with spaces",
					grepInvert: "--project=ordinary",
				},
				environment,
				peer,
			}),
		).toEqual({
			args: [
				peer.executablePath,
				"test",
				"--config",
				project.configPath,
				"--workers=1",
				"--grep",
				"account with spaces",
				"--grep-invert",
				"--project=ordinary",
			],
			environment,
			executable: process.execPath,
		});
	});

	it("passes the pinned native endpoint only through the child environment", async () => {
		const project = await makeProject();
		const peer = await resolvePlaywrightPeer(process.cwd());
		const endpoint = "ws://127.0.0.1:4321/invocation-secret";
		const environment = buildPlaywrightChildEnvironment({
			parentEnvironment: { PATH: "/usr/bin" },
			contextPath: "/tmp/context.json",
			wsEndpoint: endpoint,
		});

		const invocation = buildPlaywrightInvocation({
			configPath: project.configPath,
			environment,
			peer,
		});

		expect(invocation.environment?.PW_TEST_CONNECT_WS_ENDPOINT).toBe(endpoint);
		expect(invocation.args.join(" ")).not.toContain(endpoint);
		expect(invocation.executable).not.toContain(endpoint);
	});

	it.each([
		{ controls: { grep: "" }, label: "empty grep" },
		{ controls: { grepInvert: "   " }, label: "blank grep-invert" },
		{ controls: { workers: "2" }, label: "worker override" },
		{ controls: { config: "playwright.config.ts" }, label: "config override" },
		{ controls: { files: ["ordinary.spec.ts"] }, label: "file selection" },
		{ controls: { passthrough: ["--", "--ui"] }, label: "passthrough" },
	])("rejects $label before argv construction", async ({ controls }) => {
		const project = await makeProject();
		const peer = await resolvePlaywrightPeer(process.cwd());
		expect(() =>
			buildPlaywrightInvocation({
				configPath: project.configPath,
				controls: controls as never,
				peer,
			}),
		).toThrow(/filter|unsupported/i);
	});

	it("ANDs the exact role tag with title filters without loading ordinary config or out-of-root tests", async () => {
		const project = await makeProject();
		const markerDirectory = await realpath(
			await mkdtemp(join(tmpdir(), "shopify-e2e-invocation-markers-")),
		);
		temporaryDirectories.push(markerDirectory);
		const ordinaryConfigMarker = join(
			markerDirectory,
			"ordinary-config.marker",
		);
		const ordinarySpecMarker = join(markerDirectory, "ordinary-spec.marker");
		await writeFile(
			join(project.projectRoot, "playwright.config.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ordinaryConfigMarker)}, "loaded"); export default { testDir: "ordinary" };\n`,
		);
		await mkdir(join(project.projectRoot, "ordinary"));
		await writeFile(
			join(project.projectRoot, "ordinary", "ordinary.spec.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ordinarySpecMarker)}, "loaded");\n`,
		);
		await writeFile(
			join(project.testDir, "roles.spec.ts"),
			`import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
const markers = process.env.SHOPIFY_E2E_MARKER_DIR;
if (!markers) throw new Error("marker directory is required");
const mark = (name: string) => writeFileSync(markers + "/" + name + ".marker", String(process.pid));
test("account active", { tag: "@shopify-e2e-role-admin" }, () => mark("admin-account"));
test("account draft", { tag: "@shopify-e2e-role-admin" }, () => mark("admin-draft"));
test("other admin", { tag: "@shopify-e2e-role-admin" }, () => mark("other-admin"));
test("untagged account", () => mark("untagged-body"));
`,
		);
		await writeFile(
			join(project.testDir, "wrong-role.spec.ts"),
			`import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
const markers = process.env.SHOPIFY_E2E_MARKER_DIR;
if (!markers) throw new Error("marker directory is required");
writeFileSync(markers + "/wrong-role-module.marker", "loaded");
test("account customer", { tag: "@shopify-e2e-role-customer" }, () => {
  writeFileSync(markers + "/customer-body.marker", String(process.pid));
});
`,
		);
		const { context, invocation } = await invocationFor(project, {
			controls: { grep: "account", grepInvert: "draft" },
			markerDirectory,
		});

		try {
			const result = spawnSync(invocation.executable, invocation.args, {
				cwd: project.projectRoot,
				encoding: "utf8",
				env: invocation.environment,
			});
			expect(result.status, result.stderr).toBe(0);
			await expect(
				access(join(markerDirectory, "admin-account.marker")),
			).resolves.toBeUndefined();
			await expect(
				access(join(markerDirectory, "wrong-role-module.marker")),
			).resolves.toBeUndefined();
			for (const marker of [
				"admin-draft.marker",
				"customer-body.marker",
				"other-admin.marker",
				"untagged-body.marker",
				"ordinary-config.marker",
				"ordinary-spec.marker",
			]) {
				await expect(access(join(markerDirectory, marker))).rejects.toThrow();
			}
			await expect(
				access(join(project.projectRoot, "artifacts", "results.json")),
			).resolves.toBeUndefined();
		} finally {
			await context.cleanup();
		}
	});

	it("keeps fullyParallel execution on one global worker", async () => {
		const project = await makeProject();
		const markerDirectory = await realpath(
			await mkdtemp(join(tmpdir(), "shopify-e2e-worker-markers-")),
		);
		temporaryDirectories.push(markerDirectory);
		for (const name of ["first", "second"]) {
			await writeFile(
				join(project.testDir, `${name}.spec.ts`),
				`import { appendFile } from "node:fs/promises";
import { test } from "@playwright/test";
test(${JSON.stringify(name)}, { tag: "@shopify-e2e-role-admin" }, async () => {
  await appendFile(process.env.SHOPIFY_E2E_MARKER_DIR + "/workers.txt", String(process.pid) + "\\n");
});
`,
			);
		}
		const { context, invocation } = await invocationFor(project, {
			markerDirectory,
		});

		try {
			const result = spawnSync(invocation.executable, invocation.args, {
				cwd: project.projectRoot,
				encoding: "utf8",
				env: invocation.environment,
			});
			expect(result.status, result.stderr).toBe(0);
			const pids = (
				await readFile(join(markerDirectory, "workers.txt"), "utf8")
			)
				.trim()
				.split("\n");
			expect(pids).toHaveLength(2);
			expect(new Set(pids).size).toBe(1);
		} finally {
			await context.cleanup();
		}
	});
});
