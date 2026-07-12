import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";

const conventionalConfigName = "shopify-e2e.config.ts";

function isSameOrContained(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) &&
			pathFromRoot !== ".." &&
			!isAbsolute(pathFromRoot))
	);
}

function isStrictlyContained(root: string, candidate: string): boolean {
	return candidate !== root && isSameOrContained(root, candidate);
}

async function assertNoSymlinkComponents(
	root: string,
	candidate: string,
	label: string,
): Promise<void> {
	const pathFromRoot = relative(root, candidate);
	const components = pathFromRoot.split(sep).filter(Boolean);
	let current = root;

	for (const component of components) {
		current = resolve(current, component);
		const metadata = await lstat(current).catch((cause: unknown) => {
			throw new ShopifyE2EPreflightError(
				`${label} does not exist: ${current}`,
				{
					cause,
				},
			);
		});
		if (metadata.isSymbolicLink()) {
			throw new ShopifyE2EPreflightError(
				`${label} must not use a symbolic link: ${current}`,
			);
		}
	}
}

export async function resolveProjectRoot(cwd: string): Promise<string> {
	let projectRoot: string;
	try {
		projectRoot = await realpath(resolve(cwd));
	} catch (cause) {
		throw new ShopifyE2EPreflightError(
			`Consuming project directory does not exist: ${resolve(cwd)}`,
			{ cause },
		);
	}

	if (!(await stat(projectRoot)).isDirectory()) {
		throw new ShopifyE2EPreflightError(
			`Consuming project path must be a directory: ${projectRoot}`,
		);
	}
	return projectRoot;
}

export async function resolveShopifyConfigPath(
	projectRoot: string,
	explicitConfigPath?: string,
): Promise<string> {
	const selectedPath = resolve(
		projectRoot,
		explicitConfigPath ?? conventionalConfigName,
	);

	if (!selectedPath.endsWith(".ts")) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be a .ts file: ${selectedPath}`,
			{ configPath: selectedPath },
		);
	}
	if (!isStrictlyContained(projectRoot, selectedPath)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be inside the consuming project: ${selectedPath}`,
			{ configPath: selectedPath },
		);
	}

	await assertNoSymlinkComponents(
		projectRoot,
		selectedPath,
		"Dedicated Shopify config",
	);

	const selectedMetadata = await lstat(selectedPath);
	if (!selectedMetadata.isFile()) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be a regular file: ${selectedPath}`,
			{ configPath: selectedPath },
		);
	}

	const physicalPath = await realpath(selectedPath);
	if (!isStrictlyContained(projectRoot, physicalPath)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must resolve inside the consuming project: ${selectedPath}`,
			{ configPath: selectedPath },
		);
	}
	return physicalPath;
}

export async function resolveShopifyTestDir(
	projectRoot: string,
	configuredTestDir: string,
): Promise<string> {
	const selectedPath = resolve(projectRoot, configuredTestDir);
	if (!isStrictlyContained(projectRoot, selectedPath)) {
		throw new ShopifyE2EPreflightError(
			`Shopify test directory must be inside the consuming project: ${selectedPath}`,
		);
	}

	await assertNoSymlinkComponents(
		projectRoot,
		selectedPath,
		"Shopify test directory",
	);

	const selectedMetadata = await lstat(selectedPath);
	if (!selectedMetadata.isDirectory()) {
		throw new ShopifyE2EPreflightError(
			`Shopify test path must be a directory: ${selectedPath}`,
		);
	}

	const physicalPath = await realpath(selectedPath);
	if (!isStrictlyContained(projectRoot, physicalPath)) {
		throw new ShopifyE2EPreflightError(
			`Shopify test directory must resolve inside the consuming project: ${selectedPath}`,
		);
	}
	return physicalPath;
}
