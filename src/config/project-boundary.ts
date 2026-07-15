import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";
import { isPathContained } from "../path-boundary.utils.cjs";

const conventionalConfigName = "shopify-e2e.config.ts";

interface IsStrictlyContainedArgs {
	readonly candidate: string;
	readonly root: string;
}

const isStrictlyContained = ({
	candidate,
	root,
}: IsStrictlyContainedArgs): boolean =>
	candidate !== root && isPathContained({ candidate, parent: root });

interface AssertNoSymlinkComponentsArgs {
	readonly candidate: string;
	readonly label: string;
	readonly root: string;
}

const assertNoSymlinkComponents = async ({
	candidate,
	label,
	root,
}: AssertNoSymlinkComponentsArgs): Promise<Stats> => {
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
};

export const resolveProjectRoot = async (cwd: string): Promise<string> => {
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
};

export interface ResolveShopifyConfigPathArgs {
	readonly projectRoot: string;
}

export const resolveShopifyConfigPath = async ({
	projectRoot,
}: ResolveShopifyConfigPathArgs): Promise<string> => {
	const selectedPath = resolve(projectRoot, conventionalConfigName);
	if (!isStrictlyContained({ candidate: selectedPath, root: projectRoot })) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be inside the consuming project: ${selectedPath}`,
		);
	}

	const selectedMetadata = await assertNoSymlinkComponents({
		candidate: selectedPath,
		label: "Dedicated Shopify config",
		root: projectRoot,
	});
	if (!selectedMetadata.isFile()) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must be a regular file: ${selectedPath}`,
		);
	}

	const physicalPath = await realpath(selectedPath);
	if (!isStrictlyContained({ candidate: physicalPath, root: projectRoot })) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must resolve inside the consuming project: ${selectedPath}`,
		);
	}
	return physicalPath;
};

export interface ResolveShopifyTestDirArgs {
	readonly configuredTestDir: string;
	readonly projectRoot: string;
}

export const resolveShopifyTestDir = async ({
	configuredTestDir,
	projectRoot,
}: ResolveShopifyTestDirArgs): Promise<string> => {
	const selectedPath = resolve(projectRoot, configuredTestDir);
	if (!isStrictlyContained({ candidate: selectedPath, root: projectRoot })) {
		throw new ShopifyE2EPreflightError(
			`Shopify test directory must be inside the consuming project: ${selectedPath}`,
		);
	}

	const selectedMetadata = await assertNoSymlinkComponents({
		candidate: selectedPath,
		label: "Shopify test directory",
		root: projectRoot,
	});
	if (!selectedMetadata.isDirectory()) {
		throw new ShopifyE2EPreflightError(
			`Shopify test path must be a directory: ${selectedPath}`,
		);
	}

	const physicalPath = await realpath(selectedPath);
	if (!isStrictlyContained({ candidate: physicalPath, root: projectRoot })) {
		throw new ShopifyE2EPreflightError(
			`Shopify test directory must resolve inside the consuming project: ${selectedPath}`,
		);
	}
	return physicalPath;
};
