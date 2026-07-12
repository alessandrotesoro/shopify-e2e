import { writeFileSync } from "node:fs";
import { join } from "node:path";

const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
if (markerDirectory) {
	writeFileSync(
		join(markerDirectory, "ordinary-config-loaded.marker"),
		"loaded",
	);
}

export default { testDir: "ordinary-e2e" };
