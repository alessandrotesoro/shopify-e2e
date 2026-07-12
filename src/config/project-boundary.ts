import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";
import { isPathContained } from "../path-boundary.js";

const conventionalConfigName = "shopify-e2e.config.ts";

function isStrictlyContained(root: string, candidate: string): boolean {
	return candidate !== root && isPathContained(root, candidate);
}

async function assertNoSymlinkComponents(
	root: string,
	candidate: string,
	label: string,
): Promise<Stats> {
	const pathFromRoot = relative(root, candidate);
	const components = pathFromRoot.split(sep).filter(Boolean);
	let current = root;
	let selectedMetadata: Stats | undefined;

	for (const component of components) {
		current = resolve(current, component);
		selectedMetadata = await lstat(current).catch((cause: unknown) => {
			throw new ShopifyE2EPreflightError(
				`${label} does not exist: ${current}`,
				{
					cause,
				},
			);
		});
		if (selectedMetadata.isSymbolicLink()) {
			throw new ShopifyE2EPreflightError(
				`${label} must not use a symbolic link: ${current}`,
			);
		}
	}

	if (!selectedMetadata) {
		throw new ShopifyE2EPreflightError(
			`${label} must be inside the consuming project: ${candidate}`,
		);
	}
	return selectedMetadata;
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
		);
	}
	if (!isStrictlyContained(projectRoot, selectedPath)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be inside the consuming project: ${selectedPath}`,
		);
	}

	const selectedMetadata = await assertNoSymlinkComponents(
		projectRoot,
		selectedPath,
		"Dedicated Shopify config",
	);
	if (!selectedMetadata.isFile()) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be a regular file: ${selectedPath}`,
		);
	}

	const physicalPath = await realpath(selectedPath);
	if (!isStrictlyContained(projectRoot, physicalPath)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must resolve inside the consuming project: ${selectedPath}`,
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

	const selectedMetadata = await assertNoSymlinkComponents(
		projectRoot,
		selectedPath,
		"Shopify test directory",
	);
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
