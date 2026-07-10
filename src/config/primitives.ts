import { isAbsolute, resolve } from "node:path";

const authProfileNamePattern = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function cleanString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed ? trimmed : undefined;
}

export function parseBoolean(value: string | undefined): boolean | undefined {
	const cleaned = cleanString(value)?.toLowerCase();

	if (!cleaned) {
		return undefined;
	}

	return ["1", "true", "yes", "on"].includes(cleaned);
}

export function splitList(value: string | undefined): string[] | undefined {
	const cleaned = cleanString(value);

	if (!cleaned) {
		return undefined;
	}

	return cleaned
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function cdpPortFromUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	try {
		const url = new URL(value);

		return cleanString(url.port);
	} catch {
		return undefined;
	}
}

export function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export function validateAuthProfileName(value: unknown): string {
	if (!isValidAuthProfileName(value)) {
		throw new Error(
			`Invalid Shopify auth profile name ${JSON.stringify(value)}. Expected 1-64 lowercase letters or digits separated by single hyphens.`,
		);
	}

	return value;
}

export function isValidAuthProfileName(value: unknown): value is string {
	return typeof value === "string" && authProfileNamePattern.test(value);
}

export function authProfileStorageStatePath(
	cwd: string,
	authProfileName: string,
): string {
	return resolve(
		cwd,
		".shopify-e2e/auth/profiles",
		`${authProfileName}.json`,
	);
}
