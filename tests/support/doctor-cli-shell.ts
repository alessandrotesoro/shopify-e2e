import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DoctorReadyConsumer {
	readonly consumer: string;
	readonly importSentinels: readonly string[];
	readonly launchSentinel: string;
}

interface ChildOutcome {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

export const prepareDoctorReadyConsumer = async (
	consumer: string,
): Promise<DoctorReadyConsumer> => {
	const peerRoot = join(consumer, "node_modules", "@playwright", "test");
	const chromiumPath = join(peerRoot, "chromium");
	const launchSentinel = join(consumer, "doctor-browser-launched");
	const importSentinels = [
		join(consumer, "ordinary-config-imported"),
		join(consumer, "ordinary-spec-imported"),
		join(consumer, "shopify-spec-imported"),
	] as const;
	await mkdir(peerRoot, { recursive: true });
	await writeFile(chromiumPath, "fake chromium\n");
	await writeFile(join(peerRoot, "cli.js"), "// fake Playwright CLI\n");
	await writeFile(
		join(peerRoot, "index.js"),
		`import { writeFileSync } from "node:fs"; export const chromium = { executablePath() { return ${JSON.stringify(chromiumPath)}; }, launch() { writeFileSync(${JSON.stringify(launchSentinel)}, "launched"); throw new Error("doctor must not launch Chromium"); } };\n`,
	);
	await writeFile(
		join(peerRoot, "package.json"),
		`${JSON.stringify({
			bin: { playwright: "cli.js" },
			exports: {
				".": "./index.js",
				"./package.json": "./package.json",
			},
			name: "@playwright/test",
			type: "module",
			version: "1.61.1",
		})}\n`,
	);
	await writeFile(
		join(consumer, "playwright.config.ts"),
		`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(importSentinels[0])}, "imported"); export default {};\n`,
	);
	await writeFile(
		join(consumer, "ordinary.spec.ts"),
		`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(importSentinels[1])}, "imported");\n`,
	);
	await writeFile(
		join(consumer, "shopify-tests", "checkout.spec.ts"),
		`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(importSentinels[2])}, "imported");\n`,
	);
	return { consumer, importSentinels, launchSentinel };
};

export const waitForPath = async (
	path: string,
	timeoutMs: number,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for ${path}`);
};

export const waitForChildOutcome = (
	child: ChildProcess,
	timeoutMs: number,
): Promise<ChildOutcome> => {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}

	return new Promise<ChildOutcome>((resolveOutcome, rejectOutcome) => {
		const cleanup = (): void => {
			clearTimeout(timeout);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectOutcome(error);
		};
		const onExit = (
			code: number | null,
			signal: NodeJS.Signals | null,
		): void => {
			cleanup();
			resolveOutcome({ code, signal });
		};
		const timeout = setTimeout(() => {
			cleanup();
			rejectOutcome(
				new Error(`CLI process ${child.pid ?? "unknown"} remained alive`),
			);
		}, timeoutMs);
		child.once("error", onError);
		child.once("exit", onExit);
	});
};
