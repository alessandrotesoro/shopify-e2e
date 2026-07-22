import type { Locator, Page, Response } from "@playwright/test";

import { configuredOriginFromEnvironment } from "../role-states/configured-origin.cjs";
import { typeLikeHuman } from "./type-like-human.cjs";

const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';
const FORM_SELECTOR = "form";

const hasConfiguredOrigin = (page: Page, configuredOrigin: string): boolean => {
	try {
		return new URL(page.url()).origin === configuredOrigin;
	} catch {
		return false;
	}
};

const isSuccessfulResponse = (response: Response | null): boolean => {
	try {
		return response?.ok() === true;
	} catch {
		return false;
	}
};

const storefrontError = (message: string): Error => new Error(message);

class UnsafePasswordChallengeError extends Error {
	constructor() {
		super(
			"The storefront password challenge is not in the expected safe form.",
		);
	}
}

const unsafePasswordChallenge = (): Error => new UnsafePasswordChallengeError();

export const openStorefront = async (page: Page): Promise<void> => {
	const configuredOrigin = configuredOriginFromEnvironment(process.env);

	let response: Response | null;
	try {
		response = await page.goto(configuredOrigin, {
			waitUntil: "domcontentloaded",
		});
	} catch {
		throw storefrontError(
			"Could not open the configured Shopify storefront. Check that the store is reachable and try again.",
		);
	}

	if (!isSuccessfulResponse(response)) {
		throw storefrontError(
			"The configured Shopify storefront did not return a successful page response.",
		);
	}
	if (!hasConfiguredOrigin(page, configuredOrigin)) {
		throw storefrontError(
			"The Shopify storefront redirected outside the configured store origin.",
		);
	}
};

interface PasswordChallenge {
	readonly form: Locator;
	readonly input: Locator;
}

const inspectPasswordChallenge = async (
	page: Page,
	configuredOrigin: string,
): Promise<PasswordChallenge | null> => {
	const passwordInputs = page.locator(PASSWORD_INPUT_SELECTOR);
	const forms = page.locator(FORM_SELECTOR);
	const [passwordInputCount, formCount] = await Promise.all([
		passwordInputs.count(),
		forms.count(),
	]);

	if (passwordInputCount === 0 && formCount === 0) return null;
	if (passwordInputCount > 1) {
		throw unsafePasswordChallenge();
	}

	const inspectedForms: Array<{
		readonly destination?: URL;
		readonly form: Locator;
		readonly method: string | null;
		readonly nestedCount: number;
		readonly visible: boolean;
	}> = [];
	for (let index = 0; index < formCount; index += 1) {
		const form = forms.nth(index);
		const [method, action, visible, nestedCount] = await Promise.all([
			form.getAttribute("method"),
			form.getAttribute("action"),
			form.isVisible(),
			form.locator(PASSWORD_INPUT_SELECTOR).count(),
		]);
		let destination: URL | undefined;
		try {
			if (action !== null) destination = new URL(action, page.url());
		} catch {
			// The common safe error below intentionally omits the untrusted action.
		}
		inspectedForms.push({ destination, form, method, nestedCount, visible });
	}

	const challengeForms = inspectedForms.filter(
		(candidate) => candidate.nestedCount > 0,
	);
	if (passwordInputCount === 0 && challengeForms.length === 0) {
		const hasIncompletePasswordForm = inspectedForms.some(
			(candidate) => candidate.destination?.pathname === "/password",
		);
		if (!hasIncompletePasswordForm) return null;
	}
	if (passwordInputCount !== 1 || challengeForms.length !== 1) {
		throw unsafePasswordChallenge();
	}

	const challengeForm = challengeForms[0];
	if (challengeForm === undefined) {
		throw unsafePasswordChallenge();
	}
	const input = passwordInputs.nth(0);
	const [inputVisible, inputEnabled] = await Promise.all([
		input.isVisible(),
		input.isEnabled(),
	]);

	if (
		challengeForm.method?.toUpperCase() !== "POST" ||
		challengeForm.destination?.href !== `${configuredOrigin}/password` ||
		!challengeForm.visible ||
		!inputVisible ||
		!inputEnabled ||
		challengeForm.nestedCount !== 1
	) {
		throw unsafePasswordChallenge();
	}

	return { form: challengeForm.form, input };
};

export const unlockStorefront = async (page: Page): Promise<void> => {
	const configuredOrigin = configuredOriginFromEnvironment(process.env);

	try {
		await page.waitForLoadState("domcontentloaded");
	} catch {
		throw storefrontError(
			"The Shopify storefront did not become ready for password inspection.",
		);
	}
	if (!hasConfiguredOrigin(page, configuredOrigin)) {
		throw storefrontError(
			"Refusing to inspect a storefront password challenge outside the configured store origin.",
		);
	}

	let challenge: PasswordChallenge | null;
	try {
		challenge = await inspectPasswordChallenge(page, configuredOrigin);
	} catch (error) {
		if (error instanceof UnsafePasswordChallengeError) {
			throw error;
		}
		throw storefrontError(
			"The storefront password challenge could not be inspected safely.",
		);
	}
	if (challenge === null) return;

	const password = process.env.SHOPIFY_STOREFRONT_PASSWORD;
	if (!password || password.trim().length === 0) {
		throw storefrontError(
			"SHOPIFY_STOREFRONT_PASSWORD is required when the configured storefront is password protected.",
		);
	}

	let response: Response | null;
	try {
		[, response] = await Promise.all([
			typeLikeHuman(challenge.input, password).then(() =>
				challenge.form.evaluate((form) => {
					(form as HTMLFormElement).requestSubmit();
				}),
			),
			page.waitForNavigation({ waitUntil: "domcontentloaded" }),
		]);
	} catch {
		throw storefrontError(
			"The storefront password challenge could not be submitted successfully.",
		);
	}

	if (!isSuccessfulResponse(response)) {
		throw storefrontError(
			"The storefront password submission did not return a successful page response.",
		);
	}
	if (!hasConfiguredOrigin(page, configuredOrigin)) {
		throw storefrontError(
			"The storefront password submission redirected outside the configured store origin.",
		);
	}

	let remainingChallenge: PasswordChallenge | null;
	try {
		remainingChallenge = await inspectPasswordChallenge(page, configuredOrigin);
	} catch {
		throw storefrontError(
			"The storefront unlock result could not be verified safely.",
		);
	}
	if (remainingChallenge !== null) {
		throw storefrontError(
			"The storefront password submission did not unlock the store.",
		);
	}
};
