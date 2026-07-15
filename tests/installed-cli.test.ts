import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanupInstalledCliFixture,
	expectMarkersAbsent,
	expectOrdinaryLaneFixturesPresent,
	generatedConfigDirectories,
	type InstalledRemovalFixture,
	makeTemporaryDirectory,
	markerExists,
	prepareInstalledCliFixture,
	terminateAndAwaitProcesses,
	waitForMarker,
	waitForProcessToExit,
} from "./support/installed-cli-harness.js";
import { installedCliPath } from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/consumer");
let installedProfileDataRoot = "";
let installedRemovalFixture: InstalledRemovalFixture;
const dotenvOutputPattern =
	/injected env|failed to load|no encoding is specified/i;

interface CommandResult {
	readonly error?: Error;
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

const digestFiles = async (
	files: readonly string[],
): Promise<readonly string[]> =>
	Promise.all(
		files.map(async (file) =>
			createHash("sha256")
				.update(await readFile(file))
				.digest("hex"),
		),
	);

const profileFiles = (directory: string): readonly string[] => [
	join(directory, "profile.json"),
	join(directory, "storage-state.json"),
];

interface RunCommandArgs {
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
}

const runCommand = ({
	args,
	command,
	cwd,
	env,
	timeoutMs,
}: RunCommandArgs): CommandResult => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: env ?? process.env,
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout: timeoutMs ?? 30_000,
	});
	return {
		...(result.error === undefined ? {} : { error: result.error }),
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	};
};

interface ExpectSuccessArgs {
	readonly label: string;
	readonly result: CommandResult;
}

const expectSuccess = ({ label, result }: ExpectSuccessArgs): void => {
	expect(
		result.status,
		`${label} failed\nerror: ${result.error?.message ?? "none"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	).toBe(0);
};

interface RunInstalledCliArgs {
	readonly args: readonly string[];
	readonly consumerRoot: string;
	readonly environmentOverrides?: NodeJS.ProcessEnv;
	readonly markerDirectory?: string;
}

const createInstalledCliEnvironment = (
	environmentOverrides: NodeJS.ProcessEnv,
	markerDirectory?: string,
): NodeJS.ProcessEnv => ({
	...process.env,
	SHOPIFY_E2E_DATA_DIR: installedProfileDataRoot,
	SHOPIFY_STORE_URL: "https://shop.example",
	...environmentOverrides,
	NO_COLOR: "1",
	...(markerDirectory === undefined
		? {}
		: { SHOPIFY_E2E_MARKER_DIR: markerDirectory }),
});

const runInstalledCli = ({
	args,
	consumerRoot,
	environmentOverrides = {},
	markerDirectory,
}: RunInstalledCliArgs): CommandResult => {
	return runCommand({
		args,
		command: installedCliPath(consumerRoot),
		cwd: consumerRoot,
		env: createInstalledCliEnvironment(environmentOverrides, markerDirectory),
	});
};

const simulatedTtyBootstrap = `import { pathToFileURL } from "node:url";
const [cliPath, ...cliArgs] = process.argv.slice(1);
Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdout, "getWindowSize", { configurable: true, value: () => [80, 24] });
process.argv = [process.execPath, cliPath, ...cliArgs];
await import(pathToFileURL(cliPath).href);
`;

const runInstalledCliWithSimulatedTty = ({
	args,
	consumerRoot,
	environmentOverrides = {},
	markerDirectory,
}: RunInstalledCliArgs): CommandResult => {
	return runCommand({
		args: [
			"--input-type=module",
			"--eval",
			simulatedTtyBootstrap,
			join(
				consumerRoot,
				"node_modules",
				"@sematico",
				"shopify-e2e",
				"bin",
				"run.js",
			),
			...args,
		],
		command: process.execPath,
		cwd: consumerRoot,
		env: createInstalledCliEnvironment(environmentOverrides, markerDirectory),
	});
};

describe.sequential("installed CLI release boundary", () => {
	let consumerRoot = "";
	let missingPeerConsumerRoot = "";

	beforeAll(async () => {
		const fixture = await prepareInstalledCliFixture({
			fixtureRoot,
			projectRoot,
		});
		consumerRoot = fixture.consumerRoot;
		missingPeerConsumerRoot = fixture.missingPeerConsumerRoot;
		installedProfileDataRoot = fixture.profileDataRoot;
		installedRemovalFixture = fixture.removal;
	}, 240_000);

	afterAll(cleanupInstalledCliFixture);

	it("provides auth/run help, bundled prompts, version, and explicit command discovery", async () => {
		const installedPackageRoot = await realpath(
			join(consumerRoot, "node_modules", "@sematico", "shopify-e2e"),
		);
		expect(installedPackageRoot).not.toBe(projectRoot);
		expect(installedPackageRoot.startsWith(`${projectRoot}/`)).toBe(false);

		const bundledPrompts = runCommand({
			args: [
				"--input-type=module",
				"--eval",
				'const prompts = await import("@inquirer/prompts"); if (typeof prompts.select !== "function") process.exit(1);',
			],
			command: process.execPath,
			cwd: consumerRoot,
		});
		expectSuccess({
			label: "installed bundled Inquirer import",
			result: bundledPrompts,
		});

		const deepImport = runCommand({
			args: [
				"--input-type=module",
				"--eval",
				'await import("@sematico/shopify-e2e/dist/errors.js");',
			],
			command: process.execPath,
			cwd: consumerRoot,
		});
		expect(deepImport.status).not.toBe(0);
		expect(deepImport.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");

		const rootHelp = runInstalledCli({ args: ["--help"], consumerRoot });
		expectSuccess({ label: "installed root help", result: rootHelp });
		expect(rootHelp.stdout).toContain("COMMANDS");
		expect(rootHelp.stdout).toMatch(/\brun\b/);
		expect(rootHelp.stdout).toMatch(/\bauth\b/);
		expect(rootHelp.stdout).toContain("auth remove");
		expect(rootHelp.stdout).toMatch(/\bdoctor\b/);
		expect(rootHelp.stdout).not.toMatch(/\bsetup\b|\btest\b/);

		const doctorHelp = runInstalledCli({
			args: ["doctor", "--help"],
			consumerRoot,
		});
		expectSuccess({ label: "installed doctor help", result: doctorHelp });
		expect(doctorHelp.stdout).toContain("shopify-e2e doctor");
		expect(doctorHelp.stdout).toContain("--config");
		expect(doctorHelp.stdout).not.toMatch(
			/--(?:debug|grep|grep-invert|profile|quiet|verbose|workers)\b/,
		);

		const runHelp = runInstalledCli({ args: ["run", "--help"], consumerRoot });
		expectSuccess({ label: "installed run help", result: runHelp });
		expect(runHelp.stdout).toContain("shopify-e2e run");
		expect(runHelp.stdout).toContain("--config");
		expect(runHelp.stdout).toContain("--grep");
		expect(runHelp.stdout).toContain("--grep-invert");
		expect(runHelp.stdout).toContain("--profile");

		for (const args of [
			["auth", "--help"],
			["auth", "capture", "--help"],
			["auth", "refresh", "--help"],
			["auth", "list", "--help"],
			["auth", "remove", "--help"],
		]) {
			const authHelp = runInstalledCli({ args, consumerRoot });
			expectSuccess({
				label: `installed ${args.join(" ")} help`,
				result: authHelp,
			});
		}

		const version = runInstalledCli({ args: ["--version"], consumerRoot });
		expectSuccess({ label: "installed version", result: version });
		expect(version.stdout).toMatch(/@sematico\/shopify-e2e\/0\.4\.0/);
	});

	it("refuses unsafe packed removal without Playwright or registry mutation", async () => {
		const pathsThatMustRemain = [
			installedRemovalFixture.currentOriginDirectory,
			installedRemovalFixture.currentProfileDirectory,
			...installedRemovalFixture.currentSiblingProfileDirectories,
			installedRemovalFixture.otherOriginDirectory,
			installedRemovalFixture.otherOriginProfileDirectory,
		];
		const registryFiles = [
			join(installedRemovalFixture.currentOriginDirectory, "origin.json"),
			...profileFiles(installedRemovalFixture.currentProfileDirectory),
			...installedRemovalFixture.currentSiblingProfileDirectories.flatMap(
				profileFiles,
			),
			join(installedRemovalFixture.otherOriginDirectory, "origin.json"),
			...profileFiles(installedRemovalFixture.otherOriginProfileDirectory),
		];
		const registryBefore = await digestFiles(registryFiles);
		for (const args of [
			["auth", "remove", "--profile", "guest", "--yes"],
			["auth", "remove", "--profile", "unknown-profile", "--yes"],
			["auth", "remove", "--profile", installedRemovalFixture.profileName],
		] as const) {
			const result = runInstalledCli({
				args,
				consumerRoot: missingPeerConsumerRoot,
			});
			expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(2);
			expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/playwright/i);
			for (const path of pathsThatMustRemain) {
				await expect(access(path), path).resolves.toBeUndefined();
			}
			await expect(digestFiles(registryFiles)).resolves.toEqual(registryBefore);
		}
	});

	it("lists and removes only the disposable current-origin profile from the packed no-peer consumer", async () => {
		await expect(
			access(
				join(missingPeerConsumerRoot, "node_modules", "@playwright", "test"),
			),
		).rejects.toMatchObject({ code: "ENOENT" });

		const before = runInstalledCli({
			args: ["auth", "list"],
			consumerRoot: missingPeerConsumerRoot,
		});
		expectSuccess({
			label: "installed auth list before removal",
			result: before,
		});
		expect(before.stdout).toMatch(
			new RegExp(
				`${installedRemovalFixture.profileName}\\s+customer\\s+runnable`,
			),
		);
		const preservedRegistryFiles = [
			join(installedRemovalFixture.currentOriginDirectory, "origin.json"),
			...installedRemovalFixture.currentSiblingProfileDirectories.flatMap(
				profileFiles,
			),
			join(installedRemovalFixture.otherOriginDirectory, "origin.json"),
			...profileFiles(installedRemovalFixture.otherOriginProfileDirectory),
		];
		const preservedRegistryBefore = await digestFiles(preservedRegistryFiles);

		const remove = runInstalledCli({
			args: [
				"auth",
				"remove",
				"--profile",
				installedRemovalFixture.profileName,
				"--yes",
			],
			consumerRoot: missingPeerConsumerRoot,
		});
		expectSuccess({
			label: "installed auth remove without peer",
			result: remove,
		});
		expect(remove.stdout).toContain(
			`Removed saved profile ${installedRemovalFixture.profileName}.`,
		);
		expect(`${remove.stdout}\n${remove.stderr}`).not.toMatch(
			/which profile|remove .*\?|playwright/i,
		);

		const after = runInstalledCli({
			args: ["auth", "list"],
			consumerRoot: missingPeerConsumerRoot,
		});
		expectSuccess({
			label: "installed auth list after removal",
			result: after,
		});
		expect(after.stdout).not.toContain(installedRemovalFixture.profileName);
		expect(after.stdout).toMatch(/admin-primary\s+admin\s+runnable/i);
		expect(after.stdout).toMatch(/customer-primary\s+customer\s+runnable/i);

		await expect(
			access(installedRemovalFixture.currentProfileDirectory),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			access(installedRemovalFixture.currentOriginDirectory),
		).resolves.toBeUndefined();
		for (const path of installedRemovalFixture.currentSiblingProfileDirectories) {
			await expect(access(path), path).resolves.toBeUndefined();
		}
		await expect(
			access(installedRemovalFixture.otherOriginDirectory),
		).resolves.toBeUndefined();
		await expect(
			access(installedRemovalFixture.otherOriginProfileDirectory),
		).resolves.toBeUndefined();
		await expect(digestFiles(preservedRegistryFiles)).resolves.toEqual(
			preservedRegistryBefore,
		);
		const currentProfileEntries = await readdir(
			join(installedRemovalFixture.currentOriginDirectory, "profiles"),
		);
		expect(currentProfileEntries).not.toContain(
			installedRemovalFixture.profileName,
		);
		expect(currentProfileEntries).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/^\.tmp-remove-/)]),
		);
	});

	it.each([
		"admin-primary",
		"customer-primary",
	])("embeds only the selected %s state object in the generated config", async (profile) => {
		const markers = await makeTemporaryDirectory("shopify-e2e-saved-state-");
		const result = runInstalledCli({
			args: [
				"run",
				"--profile",
				profile,
				"--grep",
				"generated saved state is embedded by value",
			],
			consumerRoot,
			environmentOverrides: {
				SHOPIFY_E2E_PROFILE_DATA_ROOT_EXPECTED: installedProfileDataRoot,
				SHOPIFY_E2E_STATE_EXPECTED: profile,
			},
			markerDirectory: markers,
		});

		expectSuccess({ label: `installed ${profile} state run`, result });
		expect(result.stdout).toMatch(/1 passed/i);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain(
			installedProfileDataRoot,
		);
		await expect(
			markerExists({
				markerDirectory: markers,
				name: `saved-state-${profile}.marker`,
			}),
		).resolves.toBe(true);
		const otherProfile =
			profile === "admin-primary" ? "customer-primary" : "admin-primary";
		await expect(
			markerExists({
				markerDirectory: markers,
				name: `saved-state-${otherProfile}.marker`,
			}),
		).resolves.toBe(false);
	});

	it("embeds explicit empty state for the synthetic guest profile", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-guest-state-");
		const result = runInstalledCli({
			args: [
				"run",
				"--profile",
				"guest",
				"--grep",
				"generated guest state is explicitly empty",
			],
			consumerRoot,
			environmentOverrides: {
				SHOPIFY_E2E_EMPTY_STATE_PROBE: "1",
				SHOPIFY_E2E_PROFILE_DATA_ROOT_EXPECTED: installedProfileDataRoot,
			},
			markerDirectory: markers,
		});

		expectSuccess({ label: "installed guest empty-state run", result });
		expect(result.stdout).toMatch(/1 passed/i);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain(
			installedProfileDataRoot,
		);
		await expect(
			markerExists({
				markerDirectory: markers,
				name: "guest-empty-state.marker",
			}),
		).resolves.toBe(true);
	});

	it("rejects a runtime temp directory inside the consumer before writing generated state", async () => {
		const containedTemp = join(consumerRoot, "consumer-runtime-temp");
		await mkdir(containedTemp);
		const before = await generatedConfigDirectories(containedTemp);
		const result = runInstalledCli({
			args: ["run", "--profile", "guest"],
			consumerRoot,
			environmentOverrides: {
				TEMP: containedTemp,
				TMP: containedTemp,
				TMPDIR: containedTemp,
			},
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/temporary directory.*outside/i);
		expect(await generatedConfigDirectories(containedTemp)).toEqual(before);
	});

	it("runs only the conventional guest lane in one worker", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: ["run", "--profile", "guest"],
			consumerRoot,
			markerDirectory: markers,
		});

		expectSuccess({ label: "installed conventional run", result });
		expect(result.stdout).toMatch(/3 passed/i);
		expect(result.stderr).toContain("shopify-e2e.config.ts");
		expect(result.stderr).toContain("shopify-passing");
		const firstPid = await readFile(join(markers, "first.marker"), "utf8");
		const secondPid = await readFile(join(markers, "second.marker"), "utf8");
		expect(firstPid).toBe(secondPid);
		await expect(
			markerExists({ markerDirectory: markers, name: "guest-role.marker" }),
		).resolves.toBe(true);
		await expect(
			markerExists({
				markerDirectory: markers,
				name: "wrong-role-module-loaded.marker",
			}),
		).resolves.toBe(true);
		await expectOrdinaryLaneFixturesPresent(consumerRoot);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: [
				"alternate.marker",
				"failing.marker",
				"ordinary-config-loaded.marker",
				"ordinary-spec-loaded.marker",
				"admin-role.marker",
				"customer-role.marker",
				"multi-role.marker",
				"untagged-role.marker",
				"wrong-role-body.marker",
			],
		});
	});

	it.each([
		{
			absent: [
				"customer-role.marker",
				"guest-role.marker",
				"untagged-role.marker",
				"wrong-role-body.marker",
			],
			passed: 2,
			present: ["admin-role.marker", "multi-role.marker"],
			profile: "admin-primary",
		},
		{
			absent: [
				"admin-role.marker",
				"guest-role.marker",
				"untagged-role.marker",
			],
			passed: 3,
			present: [
				"customer-role.marker",
				"multi-role.marker",
				"wrong-role-body.marker",
			],
			profile: "customer-primary",
		},
	])("runs only the saved $profile role lane", async ({
		absent,
		passed,
		present,
		profile,
	}) => {
		const markers = await makeTemporaryDirectory("shopify-e2e-role-markers-");
		const result = runInstalledCli({
			args: ["run", "--profile", profile],
			consumerRoot,
			markerDirectory: markers,
		});

		expectSuccess({ label: `installed ${profile} run`, result });
		expect(result.stdout).toMatch(new RegExp(`${passed} passed`, "i"));
		for (const name of present) {
			await expect(
				markerExists({ markerDirectory: markers, name }),
				name,
			).resolves.toBe(true);
		}
		await expectMarkersAbsent({ markerDirectory: markers, names: absent });
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: ["ordinary-config-loaded.marker", "ordinary-spec-loaded.marker"],
		});
	});

	it("intersects the mandatory admin lane with allowed title filters", async () => {
		const narrowed = await makeTemporaryDirectory("shopify-e2e-narrowed-");
		const grepResult = runInstalledCli({
			args: ["run", "--profile", "admin-primary", "--grep", "multi role"],
			consumerRoot,
			markerDirectory: narrowed,
		});
		expectSuccess({ label: "installed role grep", result: grepResult });
		expect(grepResult.stdout).toMatch(/1 passed/i);
		await expect(
			markerExists({ markerDirectory: narrowed, name: "multi-role.marker" }),
		).resolves.toBe(true);
		await expectMarkersAbsent({
			markerDirectory: narrowed,
			names: ["admin-role.marker", "customer-role.marker", "guest-role.marker"],
		});

		const inverted = await makeTemporaryDirectory("shopify-e2e-inverted-");
		const invertResult = runInstalledCli({
			args: [
				"run",
				"--profile",
				"admin-primary",
				"--grep-invert",
				"multi role",
			],
			consumerRoot,
			markerDirectory: inverted,
		});
		expectSuccess({
			label: "installed role grep-invert",
			result: invertResult,
		});
		expect(invertResult.stdout).toMatch(/1 passed/i);
		await expect(
			markerExists({ markerDirectory: inverted, name: "admin-role.marker" }),
		).resolves.toBe(true);
		await expectMarkersAbsent({
			markerDirectory: inverted,
			names: ["multi-role.marker", "customer-role.marker", "guest-role.marker"],
		});
	});

	it("keeps auth help and listing independent from a Playwright peer", () => {
		const list = runInstalledCli({
			args: ["auth", "list"],
			consumerRoot: missingPeerConsumerRoot,
		});
		expectSuccess({ label: "installed auth list without peer", result: list });
		expect(list.stdout).toMatch(/admin-primary\s+admin\s+runnable/i);
		expect(list.stderr).not.toMatch(/playwright/i);

		const menu = runInstalledCli({
			args: ["auth"],
			consumerRoot: missingPeerConsumerRoot,
		});
		expect(menu.status).toBe(2);
		expect(menu.stderr).toMatch(/interactive terminal/i);
		expect(menu.stderr).not.toMatch(/install compatible @playwright/i);
	});

	it.each([
		["run", "ordinary.spec.ts"],
		["run", "--workers", "2"],
		["run", "--project", "ordinary"],
		["run", "--reporter", "html"],
		["run", "--ui"],
		["run", "--debug"],
		["run", "--headed"],
		["run", "--trace", "on"],
	])("rejects installed unrestricted input before execution: %s", (...args) => {
		const result = runInstalledCli({ args, consumerRoot });
		expect(result.status).toBe(2);
	});

	it("loads consumer .env in the packed CLI and preserves shell precedence", async () => {
		const dotenvPath = join(consumerRoot, ".env");
		await writeFile(
			dotenvPath,
			"SHOPIFY_E2E_DOTENV_SENTINEL=from-installed-dotenv\nDOTENV_CONFIG_DEBUG=1\nDOTENV_CONFIG_QUIET=false\n",
		);

		try {
			const dotenvResult = runInstalledCli({
				args: [
					"run",
					"--profile",
					"guest",
					"--config",
					"dotenv-shopify-e2e.config.ts",
				],
				consumerRoot,
				environmentOverrides: {
					DOTENV_CONFIG_DEBUG: undefined,
					DOTENV_CONFIG_QUIET: undefined,
					SHOPIFY_E2E_DOTENV_EXPECTED: "from-installed-dotenv",
					SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG: "1",
					SHOPIFY_E2E_DOTENV_EXPECTED_QUIET: "false",
					SHOPIFY_E2E_DOTENV_SENTINEL: undefined,
				},
			});
			expectSuccess({ label: "installed dotenv run", result: dotenvResult });
			expect(dotenvResult.stdout).toMatch(/1 passed/i);
			expect(`${dotenvResult.stdout}\n${dotenvResult.stderr}`).not.toMatch(
				dotenvOutputPattern,
			);

			const shellResult = runInstalledCli({
				args: [
					"run",
					"--profile",
					"guest",
					"--config",
					"dotenv-shopify-e2e.config.ts",
				],
				consumerRoot,
				environmentOverrides: {
					DOTENV_CONFIG_DEBUG: "1",
					DOTENV_CONFIG_QUIET: "false",
					SHOPIFY_E2E_DOTENV_EXPECTED: "",
					SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG: "1",
					SHOPIFY_E2E_DOTENV_EXPECTED_QUIET: "false",
					SHOPIFY_E2E_DOTENV_SENTINEL: "",
				},
			});
			expectSuccess({
				label: "installed dotenv shell precedence run",
				result: shellResult,
			});
			expect(shellResult.stdout).toMatch(/1 passed/i);
			expect(`${shellResult.stdout}\n${shellResult.stderr}`).not.toMatch(
				dotenvOutputPattern,
			);
		} finally {
			await rm(dotenvPath, { force: true });
		}
	});

	it("uses --config to run only the alternate Shopify lane", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: [
				"run",
				"--profile",
				"guest",
				"--config",
				"alternate-shopify-e2e.config.ts",
			],
			consumerRoot,
			markerDirectory: markers,
		});

		expectSuccess({ label: "installed alternate run", result });
		expect(result.stdout).toMatch(/1 passed/i);
		await expect(
			markerExists({ markerDirectory: markers, name: "alternate.marker" }),
		).resolves.toBe(true);
		await expectOrdinaryLaneFixturesPresent(consumerRoot);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: [
				"first.marker",
				"second.marker",
				"failing.marker",
				"ordinary-config-loaded.marker",
				"ordinary-spec-loaded.marker",
			],
		});
	});

	it.each([
		{
			args: ["auth", "capture", "--role", "admin", "--profile", "new-admin"],
			label: "capture",
			tty: true,
		},
		{
			args: ["auth", "refresh", "--profile", "admin-primary"],
			label: "refresh",
			tty: true,
		},
		{
			args: ["run", "--profile", "guest"],
			label: "run",
			tty: false,
		},
	])("fails installed $label at the consumer-owned peer boundary", async ({
		args,
		label,
		tty,
	}) => {
		const markers = await makeTemporaryDirectory("shopify-e2e-no-peer-");
		const result = (tty ? runInstalledCliWithSimulatedTty : runInstalledCli)({
			args,
			consumerRoot: missingPeerConsumerRoot,
			markerDirectory: markers,
		});

		expect(
			result.status,
			`installed ${label} peer failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		).toBe(2);
		expect(result.stderr).toMatch(
			/consumer project must install compatible @playwright\/test/i,
		);
		expect(result.stderr).not.toMatch(/node_modules.*(?:\.js|\.ts):\d+/i);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: ["first.marker", "second.marker"],
		});
	});

	it("rejects an incompatible installed consumer peer before execution", async () => {
		const markers = await makeTemporaryDirectory(
			"shopify-e2e-incompatible-peer-",
		);
		const metadataPath = join(
			consumerRoot,
			"node_modules",
			"@playwright",
			"test",
			"package.json",
		);
		const originalMetadata = await readFile(metadataPath, "utf8");
		const metadata = JSON.parse(originalMetadata) as Record<string, unknown>;
		await writeFile(
			metadataPath,
			`${JSON.stringify({ ...metadata, version: "1.62.0" }, null, 2)}\n`,
		);

		try {
			const result = runInstalledCli({
				args: ["run", "--profile", "guest"],
				consumerRoot,
				markerDirectory: markers,
			});

			expect(
				result.status,
				`installed incompatible peer failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			).toBe(2);
			expect(result.stderr).toMatch(
				/@playwright\/test version must satisfy >=1\.61\.1 <1\.62\.0/i,
			);
			expect(result.stderr).not.toMatch(/node_modules.*(?:\.js|\.ts):\d+/i);
		} finally {
			await writeFile(metadataPath, originalMetadata);
		}

		await expectMarkersAbsent({
			markerDirectory: markers,
			names: ["first.marker", "second.marker"],
		});
	});

	it("force-stops a hung release-gate subprocess at its deadline", () => {
		const startedAt = Date.now();
		const result = runCommand({
			args: ["--input-type=module", "--eval", "setInterval(() => {}, 1_000);"],
			command: process.execPath,
			cwd: projectRoot,
			timeoutMs: 100,
		});

		expect(result.status).toBeNull();
		expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
			"ETIMEDOUT",
		);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("preserves the failing Shopify lane result without touching other lanes", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: [
				"run",
				"--profile",
				"guest",
				"--config",
				"failing-shopify-e2e.config.ts",
			],
			consumerRoot,
			markerDirectory: markers,
		});

		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/1 failed/i);
		await expect(
			markerExists({ markerDirectory: markers, name: "failing.marker" }),
		).resolves.toBe(true);
		await expectOrdinaryLaneFixturesPresent(consumerRoot);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: [
				"first.marker",
				"second.marker",
				"alternate.marker",
				"ordinary-config-loaded.marker",
				"ordinary-spec-loaded.marker",
			],
		});
	});

	it.skipIf(process.platform === "win32")(
		"forwards a real SIGTERM, returns 143, and cleans the generated config and child tree",
		async () => {
			const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
			const runtimeTemp = await makeTemporaryDirectory("shopify-e2e-runtime-");
			const generatedBefore = await generatedConfigDirectories(runtimeTemp);
			const child = spawn(
				installedCliPath(consumerRoot),
				["run", "--profile", "guest"],
				{
					cwd: consumerRoot,
					detached: true,
					env: {
						...process.env,
						NO_COLOR: "1",
						SHOPIFY_E2E_INTERRUPT_ACTIVE: "1",
						SHOPIFY_E2E_MARKER_DIR: markers,
						SHOPIFY_STORE_URL: "https://shop.example",
						TEMP: runtimeTemp,
						TMP: runtimeTemp,
						TMPDIR: runtimeTemp,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			let interruptedProcess:
				| { readonly pid: number; readonly ppid: number }
				| undefined;
			let isCleanupVerified = false;

			try {
				await waitForMarker({
					markerDirectory: markers,
					name: "interrupt-started.marker",
					timeoutMs: 10_000,
				});
				interruptedProcess = JSON.parse(
					await readFile(join(markers, "interrupt-started.marker"), "utf8"),
				) as { readonly pid: number; readonly ppid: number };
				expect(child.pid).toBeTypeOf("number");
				const outcomePromise = new Promise<{
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
				}>((resolveOutcome, rejectOutcome) => {
					child.once("error", rejectOutcome);
					child.once("exit", (code, signal) =>
						resolveOutcome({ code, signal }),
					);
				});
				process.kill(child.pid as number, "SIGTERM");
				const outcome = await outcomePromise;

				expect(
					outcome,
					`interrupted installed CLI\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				).toEqual({ code: 143, signal: null });
				expect(stderr).toContain("Command interrupted by SIGTERM");
				expect(stderr).not.toContain("no tests started");
				await waitForProcessToExit({
					pid: interruptedProcess.pid,
					timeoutMs: 5_000,
				});
				await waitForProcessToExit({
					pid: interruptedProcess.ppid,
					timeoutMs: 5_000,
				});
				expect(await generatedConfigDirectories(runtimeTemp)).toEqual(
					generatedBefore,
				);
				isCleanupVerified = true;
			} finally {
				if (!isCleanupVerified) {
					await terminateAndAwaitProcesses({
						child,
						descendantPids: interruptedProcess
							? [interruptedProcess.pid, interruptedProcess.ppid]
							: [],
					});
				}
			}
		},
		20_000,
	);
});
