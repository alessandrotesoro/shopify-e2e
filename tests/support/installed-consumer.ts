import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface NpmPackFile {
	readonly mode: number;
	readonly path: string;
}

export interface PackedPackage {
	readonly files: readonly NpmPackFile[];
	readonly tarballPath: string;
}

interface CommandResult {
	readonly error?: Error;
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

const runNpm = (
	args: readonly string[],
	cwd: string,
	timeout = 90_000,
): CommandResult => {
	const result = spawnSync(npmExecutable, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout,
	});
	return {
		...(result.error === undefined ? {} : { error: result.error }),
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	};
};

const assertNpmSuccess = (label: string, result: CommandResult): void => {
	if (result.status !== 0) {
		throw new Error(
			`${label} failed (${result.status ?? "no exit"})\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
		);
	}
};

export const packPackageForConsumer = async (
	projectRoot: string,
	packDirectory: string,
): Promise<PackedPackage> => {
	const result = runNpm(
		["pack", "--json", "--pack-destination", packDirectory],
		projectRoot,
	);
	assertNpmSuccess("npm pack", result);
	const output = JSON.parse(result.stdout) as Array<{
		readonly filename: string;
		readonly files: readonly NpmPackFile[];
	}>;
	const artifact = output[0];
	if (!artifact) throw new Error("npm pack did not report an artifact");
	const tarballPath = join(packDirectory, artifact.filename);
	await readFile(tarballPath);
	return { files: artifact.files, tarballPath };
};

export interface InstallPackedPackageOptions {
	readonly consumerRoot: string;
	readonly hasPlaywright: boolean;
	readonly tarballPath: string;
}

export const installPackedPackage = async ({
	consumerRoot,
	hasPlaywright,
	tarballPath,
}: InstallPackedPackageOptions): Promise<void> => {
	const result = runNpm(
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--save=false",
			...(hasPlaywright ? [] : ["--omit=peer"]),
			tarballPath,
			...(hasPlaywright ? ["@playwright/test@1.61.1"] : []),
		],
		consumerRoot,
	);
	assertNpmSuccess(`install package into ${consumerRoot}`, result);
};

export const installedCliPath = (consumerRoot: string): string =>
	join(
		consumerRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "shopify-e2e.cmd" : "shopify-e2e",
	);
