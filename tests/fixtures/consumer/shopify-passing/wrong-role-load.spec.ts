import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "@playwright/test";

const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
if (markerDirectory) {
	writeFileSync(
		join(markerDirectory, "wrong-role-module-loaded.marker"),
		"loaded",
	);
}

test("wrong role body", { tag: "@shopify-e2e-role-customer" }, () => {
	if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
	writeFileSync(
		join(markerDirectory, "wrong-role-body.marker"),
		String(process.pid),
	);
});
