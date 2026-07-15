import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";
import { isPathContained } from "../path-boundary.utils.cjs";

const assertNoSymlinkComponents = async (candidate: string): Promise<void> => {
	const { root } = parse(candidate);
	const components = relative(root, candidate).split(sep).filter(Boolean);
	let current = root;
	for (const component of components) {
		current = join(current, component);
		let metadata: Stats;
		try {
			metadata = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new ShopifyE2EPreflightError(
				"Role-state data directory could not be inspected",
				{ cause: error },
			);
		}
		if (metadata.isSymbolicLink()) {
			throw new ShopifyE2EPreflightError(
				"Role-state data directory must not contain symbolic links",
			);
		}
	}
};

const resolveProspectivePhysicalPath = async (
	candidate: string,
): Promise<string> => {
	let existing = candidate;
	for (;;) {
		try {
			await lstat(existing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = resolve(existing, "..");
			if (parent === existing) throw error;
			existing = parent;
		}
	}
	const physicalExisting = await realpath(existing);
	return resolve(physicalExisting, relative(existing, candidate));
};

export interface ResolveRoleStateDataRootArgs {
	readonly dataDir: string;
	readonly packageRoot: string;
	readonly projectRoot: string;
}

export const resolveRoleStateDataRoot = async ({
	dataDir,
	packageRoot,
	projectRoot,
}: ResolveRoleStateDataRootArgs): Promise<string> => {
	if (!isAbsolute(dataDir)) {
		throw new ShopifyE2EPreflightError(
			"Role-state data directory must be an absolute path",
		);
	}
	const candidate = resolve(dataDir);
	await assertNoSymlinkComponents(candidate);
	let physicalCandidate: string;
	let physicalProject: string;
	let physicalPackage: string;
	try {
		[physicalCandidate, physicalProject, physicalPackage] = await Promise.all([
			resolveProspectivePhysicalPath(candidate),
			realpath(projectRoot),
			realpath(packageRoot),
		]);
	} catch (error) {
		throw new ShopifyE2EPreflightError(
			"Role-state data directory boundary could not be resolved",
			{ cause: error },
		);
	}
	if (
		isPathContained({
			candidate: physicalCandidate,
			parent: physicalProject,
		}) ||
		isPathContained({ candidate: physicalCandidate, parent: physicalPackage })
	) {
		throw new ShopifyE2EPreflightError(
			"Role-state data directory must resolve outside the consumer project and package installation",
		);
	}
	return physicalCandidate;
};
