import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
if (markerDirectory) {
	writeFileSync(join(markerDirectory, "ordinary-spec-loaded.marker"), "loaded");
}

test("ordinary application E2E must never run", () => {
	expect("ordinary E2E ran").toBe("outside Shopify boundary");
});
