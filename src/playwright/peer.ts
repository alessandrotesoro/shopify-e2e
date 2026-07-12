import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import semver from "semver";

import { ShopifyE2EPreflightError } from "../errors.js";
import { isPathContained } from "../path-boundary.utils.js";

const SUPPORTED_PLAYWRIGHT_RANGE = ">=1.61.1 <1.62.0";

export interface ResolvedPlaywrightPeer {
	readonly executablePath: string;
}

interface PlaywrightPackageMetadata {
	readonly bin: unknown;
	readonly name: unknown;
	readonly version: unknown;
}

interface PreflightArgs {
	readonly cause?: unknown;
	readonly message: string;
}

const preflight = ({
	cause,
	message,
}: PreflightArgs): ShopifyE2EPreflightError => {
	return new ShopifyE2EPreflightError(message, { cause });
};

interface ReadDeclaredBinArgs {
	readonly consumerRoot: string;
	readonly metadata: PlaywrightPackageMetadata;
}

const readDeclaredBin = ({
	consumerRoot,
	metadata,
}: ReadDeclaredBinArgs): string => {
	if (
		typeof metadata.bin !== "object" ||
		metadata.bin === null ||
		Array.isArray(metadata.bin) ||
		!("playwright" in metadata.bin) ||
		typeof metadata.bin.playwright !== "string" ||
		metadata.bin.playwright.trim().length === 0
	) {
		throw preflight({
			message: `Consumer @playwright/test must declare a non-empty playwright bin: ${consumerRoot}`,
		});
	}
	return metadata.bin.playwright;
};

interface ReadMetadataArgs {
	readonly consumerRoot: string;
	readonly packageJsonPath: string;
}

const readMetadata = async ({
	consumerRoot,
	packageJsonPath,
}: ReadMetadataArgs): Promise<PlaywrightPackageMetadata> => {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(packageJsonPath, "utf8"));
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer @playwright/test package metadata is unreadable: ${consumerRoot}`,
		});
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw preflight({
			message: `Consumer @playwright/test package metadata is malformed: ${consumerRoot}`,
		});
	}
	return {
		bin: "bin" in value ? value.bin : undefined,
		name: "name" in value ? value.name : undefined,
		version: "version" in value ? value.version : undefined,
	};
};

export const resolvePlaywrightPeer = async (
	cwd: string,
): Promise<ResolvedPlaywrightPeer> => {
	const consumerRoot = resolve(cwd);
	const consumerRequire = createRequire(join(consumerRoot, "package.json"));

	let resolvedPackageJson: string;
	try {
		resolvedPackageJson = consumerRequire.resolve(
			"@playwright/test/package.json",
		);
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer project must install compatible @playwright/test (${SUPPORTED_PLAYWRIGHT_RANGE}): ${consumerRoot}`,
		});
	}

	let packageJsonPath: string;
	try {
		packageJsonPath = await realpath(resolvedPackageJson);
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer @playwright/test package metadata is not a real file: ${consumerRoot}`,
		});
	}
	const packageRoot = dirname(packageJsonPath);
	const metadata = await readMetadata({ consumerRoot, packageJsonPath });
	if (metadata.name !== "@playwright/test") {
		throw preflight({
			message: `Consumer resolved unexpected Playwright package metadata: ${consumerRoot}`,
		});
	}
	if (
		typeof metadata.version !== "string" ||
		!semver.satisfies(metadata.version, SUPPORTED_PLAYWRIGHT_RANGE)
	) {
		throw preflight({
			message: `Consumer @playwright/test version must satisfy ${SUPPORTED_PLAYWRIGHT_RANGE}; found ${String(metadata.version)}: ${consumerRoot}`,
		});
	}

	const declaredBin = readDeclaredBin({ consumerRoot, metadata });
	const declaredBinPath = resolve(packageRoot, declaredBin);
	if (!isPathContained({ candidate: declaredBinPath, parent: packageRoot })) {
		throw preflight({
			message: `Consumer @playwright/test declared bin must stay inside its package: ${consumerRoot}`,
		});
	}

	let executablePath: string;
	try {
		executablePath = await realpath(declaredBinPath);
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer @playwright/test declared playwright bin is missing: ${consumerRoot}`,
		});
	}
	if (!isPathContained({ candidate: executablePath, parent: packageRoot })) {
		throw preflight({
			message: `Consumer @playwright/test declared bin resolved outside its package: ${consumerRoot}`,
		});
	}
	let isExecutableFile: boolean;
	try {
		isExecutableFile = (await stat(executablePath)).isFile();
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer @playwright/test declared playwright bin is unreadable: ${consumerRoot}`,
		});
	}
	if (!isExecutableFile) {
		throw preflight({
			message: `Consumer @playwright/test declared playwright bin must be a regular file: ${consumerRoot}`,
		});
	}

	return { executablePath };
};
