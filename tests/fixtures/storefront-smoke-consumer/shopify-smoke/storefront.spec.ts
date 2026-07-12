import { expect, test } from "@playwright/test";

test("loads a real Shopify storefront", async ({ page }) => {
	const configuredStoreUrl = process.env.SHOPIFY_STORE_URL;
	if (!configuredStoreUrl) {
		throw new Error("SHOPIFY_STORE_URL is required");
	}

	let storeUrl: URL;
	try {
		storeUrl = new URL(configuredStoreUrl);
	} catch {
		throw new Error("SHOPIFY_STORE_URL must be an absolute HTTP(S) URL");
	}
	if (storeUrl.protocol !== "http:" && storeUrl.protocol !== "https:") {
		throw new Error("SHOPIFY_STORE_URL must be an absolute HTTP(S) URL");
	}

	const response = await page.goto(storeUrl.href, {
		waitUntil: "domcontentloaded",
	});

	expect(
		response,
		"storefront navigation must return a document response",
	).not.toBeNull();
	expect(
		response?.ok(),
		`storefront navigation returned HTTP ${response?.status() ?? "unknown"}`,
	).toBe(true);
});
