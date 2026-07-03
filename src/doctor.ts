import { existsSync } from "node:fs";

import { findChromeExecutable, isCdpReachable } from "./browser.js";
import {
	missingLiveShopifyPrerequisites,
	type ResolvedShopifyE2EConfig,
} from "./config.js";
import { buildTestCommand } from "./test-runner.js";
import { inspectShopifySession } from "./shopify-session.js";

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
	const chromePath = findChromeExecutable(config);
	const cdpReachable = await isCdpReachable(config.cdpUrl);
	const command = buildTestCommand(config);

	checks.push({
		message:
			missing.length === 0
				? "Required live config is present."
				: `Missing: ${missing.join(", ")}`,
		name: "config",
		status: missing.length === 0 ? "pass" : "fail",
	});

	checks.push({
		message: chromePath
			? `Chrome executable found at ${chromePath}.`
			: "Chrome executable was not found.",
		name: "chrome",
		status: chromePath ? "pass" : "fail",
	});

	checks.push({
		message: cdpReachable
			? `Chrome CDP is reachable at ${config.cdpUrl}.`
			: `Chrome CDP is not reachable at ${config.cdpUrl}.`,
		name: "cdp",
		status: cdpReachable ? "pass" : "warn",
	});

	checks.push({
		message: existsSync(config.authStatePath)
			? `Auth state exists at ${config.authStatePath}.`
			: `No auth state found at ${config.authStatePath}.`,
		name: "auth-state",
		status: existsSync(config.authStatePath) ? "pass" : "warn",
	});

	checks.push({
		message: command.forcedWorkers
			? "Default Playwright runner will force --workers=1."
			: command.warnings.join(" "),
		name: "test-runner",
		status: command.forcedWorkers ? "pass" : "warn",
	});

	if (cdpReachable) {
		const inspection = await inspectShopifySession(config);

		checks.push({
			message:
				inspection.state === "ready"
					? "A Shopify Admin tab is ready."
					: (inspection.reason ?? "Shopify Admin tab is not ready."),
			name: "shopify-session",
			status: inspection.state === "ready" ? "pass" : "warn",
		});
	}

	return checks;
}

export function hasFailingDoctorChecks(checks: DoctorCheck[]): boolean {
	return checks.some((check) => check.status === "fail");
}
