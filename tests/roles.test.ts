import { describe, expect, it } from "vitest";

import {
	assertProfileName,
	assertRoleName,
	isValidProfileName,
} from "../src/profiles/profile-name.js";
import {
	buildRoleToken,
	buildRoleTokenPattern,
} from "../src/roles/role-token.cjs";

describe("profile and role names", () => {
	it.each([
		"admin",
		"customer-primary",
		"role2",
		"a",
	])("accepts canonical lower-kebab name %s", (name) =>
		expect(isValidProfileName(name)).toBe(true));

	it.each([
		"",
		"Admin",
		"admin_user",
		"admin--primary",
		"-admin",
		"admin-",
		"../admin",
		"admіn",
		"équipe",
		"admin/profile",
		"admin\\profile",
		"admin role",
		"admin.role",
		`${"a".repeat(64)}b`,
	])("rejects unsafe name %s", (name) => {
		expect(isValidProfileName(name)).toBe(false);
		expect(() => assertProfileName(name)).toThrow(/lower-kebab/i);
	});
});

describe("role token pattern", () => {
	it("matches only the selected reserved role token", () => {
		const pattern = buildRoleTokenPattern("admin");

		expect(buildRoleToken("admin")).toBe("@shopify-e2e-role-admin");
		expect(pattern.test("@shopify-e2e-role-admin title")).toBe(true);
		expect(pattern.test("file title @shopify-e2e-role-admin")).toBe(true);
		expect(pattern.test("file title @shopify-e2e-role-admin-extra")).toBe(
			false,
		);
		expect(pattern.test("file title prefix@shopify-e2e-role-admin")).toBe(
			false,
		);
		expect(pattern.test("file title @shopify-e2e-role-admin.extra")).toBe(
			false,
		);
	});

	it("rejects unsafe role input before regex construction", () => {
		expect(() => buildRoleTokenPattern("admin|customer")).toThrow(
			/lower-kebab/i,
		);
		expect(() => assertRoleName("../admin")).toThrow(/lower-kebab/i);
	});
});
