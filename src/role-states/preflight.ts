import { ShopifyE2EPreflightError } from "../errors.js";
import { configuredOriginFromEnvironment } from "./configured-origin.cjs";

export const configuredOriginForCommand = (
	environment: NodeJS.ProcessEnv,
): string => {
	try {
		return configuredOriginFromEnvironment(environment);
	} catch (cause) {
		throw new ShopifyE2EPreflightError(
			cause instanceof Error ? cause.message : "SHOPIFY_STORE_URL is invalid",
			{ cause },
		);
	}
};

export const unknownRole = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} is not configured. Run \`shopify-e2e auth list\` or omit --role in an interactive terminal.`,
	);

export const missingState = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} has no saved state. Run \`shopify-e2e auth capture --role ${role}\`.`,
	);

export const invalidState = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} has invalid saved state. Run \`shopify-e2e auth remove --role ${role}\`, then \`shopify-e2e auth capture --role ${role}\`.`,
	);

export const unsafeCollision = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} has an unsafe filesystem collision. Manual cleanup is required; the CLI will not follow or remove it.`,
	);
