import { loadAuthProfile } from "./auth-profile.js";
import {
	findChromeExecutable,
	isCdpReachable,
	isLoopbackCdpUrl,
} from "./browser.js";
import {
	missingLiveShopifyPrerequisites,
	type ResolvedShopifyE2EConfig,
} from "./shopify-e2e-config.js";
import { prepareShopifySession } from "./shopify-session.js";
import { buildTestCommand } from "./test-runner.js";
import { isShopifyAdminUrl, isShopifyLoginUrl } from "./urls.js";

export type DoctorStatus = "fail" | "pass" | "warn";

export interface DoctorCheck {
	message: string;
	name: string;
	status: DoctorStatus;
}

export async function runDoctor(
	config: ResolvedShopifyE2EConfig,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const missing = missingLiveShopifyPrerequisites(config);
	const command = buildTestCommand(config);
	const loopback = isLoopbackCdpUrl(config.cdpUrl);
	const displayedCdpUrl = displayCdpUrl(config.cdpUrl);

	checks.push({
		message:
			missing.length === 0
				? "Required live config is present."
				: `Missing: ${missing.join(", ")}`,
		name: "config",
		status: missing.length === 0 ? "pass" : "fail",
	});
	checks.push({
		message: loopback
			? `CDP endpoint ${displayedCdpUrl} is loopback-only.`
			: `Unsafe CDP endpoint ${displayedCdpUrl}; auth profiles require loopback CDP.`,
		name: "cdp-safety",
		status: loopback ? "pass" : "fail",
	});
	checks.push({
		message: command.forcedWorkers
			? "Playwright runner will force --workers=1."
			: "Playwright runner is not serial.",
		name: "test-runner",
		status: command.forcedWorkers ? "pass" : "fail",
	});

	if (!loopback) {
		return checks;
	}

	try {
		await loadAuthProfile(config.authProfile);
		checks.push({
			message: `Selected auth profile ${JSON.stringify(config.authProfile.name)} is valid at ${config.authProfile.storageStatePath}.`,
			name: "auth-profile",
			status: "pass",
		});
	} catch (error) {
		checks.push({
			message: errorMessage(error),
			name: "auth-profile",
			status: "fail",
		});

		return checks;
	}

	const cdpReachable = await isCdpReachable(config.cdpUrl);
	const chromePath = findChromeExecutable(config);
	checks.push({
		message: cdpReachable
			? `Chrome CDP is reachable at ${displayedCdpUrl}.`
			: `Chrome CDP is not reachable at ${displayedCdpUrl}.`,
		name: "cdp",
		status: cdpReachable ? "pass" : "warn",
	});
	checks.push({
		message: chromePath
			? `Chrome executable found at ${chromePath}.`
			: "Chrome executable was not found.",
		name: "chrome",
		status: cdpReachable || chromePath ? "pass" : "fail",
	});

	if (!cdpReachable || !config.shopDomain) {
		return checks;
	}

	let session: Awaited<ReturnType<typeof prepareShopifySession>>;

	try {
		session = await prepareShopifySession(config, {
			waitForLogin: false,
		});
	} catch (error) {
		checks.push({
			message: `Could not probe selected auth profile ${JSON.stringify(config.authProfile.name)} in isolation: ${errorMessage(error)}`,
			name: "shopify-session",
			status: "warn",
		});

		return checks;
	}

	try {
		const currentUrl = session.page.url();
		const ready =
			isShopifyAdminUrl(currentUrl, config.shopDomain) &&
			!isShopifyLoginUrl(currentUrl);
		checks.push({
			message: ready
				? `Selected auth profile ${JSON.stringify(config.authProfile.name)} has a ready isolated Shopify Admin session.`
				: `Selected auth profile ${JSON.stringify(config.authProfile.name)} is stale or requires Shopify Admin login.`,
			name: "shopify-session",
			status: ready ? "pass" : "warn",
		});
	} finally {
		await session.close();
	}

	return checks;
}

export function hasFailingDoctorChecks(checks: DoctorCheck[]): boolean {
	return checks.some((check) => check.status === "fail");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function displayCdpUrl(cdpUrl: string): string {
	try {
		const url = new URL(cdpUrl);

		return `${url.protocol}//${url.host}`;
	} catch {
		return "[invalid CDP URL]";
	}
}
