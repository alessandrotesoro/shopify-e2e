import {
	missingLiveShopifyPrerequisites,
	resolveShopifyE2EConfig,
} from "../shopify-e2e-config.js";
import { validateShopifySession } from "../shopify-session.js";

export default async function globalSetup(_config: unknown): Promise<void> {
	if (process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP === "1") {
		return;
	}

	const config = await resolveShopifyE2EConfig();

	if (!config.live) {
		return;
	}

	if (missingLiveShopifyPrerequisites(config).length > 0) {
		return;
	}

	await validateShopifySession(config);
}
