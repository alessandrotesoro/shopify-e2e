import { assertRoleName } from "./role-name.cjs";

export const ROLE_TOKEN_PREFIX = "@shopify-e2e-role-";

export const buildRoleToken = (role: string): string =>
	`${ROLE_TOKEN_PREFIX}${assertRoleName(role)}`;

export const buildRoleTokenPattern = (role: string): RegExp =>
	new RegExp(`(?:^|\\s)${buildRoleToken(role)}(?=$|\\s)`);
