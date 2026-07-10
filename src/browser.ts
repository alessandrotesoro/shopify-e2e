import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import type { ResolvedShopifyE2EConfig } from "./shopify-e2e-config.js";
import { devtoolsVersionUrl } from "./urls.js";

export interface EnsureChromeResult {
	cdpUrl: string;
	chromePath?: string;
	profilePath: string;
	started: boolean;
}

export interface FetchLikeResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export type FetchLike = (
	input: string,
	init?: { signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export function isLoopbackCdpUrl(cdpUrl: string): boolean {
	try {
		const url = new URL(cdpUrl);
		const hostname = url.hostname.replace(/^\[|\]$/g, "");

		return (
			["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
			(hostname === "localhost" ||
				hostname === "::1" ||
				isLoopbackIpv4(hostname))
		);
	} catch {
		return false;
	}
}

function isLoopbackIpv4(hostname: string): boolean {
	const octets = hostname.split(".");

	return (
		octets.length === 4 &&
		octets[0] === "127" &&
		octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
	);
}

export function assertLoopbackCdpUrl(cdpUrl: string): void {
	if (!isLoopbackCdpUrl(cdpUrl)) {
		throw new Error(
			`Shopify auth profiles require a loopback CDP URL; received ${cdpUrl}.`,
		);
	}
}

export async function ensureChrome(
	config: ResolvedShopifyE2EConfig,
	startUrl: string,
	options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<EnsureChromeResult> {
	const fetchImpl = options.fetch ?? fetch;

	if (await isCdpReachable(config.cdpUrl, { fetch: fetchImpl })) {
		return {
			cdpUrl: config.cdpUrl,
			profilePath: config.chromeProfilePath,
			started: false,
		};
	}

	const chromePath = findChromeExecutable(config);

	if (!chromePath) {
		throw new Error(
			"Google Chrome was not found. Set SHOPIFY_E2E_CHROME_PATH to the Chrome executable.",
		);
	}

	mkdirSync(config.chromeProfilePath, { recursive: true });

	const child = spawn(
		chromePath,
		[
			`--remote-debugging-port=${config.cdpPort}`,
			`--user-data-dir=${config.chromeProfilePath}`,
			"--no-first-run",
			"--no-default-browser-check",
			startUrl,
		],
		{
			detached: true,
			stdio: "ignore",
		},
	);

	child.unref();

	await waitForChromeLaunch({
		cdpUrl: config.cdpUrl,
		child,
		fetch: fetchImpl,
		chromePath,
		timeoutMs: options.timeoutMs ?? 10_000,
	});

	return {
		cdpUrl: config.cdpUrl,
		chromePath,
		profilePath: config.chromeProfilePath,
		started: true,
	};
}

export async function waitForCdp(
	cdpUrl: string,
	options: {
		fetch?: FetchLike;
		intervalMs?: number;
		timeoutMs?: number;
	} = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 250;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await isCdpReachable(cdpUrl, { fetch: options.fetch })) {
			return;
		}

		await delay(intervalMs);
	}

	throw new Error(`Chrome CDP was not reachable at ${cdpUrl}.`);
}

interface WaitForChromeLaunchArgs {
	cdpUrl: string;
	child: ChildProcess;
	chromePath: string;
	fetch: FetchLike;
	timeoutMs: number;
}

async function waitForChromeLaunch({
	cdpUrl,
	child,
	chromePath,
	fetch,
	timeoutMs,
}: WaitForChromeLaunchArgs): Promise<void> {
	let cleanup = () => undefined;
	const launchFailure = new Promise<Error>((resolve) => {
		const onError = (error: Error) => {
			resolve(
				new Error(
					`Could not start Chrome at ${chromePath}: ${error.message}`,
					{
						cause: error,
					},
				),
			);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const reason =
				typeof code === "number"
					? `exit code ${code}`
					: `signal ${signal ?? "unknown"}`;

			resolve(
				new Error(
					`Chrome at ${chromePath} exited before CDP became reachable (${reason}).`,
				),
			);
		};

		child.once("error", onError);
		child.once("exit", onExit);
		cleanup = () => {
			child.off("error", onError);
			child.off("exit", onExit);
		};
	});

	let result: Error | undefined;

	try {
		result = await Promise.race([
			waitForCdp(cdpUrl, { fetch, timeoutMs }).then(() => undefined),
			launchFailure,
		]);
	} finally {
		cleanup();
	}

	if (result instanceof Error) {
		throw result;
	}
}

export async function isCdpReachable(
	cdpUrl: string,
	options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<boolean> {
	try {
		const response = await fetchWithTimeout(devtoolsVersionUrl(cdpUrl), {
			fetch: options.fetch,
			timeoutMs: options.timeoutMs ?? 2_500,
		});

		return response.ok;
	} catch {
		return false;
	}
}

export async function fetchWithTimeout(
	url: string,
	options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<FetchLikeResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 2_500,
	);

	try {
		return await (options.fetch ?? fetch)(url, {
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

export function findChromeExecutable(
	config: Pick<ResolvedShopifyE2EConfig, "chromeExecutablePath">,
): string | undefined {
	return chromeCandidates(config).find((candidate) => existsSync(candidate));
}

export function chromeCandidates(
	config: Pick<ResolvedShopifyE2EConfig, "chromeExecutablePath">,
): string[] {
	const candidates = [
		config.chromeExecutablePath,
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		windowsChromePath(
			"PROGRAMFILES",
			"Google/Chrome/Application/chrome.exe",
		),
		windowsChromePath(
			"PROGRAMFILES(X86)",
			"Google/Chrome/Application/chrome.exe",
		),
		windowsChromePath(
			"LOCALAPPDATA",
			"Google/Chrome/Application/chrome.exe",
		),
	].filter((candidate): candidate is string => Boolean(candidate));

	return [...new Set(candidates)];
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) =>
		setTimeout(resolveDelay, milliseconds),
	);
}

function windowsChromePath(
	envName: string,
	suffix: string,
): string | undefined {
	const base = process.env[envName];

	return base ? `${base}/${suffix}` : undefined;
}
