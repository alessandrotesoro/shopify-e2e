import type { ElementHandle, Locator, Page, Response } from "@playwright/test";

import { configuredOriginFromEnvironment } from "../role-states/configured-origin.js";
import { type TypeLikeHumanOptions, typeLikeHuman } from "./type-like-human.js";

const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';
const FORM_SELECTOR = "form";

interface HasConfiguredOriginArgs {
	page: Page;
	configuredOrigin: string;
}

const hasConfiguredOrigin = ({
	page,
	configuredOrigin,
}: HasConfiguredOriginArgs): boolean => {
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
	if (!hasConfiguredOrigin({ page, configuredOrigin })) {
		throw storefrontError(
			"The Shopify storefront redirected outside the configured store origin.",
		);
	}
};

interface PasswordChallenge {
	readonly form: ElementHandle<HTMLFormElement>;
	readonly input: ElementHandle<HTMLInputElement>;
}

const disposeChallenge = async (
	challenge: PasswordChallenge,
): Promise<void> => {
	await Promise.allSettled([
		challenge.form.dispose(),
		challenge.input.dispose(),
	]);
};

interface SameElementArgs<T extends Node> {
	left: ElementHandle<T>;
	right: ElementHandle<T>;
}

const sameElement = async <T extends Node>({
	left,
	right,
}: SameElementArgs<T>): Promise<boolean> => {
	try {
		return await left.evaluate(
			(element, candidate) => element === candidate,
			right,
		);
	} catch {
		return false;
	}
};

interface InspectPasswordChallengeArgs {
	page: Page;
	configuredOrigin: string;
}

const inspectPasswordChallenge = async ({
	page,
	configuredOrigin,
}: InspectPasswordChallengeArgs): Promise<PasswordChallenge | null> => {
	const rawPasswordInputs = await page
		.locator(PASSWORD_INPUT_SELECTOR)
		.elementHandles();
	let rawForms: ElementHandle<Node>[];
	try {
		rawForms = await page.locator(FORM_SELECTOR).elementHandles();
	} catch (error) {
		await Promise.allSettled(rawPasswordInputs.map((input) => input.dispose()));
		throw error;
	}
	const passwordInputs = rawPasswordInputs as ElementHandle<HTMLInputElement>[];
	const forms = rawForms as ElementHandle<HTMLFormElement>[];
	const passwordInputCount = passwordInputs.length;
	const formCount = forms.length;
	let retainedChallenge: PasswordChallenge | undefined;

	try {
		if (passwordInputCount === 0 && formCount === 0) return null;
		if (passwordInputCount > 1) {
			throw unsafePasswordChallenge();
		}

		const inspectedForms: Array<{
			readonly destination?: URL;
			readonly form: ElementHandle<HTMLFormElement>;
			readonly method: string | null;
			readonly nestedCount: number;
			readonly visible: boolean;
		}> = [];
		for (let index = 0; index < formCount; index += 1) {
			const form = forms[index];
			if (form === undefined) throw unsafePasswordChallenge();
			const nestedInputs = await form.$$(PASSWORD_INPUT_SELECTOR);
			let method: string | null;
			let action: string | null;
			let isVisible: boolean;
			let isConnected: boolean;
			try {
				[method, action, isVisible, isConnected] = await Promise.all([
					form.getAttribute("method"),
					form.getAttribute("action"),
					form.isVisible(),
					form.evaluate((element) => element.isConnected),
				]);
			} finally {
				await Promise.allSettled(nestedInputs.map((input) => input.dispose()));
			}
			const nestedCount = nestedInputs.length;
			let destination: URL | undefined;
			try {
				if (action !== null) destination = new URL(action, page.url());
			} catch {
				// The common safe error below intentionally omits the untrusted action.
			}
			inspectedForms.push({
				destination,
				form,
				method,
				nestedCount,
				visible: isVisible && isConnected,
			});
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
		const input = passwordInputs[0];
		if (input === undefined) throw unsafePasswordChallenge();
		const [inputVisible, inputEnabled, inputConnected, formContainsInput] =
			await Promise.all([
				input.isVisible(),
				input.isEnabled(),
				input.evaluate((element) => element.isConnected),
				challengeForm.form.evaluate(
					(form, passwordInput) => form.contains(passwordInput),
					input,
				),
			]);

		if (
			challengeForm.method?.toUpperCase() !== "POST" ||
			challengeForm.destination?.href !== `${configuredOrigin}/password` ||
			!challengeForm.visible ||
			!inputVisible ||
			!inputEnabled ||
			!inputConnected ||
			!formContainsInput ||
			challengeForm.nestedCount !== 1
		) {
			throw unsafePasswordChallenge();
		}

		retainedChallenge = { form: challengeForm.form, input };
		return retainedChallenge;
	} finally {
		await Promise.allSettled(
			[...forms, ...passwordInputs]
				.filter(
					(handle) =>
						handle !== retainedChallenge?.form &&
						handle !== retainedChallenge?.input,
				)
				.map((handle) => handle.dispose()),
		);
	}
};

interface VerifyPinnedChallengeArgs {
	page: Page;
	configuredOrigin: string;
	pinned: PasswordChallenge;
}

const verifyPinnedChallenge = async ({
	page,
	configuredOrigin,
	pinned,
}: VerifyPinnedChallengeArgs): Promise<boolean> => {
	if (!hasConfiguredOrigin({ page, configuredOrigin })) return false;

	let current: PasswordChallenge | null;
	try {
		current = await inspectPasswordChallenge({ page, configuredOrigin });
	} catch {
		return false;
	}
	if (current === null) return false;

	try {
		const [sameForm, sameInput] = await Promise.all([
			sameElement({ left: pinned.form, right: current.form }),
			sameElement({ left: pinned.input, right: current.input }),
		]);
		return sameForm && sameInput;
	} finally {
		await disposeChallenge(current);
	}
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
	if (!hasConfiguredOrigin({ page, configuredOrigin })) {
		throw storefrontError(
			"Refusing to inspect a storefront password challenge outside the configured store origin.",
		);
	}

	let challenge: PasswordChallenge | null;
	try {
		challenge = await inspectPasswordChallenge({ page, configuredOrigin });
	} catch (error) {
		if (error instanceof UnsafePasswordChallengeError) {
			throw error;
		}
		throw storefrontError(
			"The storefront password challenge could not be inspected safely.",
		);
	}
	if (challenge === null) return;
	if (
		!(await verifyPinnedChallenge({
			page,
			configuredOrigin,
			pinned: challenge,
		}))
	) {
		await disposeChallenge(challenge);
		throw unsafePasswordChallenge();
	}

	const password = process.env.SHOPIFY_STOREFRONT_PASSWORD;
	if (!password || password.trim().length === 0) {
		await disposeChallenge(challenge);
		throw storefrontError(
			"SHOPIFY_STOREFRONT_PASSWORD is required when the configured storefront is password protected.",
		);
	}

	let response: Response | null;
	try {
		const pinnedInput = {
			pressSequentially: (text: string, options?: TypeLikeHumanOptions) =>
				challenge.input.type(text, options),
		} as Locator;
		[, response] = await Promise.all([
			typeLikeHuman(pinnedInput, password).then(() =>
				challenge.form.evaluate(
					(form, submission) => {
						const { configuredOrigin, input } = submission;
						if (
							form.ownerDocument.location.origin !== configuredOrigin ||
							!form.isConnected ||
							!input.isConnected ||
							!form.contains(input) ||
							form.method.toUpperCase() !== "POST" ||
							form.action !== `${configuredOrigin}/password`
						) {
							throw new Error("Unsafe storefront password form");
						}
						form.requestSubmit();
					},
					{ configuredOrigin, input: challenge.input },
				),
			),
			page.waitForNavigation({ waitUntil: "domcontentloaded" }),
		]);
	} catch {
		throw storefrontError(
			"The storefront password challenge could not be submitted successfully.",
		);
	} finally {
		await disposeChallenge(challenge);
	}

	if (!isSuccessfulResponse(response)) {
		throw storefrontError(
			"The storefront password submission did not return a successful page response.",
		);
	}
	if (!hasConfiguredOrigin({ page, configuredOrigin })) {
		throw storefrontError(
			"The storefront password submission redirected outside the configured store origin.",
		);
	}

	let remainingChallenge: PasswordChallenge | null;
	try {
		remainingChallenge = await inspectPasswordChallenge({
			page,
			configuredOrigin,
		});
	} catch {
		throw storefrontError(
			"The storefront unlock result could not be verified safely.",
		);
	}
	if (remainingChallenge !== null) {
		await disposeChallenge(remainingChallenge);
		throw storefrontError(
			"The storefront password submission did not unlock the store.",
		);
	}
};
