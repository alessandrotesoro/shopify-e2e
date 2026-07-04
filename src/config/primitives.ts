import { isAbsolute, resolve } from "node:path";

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
