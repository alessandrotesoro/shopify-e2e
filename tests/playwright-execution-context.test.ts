import { spawnSync } from "node:child_process";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlaywrightChildEnvironment } from "../src/config/execution-environment.js";
import {
	createPlaywrightExecutionContext,
	readPlaywrightExecutionContext,
} from "../src/playwright/execution-context.js";
import { buildPlaywrightInvocation } from "../src/playwright/invocation.js";
import { resolvePlaywrightPeer } from "../src/playwright/peer.js";

const EMPTY_STATE = { cookies: [], origins: [] } as const;
const temporaryDirectories: string[] = [];

const makeProject = async () => {
	const projectRoot = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-context-project-")),
	);
	temporaryDirectories.push(projectRoot);
	const configPath = join(projectRoot, "shopify-e2e.config.ts");
	const testDir = join(projectRoot, "shopify-tests");
	await mkdir(testDir);
	await writeFile(configPath, "export default {};\n");
	return { configPath, projectRoot, testDir };
};

const createContext = async () => {
	const project = await makeProject();
	const artifact = await createPlaywrightExecutionContext({
		...project,
		normalizedOrigin: "https://shop.example",
		role: "admin",
		state: EMPTY_STATE,
	});
	return { artifact, project };
};

const readContext = (
	contextPath: string,
	options: {
		readonly argv?: readonly string[];
		readonly origin?: string;
	} = {},
) =>
	readPlaywrightExecutionContext({
		argv: options.argv ?? [process.execPath, "/playwright/worker.js"],
		environment: {
			SHOPIFY_E2E_EXECUTION_CONTEXT: contextPath,
			SHOPIFY_STORE_URL: options.origin ?? "https://shop.example/path",
		},
	});

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("Playwright execution context", () => {
	it("builds a pointer-only child environment without mutating or leaking a reserved parent value", () => {
		const parent = {
			PATH: "/usr/bin",
			SHOPIFY_E2E_EXECUTION_CONTEXT: "parent-secret-value",
		};
		const child = buildPlaywrightChildEnvironment(parent, "/tmp/fresh.json");

		expect(child).toEqual({
			PATH: "/usr/bin",
			SHOPIFY_E2E_EXECUTION_CONTEXT: "/tmp/fresh.json",
		});
		expect(parent.SHOPIFY_E2E_EXECUTION_CONTEXT).toBe("parent-secret-value");
		expect(JSON.stringify(child)).not.toContain("parent-secret-value");
		expect(() =>
			buildPlaywrightChildEnvironment(parent, "relative-context.json"),
		).toThrow(/absolute/i);
	});

	it("injects only the active native endpoint and rejects inherited connection controls", () => {
		const endpoint = "ws://127.0.0.1:4321/active-secret";
		const parent = { PATH: "/usr/bin" };
		const child = buildPlaywrightChildEnvironment(
			parent,
			"/tmp/fresh.json",
			endpoint,
		);

		expect(child).toEqual({
			PATH: "/usr/bin",
			PW_TEST_CONNECT_WS_ENDPOINT: endpoint,
			SHOPIFY_E2E_EXECUTION_CONTEXT: "/tmp/fresh.json",
		});
		expect(parent).toEqual({ PATH: "/usr/bin" });

		for (const key of [
			"PW_TEST_CONNECT_WS_ENDPOINT",
			"PW_TEST_CONNECT_HEADERS",
			"PW_TEST_CONNECT_EXPOSE_NETWORK",
		]) {
			const inherited = "inherited-secret";
			let error: unknown;
			try {
				buildPlaywrightChildEnvironment(
					{ [key]: inherited },
					"/tmp/fresh.json",
					endpoint,
				);
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(new RegExp(key));
			expect((error as Error).message).not.toContain(inherited);
		}
	});

	it("keeps the native endpoint out of the immutable execution artifact", async () => {
		const { artifact } = await createContext();
		temporaryDirectories.push(dirname(artifact.contextPath));
		const endpoint = "ws://127.0.0.1:4321/artifact-secret";

		buildPlaywrightChildEnvironment({}, artifact.contextPath, endpoint);

		expect(await readFile(artifact.contextPath, "utf8")).not.toContain(
			endpoint,
		);
	});
	it("writes owner-only non-executable JSON outside project and package roots", async () => {
		const { artifact, project } = await createContext();
		temporaryDirectories.push(dirname(artifact.contextPath));

		const payload = JSON.parse(await readFile(artifact.contextPath, "utf8"));
		expect(payload).toMatchObject({
			configPath: project.configPath,
			normalizedOrigin: "https://shop.example",
			projectRoot: project.projectRoot,
			role: "admin",
			state: EMPTY_STATE,
			testDir: project.testDir,
		});
		expect((await stat(dirname(artifact.contextPath))).mode & 0o777).toBe(
			0o700,
		);
		expect((await stat(artifact.contextPath)).mode & 0o777).toBe(0o600);
		expect(artifact.contextPath.startsWith(project.projectRoot)).toBe(false);

		const selected = readContext(artifact.contextPath);
		expect(selected).toMatchObject({
			configPath: project.configPath,
			normalizedOrigin: "https://shop.example",
			projectRoot: project.projectRoot,
			role: "admin",
			state: EMPTY_STATE,
			testDir: project.testDir,
		});
		expect(Object.isFrozen(selected)).toBe(true);
		expect(Object.isFrozen(selected.state)).toBe(true);
	});

	it("validates the exact canonical config argument only when the invocation exposes one", async () => {
		const { artifact, project } = await createContext();
		temporaryDirectories.push(dirname(artifact.contextPath));
		const canonical = [
			process.execPath,
			"/playwright/cli.js",
			"test",
			"--config",
			project.configPath,
			"--workers=1",
		];

		expect(() =>
			readContext(artifact.contextPath, { argv: canonical }),
		).not.toThrow();
		expect(() =>
			readContext(artifact.contextPath, {
				argv: [...canonical, "--grep", "--config=title text"],
			}),
		).not.toThrow();
		for (const argv of [
			canonical.slice(0, 3),
			[...canonical, "--config", project.configPath],
			[...canonical.slice(0, 4), join(project.projectRoot, "other.ts")],
			[...canonical.slice(0, 3), `--config=${project.configPath}`],
			[...canonical, "--project", "ordinary"],
		]) {
			expect(() => readContext(artifact.contextPath, { argv })).toThrow(
				/config argument/i,
			);
		}

		expect(() =>
			readContext(artifact.contextPath, {
				argv: [process.execPath, "/playwright/loader.js"],
			}),
		).not.toThrow();
	});

	it("rejects wrong origin and changed project/config/test identities", async () => {
		const cases = ["project", "config", "testDir"] as const;
		for (const changed of cases) {
			const { artifact, project } = await createContext();
			temporaryDirectories.push(dirname(artifact.contextPath));
			if (changed === "project") {
				await writeFile(
					join(project.projectRoot, "identity-change"),
					"changed",
				);
				// Directory mtimes are not the identity; replacing the root is tested by moving it.
				const moved = `${project.projectRoot}-old`;
				await import("node:fs/promises").then(({ rename }) =>
					rename(project.projectRoot, moved),
				);
				temporaryDirectories.push(moved);
				await mkdir(project.projectRoot);
			} else if (changed === "config") {
				await rm(project.configPath);
				await writeFile(
					project.configPath,
					"export default { changed: true };\n",
				);
			} else {
				await rm(project.testDir, { recursive: true });
				await mkdir(project.testDir);
			}
			expect(() => readContext(artifact.contextPath)).toThrow(
				/identity|physical/i,
			);
		}

		const { artifact } = await createContext();
		temporaryDirectories.push(dirname(artifact.contextPath));
		expect(() =>
			readContext(artifact.contextPath, { origin: "https://other.example" }),
		).toThrow(/origin/i);
	});

	it("rejects unsafe pointer, file, and parent boundaries", async () => {
		const { artifact, project } = await createContext();
		temporaryDirectories.push(dirname(artifact.contextPath));
		await chmod(artifact.contextPath, 0o640);
		expect(() => readContext(artifact.contextPath)).toThrow(/permission/i);
		await chmod(artifact.contextPath, 0o600);

		const linkedParent = await realpath(
			await mkdtemp(join(tmpdir(), "shopify-e2e-context-")),
		);
		temporaryDirectories.push(linkedParent);
		await chmod(linkedParent, 0o700);
		const link = join(linkedParent, "execution-context.json");
		await symlink(artifact.contextPath, link);
		expect(() => readContext(link)).toThrow(/symbolic link|regular file/i);

		await chmod(dirname(artifact.contextPath), 0o750);
		expect(() => readContext(artifact.contextPath)).toThrow(/permission/i);
		await chmod(dirname(artifact.contextPath), 0o700);

		const inProject = join(project.projectRoot, "execution-context.json");
		await writeFile(inProject, await readFile(artifact.contextPath), {
			mode: 0o600,
		});
		expect(() => readContext(inProject)).toThrow(/outside the project root/i);
	});

	it("rejects malformed, oversized, and path-swapped context files", async () => {
		const { artifact } = await createContext();
		temporaryDirectories.push(dirname(artifact.contextPath));
		await writeFile(artifact.contextPath, "not-json");
		expect(() => readContext(artifact.contextPath)).toThrow(/invalid/i);

		await writeFile(artifact.contextPath, "x".repeat(65 * 1024 * 1024));
		expect(() => readContext(artifact.contextPath)).toThrow(/64 MiB|size/i);

		await rm(artifact.contextPath);
		await mkdir(artifact.contextPath);
		expect(() => readContext(artifact.contextPath)).toThrow(/regular file/i);
	});

	it("cleans up idempotently only after the owner invokes cleanup", async () => {
		const { artifact } = await createContext();
		const parent = dirname(artifact.contextPath);
		temporaryDirectories.push(parent);

		readContext(artifact.contextPath);
		await expect(access(artifact.contextPath)).resolves.toBeUndefined();
		await artifact.cleanup();
		await artifact.cleanup();
		await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
		let readError: unknown;
		try {
			readContext(artifact.contextPath);
		} catch (error) {
			readError = error;
		}
		expect(readError).toBeInstanceOf(TypeError);
		expect((readError as Error).message).toMatch(/validation.*safely/i);
		expect((readError as Error).message).not.toContain(artifact.contextPath);
	});

	it("keeps the pointer through pinned Playwright evaluations for an ESM consumer", async () => {
		const moduleType = "module";
		const projectRoot = await realpath(
			await mkdtemp(join(tmpdir(), `shopify-e2e-${moduleType}-consumer-`)),
		);
		temporaryDirectories.push(projectRoot);
		const configPath = join(projectRoot, "shopify-e2e.config.ts");
		const testDir = join(projectRoot, "shopify-tests");
		const evaluationLog = join(projectRoot, "config-evaluations.jsonl");
		const workerMarker = join(projectRoot, "worker.marker");
		await mkdir(testDir);
		await writeFile(
			join(projectRoot, "package.json"),
			JSON.stringify({ type: moduleType }),
		);
		await writeFile(
			join(projectRoot, "config-support.ts"),
			'export const configuredTestDir = "wrong-tests";\n',
		);
		const modules = join(projectRoot, "node_modules");
		await mkdir(join(modules, "@sematico"), { recursive: true });
		await mkdir(join(modules, "@playwright"), { recursive: true });
		await mkdir(join(modules, "fixture-dependency"), { recursive: true });
		await symlink(
			process.cwd(),
			join(modules, "@sematico", "shopify-e2e"),
			"dir",
		);
		await symlink(
			join(process.cwd(), "node_modules", "@playwright", "test"),
			join(modules, "@playwright", "test"),
			"dir",
		);
		await writeFile(
			join(modules, "fixture-dependency", "index.js"),
			'module.exports = { markerLabel: "consumer-dependency" };\n',
		);
		const sharedBody = `
appendFileSync(${JSON.stringify(evaluationLog)}, JSON.stringify({ argv: process.argv.slice(1), hasPointer: typeof process.env.SHOPIFY_E2E_EXECUTION_CONTEXT === "string", pid: process.pid }) + "\\n");
const passthrough = { metadata: { markerLabel }, reporter: [["json", { outputFile: "results.json" }]], use: { ...devices["Desktop Chrome"], trace: "off" } };
`;
		const configSource = `import type { PlaywrightTestConfig } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { devices } from "@playwright/test";
import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";
import fixtureDependency from "fixture-dependency";
import { configuredTestDir } from "./config-support";
const { markerLabel } = fixtureDependency;
${sharedBody}
const typed: Pick<PlaywrightTestConfig, "metadata"> = { metadata: passthrough.metadata };
export default defineShopifyE2EConfig({ ...passthrough, ...typed, roles: ["admin"], testDir: configuredTestDir });
`;
		await writeFile(configPath, configSource);
		await writeFile(
			join(testDir, "runtime.spec.ts"),
			`import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
test("runtime overlay", { tag: "@shopify-e2e-role-admin" }, () => writeFileSync(${JSON.stringify(workerMarker)}, "ran"));
`,
		);
		const context = await createPlaywrightExecutionContext({
			configPath,
			normalizedOrigin: "https://shop.example",
			projectRoot,
			role: "admin",
			state: EMPTY_STATE,
			testDir,
		});
		const inherited = {
			...process.env,
			SHOPIFY_E2E_EXECUTION_CONTEXT: "stale-parent-value",
			SHOPIFY_STORE_URL: "https://shop.example/path",
		};
		const environment = buildPlaywrightChildEnvironment(
			inherited,
			context.contextPath,
		);
		const peer = await resolvePlaywrightPeer(process.cwd());
		const invocation = buildPlaywrightInvocation({
			configPath,
			environment,
			peer,
		});

		try {
			const result = spawnSync(invocation.executable, invocation.args, {
				cwd: projectRoot,
				encoding: "utf8",
				env: invocation.environment,
			});
			expect(result.status, result.stderr).toBe(0);
			await expect(access(workerMarker)).resolves.toBeUndefined();
			await expect(
				access(join(projectRoot, "results.json")),
			).resolves.toBeUndefined();
			await expect(access(context.contextPath)).resolves.toBeUndefined();
			const evaluations = (await readFile(evaluationLog, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { readonly hasPointer: boolean });
			expect(evaluations.length).toBeGreaterThanOrEqual(2);
			expect(evaluations.every(({ hasPointer }) => hasPointer)).toBe(true);
			expect(inherited.SHOPIFY_E2E_EXECUTION_CONTEXT).toBe(
				"stale-parent-value",
			);
		} finally {
			await context.cleanup();
		}
		await expect(access(context.contextPath)).rejects.toThrow();
	}, 20_000);
});
