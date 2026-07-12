import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

test("intentionally failing Shopify fixture", () => {
	const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
	if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
	writeFileSync(join(markerDirectory, "failing.marker"), String(process.pid));
	expect("intentional failure").toBe("passing result");
});
