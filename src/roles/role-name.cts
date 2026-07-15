const MAX_ROLE_NAME_BYTES = 64;
const LOWER_KEBAB_ROLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidRoleName = (value: unknown): value is string =>
	typeof value === "string" &&
	Buffer.byteLength(value, "utf8") <= MAX_ROLE_NAME_BYTES &&
	LOWER_KEBAB_ROLE_NAME.test(value);

export const assertRoleName = (value: unknown): string => {
	if (!isValidRoleName(value)) {
		throw new TypeError(
			`Role name must be an ASCII lower-kebab name no longer than ${MAX_ROLE_NAME_BYTES} bytes`,
		);
	}
	return value;
};

const expectedRoleListKeys = (length: number): Set<string> =>
	new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);

export const validateRoleList = (value: unknown): readonly string[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TypeError("Shopify config roles must be a non-empty list");
	}

	const expectedKeys = expectedRoleListKeys(value.length);
	const ownKeys = Reflect.ownKeys(value);
	if (
		ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
		ownKeys.length !== expectedKeys.size
	) {
		throw new TypeError(
			"Shopify config roles must be a plain list without extra or symbol properties",
		);
	}

	const roles: string[] = [];
	const uniqueRoles = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(
				"Shopify config roles must contain only plain data entries",
			);
		}
		const role = assertRoleName(descriptor.value);
		if (uniqueRoles.has(role)) {
			throw new TypeError(`Shopify config roles must be unique: ${role}`);
		}
		uniqueRoles.add(role);
		roles.push(role);
	}

	return Object.freeze(roles);
};
