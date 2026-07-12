import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

import { ShopifyE2EPreflightError } from "../errors.js";

export const SUPPORTED_PLAYWRIGHT_RANGE = ">=1.61.1 <1.62.0";

export interface ResolvedPlaywrightPeer {
	readonly executablePath: string;
	readonly packageJsonPath: string;
	readonly packageRoot: string;
	readonly version: string;
}

interface PlaywrightPackageMetadata {
	readonly bin: unknown;
	readonly name: unknown;
	readonly version: unknown;
}

function isContained(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return (
		pathFromParent === "" ||
		(!pathFromParent.startsWith(`..${sep}`) &&
			pathFromParent !== ".." &&
			!isAbsolute(pathFromParent))
	);
}

function preflight(message: string, cause?: unknown): ShopifyE2EPreflightError {
	return new ShopifyE2EPreflightError(message, { cause });
}

function readDeclaredBin(
	metadata: PlaywrightPackageMetadata,
	consumerRoot: string,
): string {
	if (
		typeof metadata.bin !== "object" ||
		metadata.bin === null ||
		Array.isArray(metadata.bin) ||
		!("playwright" in metadata.bin) ||
		typeof metadata.bin.playwright !== "string" ||
		metadata.bin.playwright.trim().length === 0
	) {
		throw preflight(
			`Consumer @playwright/test must declare a non-empty playwright bin: ${consumerRoot}`,
		);
	}
	return metadata.bin.playwright;
}

async function readMetadata(
	packageJsonPath: string,
	consumerRoot: string,
): Promise<PlaywrightPackageMetadata> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(packageJsonPath, "utf8"));
	} catch (error) {
		throw preflight(
			`Consumer @playwright/test package metadata is unreadable: ${consumerRoot}`,
			error,
		);
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw preflight(
			`Consumer @playwright/test package metadata is malformed: ${consumerRoot}`,
		);
	}
	return {
		bin: "bin" in value ? value.bin : undefined,
		name: "name" in value ? value.name : undefined,
		version: "version" in value ? value.version : undefined,
	};
}

export async function resolvePlaywrightPeer(
	cwd: string,
): Promise<ResolvedPlaywrightPeer> {
	const consumerRoot = resolve(cwd);
	const consumerRequire = createRequire(
		pathToFileURL(join(consumerRoot, "package.json")),
	);

	let resolvedPackageJson: string;
	try {
		resolvedPackageJson = consumerRequire.resolve(
			"@playwright/test/package.json",
		);
	} catch (error) {
		throw preflight(
			`Consumer project must install compatible @playwright/test (${SUPPORTED_PLAYWRIGHT_RANGE}): ${consumerRoot}`,
			error,
		);
	}

	let packageJsonPath: string;
	try {
		packageJsonPath = await realpath(resolvedPackageJson);
	} catch (error) {
		throw preflight(
			`Consumer @playwright/test package metadata is not a real file: ${consumerRoot}`,
			error,
		);
	}
	const packageRoot = dirname(packageJsonPath);
	const metadata = await readMetadata(packageJsonPath, consumerRoot);
	if (metadata.name !== "@playwright/test") {
		throw preflight(
			`Consumer resolved unexpected Playwright package metadata: ${consumerRoot}`,
		);
	}
	if (
		typeof metadata.version !== "string" ||
		!semver.satisfies(metadata.version, SUPPORTED_PLAYWRIGHT_RANGE)
	) {
		throw preflight(
			`Consumer @playwright/test version must satisfy ${SUPPORTED_PLAYWRIGHT_RANGE}; found ${String(metadata.version)}: ${consumerRoot}`,
		);
	}

	const declaredBin = readDeclaredBin(metadata, consumerRoot);
	const declaredBinPath = resolve(packageRoot, declaredBin);
	if (!isContained(packageRoot, declaredBinPath)) {
		throw preflight(
			`Consumer @playwright/test declared bin must stay inside its package: ${consumerRoot}`,
		);
	}

	let executablePath: string;
	try {
		executablePath = await realpath(declaredBinPath);
	} catch (error) {
		throw preflight(
			`Consumer @playwright/test declared playwright bin is missing: ${consumerRoot}`,
			error,
		);
	}
	if (!isContained(packageRoot, executablePath)) {
		throw preflight(
			`Consumer @playwright/test declared bin resolved outside its package: ${consumerRoot}`,
		);
	}
	let executableIsFile: boolean;
	try {
		executableIsFile = (await stat(executablePath)).isFile();
	} catch (error) {
		throw preflight(
			`Consumer @playwright/test declared playwright bin is unreadable: ${consumerRoot}`,
			error,
		);
	}
	if (!executableIsFile) {
		throw preflight(
			`Consumer @playwright/test declared playwright bin must be a regular file: ${consumerRoot}`,
		);
	}

	return {
		executablePath,
		packageJsonPath,
		packageRoot,
		version: metadata.version,
	};
}
