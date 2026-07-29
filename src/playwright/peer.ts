import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

import type { CaptureBrowser } from "../auth/capture-role-state.js";
import { ShopifyE2EPreflightError } from "../errors.js";
import { PACKAGE_ROOT } from "../package-root.js";
import { isPathContained } from "../path-boundary.utils.js";

const SUPPORTED_PLAYWRIGHT_RANGE = ">=1.61.1 <1.62.0";
export interface ResolvedPlaywrightPeer {
	readonly executablePath: string;
	readonly modulePath: string;
}

export interface ConsumerChromiumLauncher {
	readonly executablePath?: () => string;
	launch(options: { readonly headless: boolean }): Promise<CaptureBrowser>;
	readonly launchServer: (
		options: BrowserServerLaunchOptions,
	) => Promise<ConsumerBrowserServer>;
}

export interface BrowserServerLaunchOptions {
	readonly args?: readonly string[];
	readonly artifactsDir?: string;
	readonly channel?: string;
	readonly chromiumSandbox?: boolean;
	readonly downloadsPath?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly executablePath?: string;
	readonly handleSIGHUP: true;
	readonly handleSIGINT: false;
	readonly handleSIGTERM: false;
	readonly headless: false;
	readonly host: "127.0.0.1";
	readonly ignoreDefaultArgs?: boolean | readonly string[];
	readonly port: 0;
	readonly proxy?: {
		readonly bypass?: string;
		readonly password?: string;
		readonly server: string;
		readonly username?: string;
	};
	readonly timeout?: number;
}

export interface ConsumerBrowserServer {
	close(): Promise<unknown>;
	kill(): Promise<unknown>;
	off(event: "close", listener: () => void): unknown;
	on(event: "close", listener: () => void): unknown;
	wsEndpoint(): string;
}

const isModuleApi = (value: unknown): value is Record<string, unknown> =>
	value !== null && (typeof value === "object" || typeof value === "function");

const resolvePublicApi = (
	moduleNamespace: unknown,
): Record<string, unknown> | undefined => {
	if (!isModuleApi(moduleNamespace)) return undefined;
	if ("chromium" in moduleNamespace) return moduleNamespace;
	if ("default" in moduleNamespace && isModuleApi(moduleNamespace.default)) {
		return moduleNamespace.default;
	}
	return undefined;
};

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
	let consumerRoot: string;
	try {
		consumerRoot = await realpath(resolve(cwd));
	} catch (error) {
		throw preflight({
			cause: error,
			message: "Consumer project root could not be resolved",
		});
	}
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
	let packageInstallationRoot: string;
	try {
		packageInstallationRoot = await realpath(PACKAGE_ROOT);
	} catch (error) {
		throw preflight({
			cause: error,
			message: "shopify-e2e package installation could not be resolved",
		});
	}
	if (
		consumerRoot !== packageInstallationRoot &&
		isPathContained({
			candidate: packageRoot,
			parent: packageInstallationRoot,
		})
	) {
		throw preflight({
			message: `Consumer project must install its own compatible @playwright/test (${SUPPORTED_PLAYWRIGHT_RANGE}): ${consumerRoot}`,
		});
	}
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

	let modulePath: string;
	try {
		modulePath = await realpath(consumerRequire.resolve("@playwright/test"));
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer @playwright/test public module entry is missing: ${consumerRoot}`,
		});
	}
	if (!isPathContained({ candidate: modulePath, parent: packageRoot })) {
		throw preflight({
			message: `Consumer @playwright/test public module resolved outside its package: ${consumerRoot}`,
		});
	}
	let isModuleFile: boolean;
	try {
		isModuleFile = (await stat(modulePath)).isFile();
	} catch (error) {
		throw preflight({
			cause: error,
			message: `Consumer @playwright/test public module is unreadable: ${consumerRoot}`,
		});
	}
	if (!isModuleFile) {
		throw preflight({
			message: `Consumer @playwright/test public module must be a regular file: ${consumerRoot}`,
		});
	}

	return { executablePath, modulePath };
};

export const loadConsumerChromium = async (
	peer: ResolvedPlaywrightPeer,
): Promise<ConsumerChromiumLauncher> => {
	let moduleNamespace: unknown;
	try {
		moduleNamespace = await import(pathToFileURL(peer.modulePath).href);
	} catch (error) {
		throw preflight({
			cause: error,
			message: "Consumer @playwright/test browser API could not be loaded",
		});
	}
	const publicApi = resolvePublicApi(moduleNamespace);
	if (
		!publicApi ||
		!("chromium" in publicApi) ||
		typeof publicApi.chromium !== "object" ||
		publicApi.chromium === null ||
		!("launch" in publicApi.chromium) ||
		typeof publicApi.chromium.launch !== "function" ||
		!("launchServer" in publicApi.chromium) ||
		typeof publicApi.chromium.launchServer !== "function" ||
		!("executablePath" in publicApi.chromium) ||
		typeof publicApi.chromium.executablePath !== "function"
	) {
		throw preflight({
			message:
				"Consumer @playwright/test does not expose the supported Chromium API",
		});
	}
	const chromium = publicApi.chromium as ConsumerChromiumLauncher & {
		executablePath: () => string;
	};
	let chromiumPath: string;
	try {
		chromiumPath = chromium.executablePath();
		if (chromiumPath.trim().length === 0) throw new Error("empty path");
		const executable = await stat(chromiumPath);
		if (!executable.isFile()) throw new Error("not a regular file");
	} catch (error) {
		throw preflight({
			cause: error,
			message:
				"Consumer Chromium is unavailable. Install it from the consumer with `npx playwright install chromium` and retry.",
		});
	}
	return chromium;
};
