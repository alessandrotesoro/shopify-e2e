import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "@playwright/test";

const mark = (name: string): void => {
	const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
	if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
	writeFileSync(join(markerDirectory, `${name}.marker`), String(process.pid));
};

test("admin role body", { tag: "@shopify-e2e-role-admin" }, () =>
	mark("admin-role"),
);

test("customer role body", { tag: "@shopify-e2e-role-customer" }, () =>
	mark("customer-role"),
);

test("guest role body", { tag: "@shopify-e2e-role-guest" }, () =>
	mark("guest-role"),
);

test(
	"multi role body",
	{
		tag: ["@shopify-e2e-role-admin", "@shopify-e2e-role-customer"],
	},
	() => mark("multi-role"),
);

test("untagged role body", () => mark("untagged-role"));
