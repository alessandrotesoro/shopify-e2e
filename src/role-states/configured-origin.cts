import { createHash } from "node:crypto";

export const normalizeConfiguredOrigin = (input: string): string => {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new TypeError(
			"SHOPIFY_STORE_URL must be an absolute HTTPS URL. Set it in the consumer .env file or inherited environment.",
		);
	}
	if (url.protocol !== "https:") {
		throw new TypeError(
			"SHOPIFY_STORE_URL must use HTTPS. Set it in the consumer .env file or inherited environment.",
		);
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new TypeError(
			"SHOPIFY_STORE_URL must not contain credentials or URL userinfo. Set it in the consumer .env file or inherited environment.",
		);
	}
	return url.origin;
};

export const configuredOriginFromEnvironment = (
	environment: NodeJS.ProcessEnv,
): string => {
	const configuredUrl = environment.SHOPIFY_STORE_URL;
	if (!configuredUrl) {
		throw new TypeError(
			"SHOPIFY_STORE_URL is required. Set it in the consumer .env file or inherited environment.",
		);
	}
	return normalizeConfiguredOrigin(configuredUrl);
};

export const configuredOriginKey = (normalizedOrigin: string): string =>
	createHash("sha256").update(normalizedOrigin).digest("hex");
