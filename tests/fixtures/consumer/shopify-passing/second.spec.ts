import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "@playwright/test";

test("second Shopify fixture", { tag: "@shopify-e2e-role-guest" }, async () => {
	const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
	if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
	if (process.env.SHOPIFY_E2E_INTERRUPT_ACTIVE === "1") {
		writeFileSync(
			join(markerDirectory, "interrupt-started.marker"),
			JSON.stringify({ pid: process.pid, ppid: process.ppid }),
		);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 60_000));
		return;
	}
	writeFileSync(join(markerDirectory, "second.marker"), String(process.pid));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
});
