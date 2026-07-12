import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "@playwright/test";

test("alternate Shopify fixture", () => {
	const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
	if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
	writeFileSync(join(markerDirectory, "alternate.marker"), String(process.pid));
});
