import { ShopifyE2EPreflightError } from "../errors.js";

const MAX_NAME_BYTES = 64;
const LOWER_KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidProfileName = (value: unknown): value is string =>
	typeof value === "string" &&
	Buffer.byteLength(value, "utf8") <= MAX_NAME_BYTES &&
	LOWER_KEBAB_NAME.test(value);

export const assertProfileName = (
	value: unknown,
	label = "Profile name",
): string => {
	if (!isValidProfileName(value)) {
		throw new ShopifyE2EPreflightError(
			`${label} must be an ASCII lower-kebab name no longer than ${MAX_NAME_BYTES} bytes`,
		);
	}
	return value;
};

export const assertRoleName = (value: unknown): string =>
	assertProfileName(value, "Role name");
