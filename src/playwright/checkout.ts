import type { Frame, Locator, Page } from "playwright-core";
import { delay } from "../browser.js";
import {
	clickFirstVisibleButton,
	fillFirstVisible,
	firstUsableLocator,
	isUsable,
	type SlowInputOptions,
	selectFirstVisible,
	slowFill,
} from "./inputs.js";
import {
	isStorefrontPasswordPage,
	type ShopifyCheckoutBuyer,
} from "./storefront.js";

export interface ShopifyCheckoutPayment {
	cardNumber?: string;
	expiry?: string;
	name?: string;
	securityCode?: string;
}

export interface CompleteShopifyCheckoutOptions extends SlowInputOptions {
	buyer?: ShopifyCheckoutBuyer;
	maxSteps?: number;
	page: Page;
	payment?: ShopifyCheckoutPayment;
	phaseReporter?: ShopifyCheckoutPhaseReporter;
	thankYouTimeoutMs?: number;
}

export type ShopifyCheckoutPhase =
	| "checkout.entry"
	| "checkout.customer"
	| "checkout.shipping"
	| "checkout.payment"
	| "checkout.submit"
	| "checkout.thank_you";

export interface ShopifyCheckoutPhaseTiming {
	durationMs: number;
	phase: ShopifyCheckoutPhase;
}

export type ShopifyCheckoutPhaseReporter = (
	timing: ShopifyCheckoutPhaseTiming,
) => void;

export interface ShopifyCheckoutDiagnostics {
	usedPaymentFrameFallback: boolean;
}

export interface ShopifyCheckoutCompletion {
	diagnostics: ShopifyCheckoutDiagnostics;
	submitted: boolean;
	timings: ShopifyCheckoutPhaseTiming[];
}

interface PaymentInputTarget {
	fieldName: string;
	frameSelectors: string[];
	frameUrlIncludes: string[];
	labels: RegExp[];
	required: boolean;
	selectors: string[];
}

export interface PaymentFillResult {
	filled: boolean;
	missingField?: string;
	sawPaymentForm: boolean;
	usedFallback: boolean;
}

interface CheckoutRunContext {
	result: ShopifyCheckoutCompletion;
}

type FrameLocatorLike = ReturnType<Page["frameLocator"]>;
type CheckoutProgressOutcome = "navigation" | "thank_you" | "validation";

interface CheckoutProgressResult {
	durationMs: number;
	outcome: CheckoutProgressOutcome;
}

interface PaymentFrameLocatorResult {
	filled: boolean;
	frames: readonly Frame[] | null;
}

const defaultMaxSteps = 8;
const defaultThankYouTimeoutMs = 45_000;
const fieldReadyTimeoutMs = 1_500;
const fieldReadyPollMs = 50;
const progressTimeoutMs = 15_000;
const thankYouCopyPattern =
	/thank you|order confirmed|your order is confirmed/i;
const checkoutValidationPattern =
	/card was declined|declined|invalid|(?<!payment )is required|(?<!payments )are required|can't be blank|enter a valid|there was a problem|could not process|try a different card/i;

export async function completeShopifyCheckout(
	options: CompleteShopifyCheckoutOptions,
): Promise<ShopifyCheckoutCompletion> {
	const { page } = options;

	if (isStorefrontPasswordPage(page.url())) {
		throw new Error(
			"Checkout was blocked by the storefront password page. Set SHOPIFY_E2E_STOREFRONT_PASSWORD in your test environment.",
		);
	}

	const context: CheckoutRunContext = {
		result: {
			diagnostics: {
				usedPaymentFrameFallback: false,
			},
			submitted: false,
			timings: [],
		},
	};

	for (
		let step = 0;
		step < (options.maxSteps ?? defaultMaxSteps);
		step += 1
	) {
		if (await finishIfCheckoutComplete(page, context, options)) {
			return context.result;
		}

		await recordPhase(context, options, "checkout.customer", async () => {
			await fillShopifyCustomerFields(page, options.buyer, options);
		});

		if (await finishIfCheckoutComplete(page, context, options)) {
			return context.result;
		}

		await recordPhase(context, options, "checkout.shipping", async () => {
			await fillShopifyShippingFields(page, options.buyer, options);
		});

		if (await finishIfCheckoutComplete(page, context, options)) {
			return context.result;
		}

		const paymentResult = await recordPhase(
			context,
			options,
			"checkout.payment",
			async () =>
				fillShopifyPaymentFields(page, options.payment, options),
		);
		context.result.diagnostics.usedPaymentFrameFallback ||=
			paymentResult.usedFallback;
		const wasPaymentStep =
			paymentResult.filled || paymentResult.sawPaymentForm;

		if (await finishIfCheckoutComplete(page, context, options)) {
			return context.result;
		}

		const preSubmitUrl = page.url();
		const clicked = await recordPhase(
			context,
			options,
			"checkout.submit",
			async () => submitCheckoutStep(page, options),
		);
		context.result.submitted ||= clicked;

		const progress = await waitForCheckoutProgress(page, preSubmitUrl);

		if (progress.outcome === "thank_you") {
			appendPhaseTiming(
				context,
				options,
				"checkout.thank_you",
				progress.durationMs,
			);
		}

		if (progress.outcome === "validation") {
			await throwIfCheckoutValidationVisible(page);
		}

		if (progress.outcome === "navigation" && wasPaymentStep) {
			await waitForThankYouPhase(page, context, options);

			return context.result;
		}

		if (await finishIfCheckoutComplete(page, context, options)) {
			return context.result;
		}
	}

	await waitForThankYouPhase(page, context, options);

	return context.result;
}

export async function fillShopifyCheckoutFields(
	page: Page,
	buyer: ShopifyCheckoutBuyer | undefined,
	options: SlowInputOptions = {},
): Promise<void> {
	await fillShopifyCustomerFields(page, buyer, options);
	await fillShopifyShippingFields(page, buyer, options);
}

export async function fillShopifyCustomerFields(
	page: Page,
	buyer: ShopifyCheckoutBuyer | undefined,
	options: SlowInputOptions = {},
): Promise<void> {
	if (!buyer) {
		return;
	}

	await fillOptionalText(page, emailSelectors(), buyer.email, options);
	await fillOptionalText(
		page,
		firstNameSelectors(),
		buyer.firstName,
		options,
	);
	await fillOptionalText(page, lastNameSelectors(), buyer.lastName, options);
}

export async function fillShopifyShippingFields(
	page: Page,
	buyer: ShopifyCheckoutBuyer | undefined,
	options: SlowInputOptions = {},
): Promise<void> {
	if (!buyer) {
		return;
	}

	await fillOptionalText(page, addressSelectors(), buyer.address1, options);
	await fillOptionalText(page, citySelectors(), buyer.city, options);
	await fillOptionalText(
		page,
		postalCodeSelectors(),
		buyer.postalCode,
		options,
	);
	await fillOptionalText(page, phoneSelectors(), buyer.phone, options);
	await selectOptional(page, countrySelectors(), buyer.countryCode, options);
	await selectOptional(
		page,
		provinceSelectors(),
		buyer.provinceCode,
		options,
	);
}

export async function fillShopifyPaymentFields(
	page: Page,
	payment: ShopifyCheckoutPayment | undefined,
	options: SlowInputOptions = {},
): Promise<PaymentFillResult> {
	const emptyResult = {
		filled: false,
		sawPaymentForm: false,
		usedFallback: false,
	};

	if (!payment?.cardNumber) {
		return emptyResult;
	}

	if (await hasNoPaymentRequired(page)) {
		return { ...emptyResult, sawPaymentForm: true };
	}

	if (await hasSavedPaymentMethod(page, payment)) {
		return { ...emptyResult, sawPaymentForm: true };
	}

	if (!(await hasPaymentFormSignal(page))) {
		return emptyResult;
	}

	const cardNumber = await fillPaymentInput(
		page,
		payment.cardNumber,
		cardNumberTarget(),
		options,
	);
	const expiry = await fillPaymentInput(
		page,
		payment.expiry,
		cardExpiryTarget(),
		options,
	);
	const securityCode = await fillPaymentInput(
		page,
		payment.securityCode,
		cardSecurityCodeTarget(),
		options,
	);
	const name = await fillPaymentInput(
		page,
		payment.name,
		cardNameTarget(),
		options,
	);

	if (cardNumber.filled && expiry.filled && securityCode.filled) {
		return {
			filled: true,
			sawPaymentForm: true,
			usedFallback:
				cardNumber.usedFallback ||
				expiry.usedFallback ||
				securityCode.usedFallback ||
				name.usedFallback,
		};
	}

	const missingFields = [cardNumber, expiry, securityCode]
		.map((result) => result.missingField)
		.filter((field): field is string => Boolean(field));

	if (await isShopifyCheckoutComplete(page)) {
		return emptyResult;
	}

	if (missingFields.length > 0) {
		throw new Error(
			`Payment form is visible, but these required fields could not be filled: ${missingFields.join(", ")}.`,
		);
	}

	throw new Error(
		"Payment form is visible, but the card number, expiry, or security code field could not be filled.",
	);
}

export async function expectShopifyCheckoutComplete(
	page: Page,
	options: { timeoutMs?: number } = {},
): Promise<void> {
	if (await isShopifyCheckoutComplete(page)) {
		return;
	}

	const timeout = options.timeoutMs ?? defaultThankYouTimeoutMs;

	await Promise.any([
		page.waitForURL((url) => isShopifyThankYouUrl(url.toString()), {
			timeout,
		}),
		page
			.getByText(thankYouCopyPattern)
			.first()
			.waitFor({ state: "visible", timeout }),
	]).catch((error) => {
		throw new Error("Shopify checkout Thank You page was not reached.", {
			cause: error,
		});
	});
}

export async function isShopifyCheckoutComplete(page: Page): Promise<boolean> {
	return isShopifyThankYouUrl(page.url()) || (await hasThankYouCopy(page));
}

export function isShopifyThankYouUrl(value: string): boolean {
	try {
		const parsed = new URL(value);

		return (
			parsed.pathname.includes("thank_you") ||
			parsed.pathname.includes("/orders/")
		);
	} catch {
		return false;
	}
}

export function formatCheckoutTimings(
	timings: readonly ShopifyCheckoutPhaseTiming[],
): string {
	if (timings.length === 0) {
		return "none";
	}

	return timings
		.map((timing) => `${timing.phase}=${Math.round(timing.durationMs)}ms`)
		.join(", ");
}

async function recordPhase<T>(
	context: CheckoutRunContext,
	options: CompleteShopifyCheckoutOptions,
	phase: ShopifyCheckoutPhase,
	callback: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	const result = await callback();
	const timing = {
		durationMs: performance.now() - startedAt,
		phase,
	};

	context.result.timings.push(timing);
	options.phaseReporter?.(timing);

	return result;
}

function appendPhaseTiming(
	context: CheckoutRunContext,
	options: CompleteShopifyCheckoutOptions,
	phase: ShopifyCheckoutPhase,
	durationMs: number,
): void {
	if (phase === "checkout.thank_you" && hasPhase(context, phase)) {
		return;
	}

	const timing = { durationMs, phase };

	context.result.timings.push(timing);
	options.phaseReporter?.(timing);
}

async function finishIfCheckoutComplete(
	page: Page,
	context: CheckoutRunContext,
	options: CompleteShopifyCheckoutOptions,
): Promise<boolean> {
	if (!(await isShopifyCheckoutComplete(page))) {
		return false;
	}

	recordInstantThankYouIfNeeded(context, options);

	return true;
}

async function waitForThankYouPhase(
	page: Page,
	context: CheckoutRunContext,
	options: CompleteShopifyCheckoutOptions,
): Promise<void> {
	try {
		await recordPhase(context, options, "checkout.thank_you", async () => {
			await expectShopifyCheckoutComplete(page, {
				timeoutMs: options.thankYouTimeoutMs,
			});
		});
	} catch (error) {
		throw new Error(
			`Shopify checkout did not reach Thank You while waiting for checkout.thank_you. Completed phases: ${formatCheckoutTimings(context.result.timings)}.`,
			{ cause: error },
		);
	}
}

function recordInstantThankYouIfNeeded(
	context: CheckoutRunContext,
	options: CompleteShopifyCheckoutOptions,
): void {
	if (
		context.result.timings.length === 0 ||
		hasPhase(context, "checkout.thank_you")
	) {
		return;
	}

	appendPhaseTiming(context, options, "checkout.thank_you", 0);
}

function hasPhase(
	context: CheckoutRunContext,
	phase: ShopifyCheckoutPhase,
): boolean {
	return context.result.timings.some((timing) => timing.phase === phase);
}

async function submitCheckoutStep(
	page: Page,
	options: SlowInputOptions,
): Promise<boolean> {
	const clicked = await clickFirstVisibleButton(
		page,
		checkoutButtonNames(),
		options,
	);

	if (!clicked) {
		await page.keyboard.press("Enter").catch(() => undefined);
	}

	return clicked;
}

async function waitForCheckoutProgress(
	page: Page,
	preSubmitUrl: string,
): Promise<CheckoutProgressResult> {
	const startedAt = performance.now();

	try {
		const outcome = await Promise.any<CheckoutProgressOutcome>([
			page
				.waitForURL(
					(url) =>
						isShopifyThankYouUrl(url.toString()) ||
						url.toString() !== preSubmitUrl,
					{ timeout: progressTimeoutMs },
				)
				.then(() =>
					isShopifyThankYouUrl(page.url())
						? "thank_you"
						: "navigation",
				),
			page
				.getByText(thankYouCopyPattern)
				.first()
				.waitFor({ state: "visible", timeout: progressTimeoutMs })
				.then(() => "thank_you"),
			waitForCheckoutValidation(page, progressTimeoutMs).then(
				() => "validation",
			),
		]);

		return {
			durationMs: performance.now() - startedAt,
			outcome,
		};
	} catch (error) {
		throw new Error(
			"Shopify checkout did not show progress after submit.",
			{
				cause: error,
			},
		);
	}
}

async function fillOptionalText(
	page: Page,
	selectors: string[],
	value: string | undefined,
	options: SlowInputOptions,
): Promise<void> {
	if (!value) {
		return;
	}

	await fillFirstVisible(page, selectors, value, options);
}

async function selectOptional(
	page: Page,
	selectors: string[],
	value: string | undefined,
	options: SlowInputOptions,
): Promise<void> {
	if (!value) {
		return;
	}

	await selectFirstVisible(page, selectors, value, options);
}

async function fillPaymentInput(
	page: Page,
	value: string | undefined,
	target: PaymentInputTarget,
	options: SlowInputOptions,
): Promise<PaymentFillResult> {
	if (!value) {
		return {
			filled: false,
			missingField: target.required ? target.fieldName : undefined,
			sawPaymentForm: true,
			usedFallback: false,
		};
	}

	const pageLocator = await firstUsableLocator(page, target.selectors);

	if (pageLocator) {
		await slowFill(pageLocator, value, options);

		return { filled: true, sawPaymentForm: true, usedFallback: false };
	}

	const frameLocatorResult = await fillPaymentFrameLocator(
		page,
		value,
		target,
		options,
	);

	if (frameLocatorResult.filled) {
		return { filled: true, sawPaymentForm: true, usedFallback: false };
	}

	if (
		await fillPaymentFrameFallback(
			frameLocatorResult.frames ?? [],
			value,
			target,
			options,
		)
	) {
		return { filled: true, sawPaymentForm: true, usedFallback: true };
	}

	if (!target.required) {
		return { filled: false, sawPaymentForm: true, usedFallback: false };
	}

	return {
		filled: false,
		missingField: target.fieldName,
		sawPaymentForm: true,
		usedFallback: false,
	};
}

async function fillPaymentFrameLocator(
	page: Page,
	value: string,
	target: PaymentInputTarget,
	options: SlowInputOptions,
): Promise<PaymentFrameLocatorResult> {
	const locators = target.frameSelectors.flatMap((frameSelector) =>
		frameLocatorInputCandidates(page.frameLocator(frameSelector), target),
	);
	const readyLocator = await readyLocatorInPass(locators);

	if (readyLocator) {
		await slowFill(readyLocator, value, options);

		return { filled: true, frames: null };
	}

	const frames = paymentFrames(page, target);
	const locator =
		frames.length > 0 ? null : await waitForReadyLocator(locators);

	if (!locator) {
		return { filled: false, frames };
	}

	await slowFill(locator, value, options);

	return { filled: true, frames };
}

function frameLocatorInputCandidates(
	frame: FrameLocatorLike,
	target: PaymentInputTarget,
): Locator[] {
	return [
		...target.labels.map((label) =>
			frame.getByRole("textbox", { name: label }).first(),
		),
		...[...target.selectors, "input", "textarea"].map((selector) =>
			frame.locator(selector).first(),
		),
	];
}

async function waitForReadyLocator(
	locators: Locator[],
): Promise<Locator | null> {
	if (locators.length === 0) {
		return null;
	}

	const deadline = Date.now() + fieldReadyTimeoutMs;

	do {
		const locator = await readyLocatorInPass(locators);

		if (locator) {
			return locator;
		}

		const remainingMs = deadline - Date.now();

		if (remainingMs <= 0) {
			break;
		}

		await delay(Math.min(fieldReadyPollMs, remainingMs));
	} while (Date.now() <= deadline);

	return null;
}

async function readyLocatorInPass(
	locators: readonly Locator[],
): Promise<Locator | null> {
	const ready = await Promise.all(
		locators.map((locator) => isUsable(locator)),
	);
	const index = ready.findIndex(Boolean);

	return index === -1 ? null : (locators[index] ?? null);
}

async function fillPaymentFrameFallback(
	frames: readonly Frame[],
	value: string,
	target: PaymentInputTarget,
	options: SlowInputOptions,
): Promise<boolean> {
	for (const frame of frames) {
		const labelled = await firstUsableLabelledTextbox(frame, target.labels);

		if (labelled) {
			await slowFill(labelled, value, options);

			return true;
		}

		const selectorLocator = await firstUsableLocator(
			frame,
			target.selectors,
		);

		if (selectorLocator) {
			await slowFill(selectorLocator, value, options);

			return true;
		}

		const fallbackLocator = await firstUsableLocator(frame, [
			"input",
			"textarea",
		]);

		if (fallbackLocator) {
			await slowFill(fallbackLocator, value, options);

			return true;
		}
	}

	return false;
}

function paymentFrames(page: Page, target: PaymentInputTarget): Frame[] {
	return page.frames().filter((frame) => {
		const url = frame.url().toLowerCase();

		return target.frameUrlIncludes.some((part) => url.includes(part));
	});
}

async function firstUsableLabelledTextbox(
	frame: Frame,
	labels: RegExp[],
): Promise<Locator | null> {
	for (const label of labels) {
		const locator = frame.getByRole("textbox", { name: label }).first();

		if (await isUsable(locator)) {
			return locator;
		}
	}

	return null;
}

async function hasThankYouCopy(page: Page): Promise<boolean> {
	return page
		.getByText(thankYouCopyPattern)
		.first()
		.isVisible()
		.catch(() => false);
}

async function throwIfCheckoutValidationVisible(page: Page): Promise<void> {
	const validation = await visibleCheckoutValidationText(page);

	if (!validation) {
		return;
	}

	throw new Error(`Shopify checkout validation failed: ${validation}`);
}

async function waitForCheckoutValidation(
	page: Page,
	timeout: number,
): Promise<void> {
	await page
		.getByText(checkoutValidationPattern)
		.first()
		.waitFor({ state: "visible", timeout });
}

async function visibleCheckoutValidationText(
	page: Page,
): Promise<string | null> {
	const locator = page.getByText(checkoutValidationPattern).first();

	if (!(await locator.isVisible().catch(() => false))) {
		return null;
	}

	return sanitizeValidationText(await locator.innerText().catch(() => ""));
}

function sanitizeValidationText(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();

	return normalized || "visible checkout validation";
}

async function hasPaymentSection(page: Page): Promise<boolean> {
	return page
		.getByText(/payment|credit card/i)
		.first()
		.isVisible()
		.catch(() => false);
}

async function hasPaymentFormSignal(page: Page): Promise<boolean> {
	return (
		(await hasPaymentSection(page)) || (await hasPaymentIframeElement(page))
	);
}

async function hasNoPaymentRequired(page: Page): Promise<boolean> {
	return page
		.getByText(/no payment is required|order is free/i)
		.first()
		.isVisible()
		.catch(() => false);
}

async function hasPaymentIframeElement(page: Page): Promise<boolean> {
	return page
		.locator(paymentIframeSelector())
		.first()
		.isVisible()
		.catch(() => false);
}

function paymentIframeSelector(): string {
	return [
		'iframe[src*="/number-"]',
		'iframe[src*="/expiry-"]',
		'iframe[src*="/verification_value-"]',
		'iframe[src*="/name-"]',
		'iframe[name*="card" i]',
		'iframe[title*="card" i]',
	].join(", ");
}

async function hasSavedPaymentMethod(
	page: Page,
	payment: ShopifyCheckoutPayment,
): Promise<boolean> {
	const lastFourDigits = payment.cardNumber?.slice(-4);

	if (!lastFourDigits) {
		return false;
	}

	return page
		.getByRole("radio", {
			name: new RegExp(
				`last four digits ${lastFourDigits}|${lastFourDigits}`,
				"i",
			),
		})
		.first()
		.isChecked()
		.catch(() => false);
}

function checkoutButtonNames(): RegExp[] {
	return [
		/pay now/i,
		/complete order/i,
		/review order/i,
		/continue to payment/i,
		/continue to shipping/i,
		/continue to delivery/i,
		/continue/i,
	];
}

function emailSelectors(): string[] {
	return [
		'input[name="email"]',
		'input[type="email"]',
		'input[name="checkout[email]"]',
		'input[id*="email" i]',
	];
}

function firstNameSelectors(): string[] {
	return [
		'input[name="firstName"]',
		'input[name="first_name"]',
		'input[name="checkout[shipping_address][first_name]"]',
		'input[id*="firstName" i]',
	];
}

function lastNameSelectors(): string[] {
	return [
		'input[name="lastName"]',
		'input[name="last_name"]',
		'input[name="checkout[shipping_address][last_name]"]',
		'input[id*="lastName" i]',
	];
}

function addressSelectors(): string[] {
	return [
		'input[name="address1"]',
		'input[name="address_1"]',
		'input[name="checkout[shipping_address][address1]"]',
		'input[autocomplete="shipping address-line1"]',
		'input[id*="address1" i]',
	];
}

function citySelectors(): string[] {
	return [
		'input[name="city"]',
		'input[name="checkout[shipping_address][city]"]',
		'input[autocomplete="shipping address-level2"]',
		'input[id*="city" i]',
	];
}

function countrySelectors(): string[] {
	return [
		'select[name="countryCode"]',
		'select[name="country"]',
		'select[name="checkout[shipping_address][country]"]',
		'select[id*="country" i]',
	];
}

function provinceSelectors(): string[] {
	return [
		'select[name="zone"]',
		'select[name="province"]',
		'select[name="checkout[shipping_address][province]"]',
		'select[id*="province" i]',
		'select[id*="zone" i]',
	];
}

function postalCodeSelectors(): string[] {
	return [
		'input[name="postalCode"]',
		'input[name="zip"]',
		'input[name="checkout[shipping_address][zip]"]',
		'input[autocomplete="shipping postal-code"]',
		'input[id*="postal" i]',
		'input[id*="zip" i]',
	];
}

function phoneSelectors(): string[] {
	return [
		'input[name="phone"]',
		'input[name="checkout[shipping_address][phone]"]',
		'input[type="tel"]',
		'input[id*="phone" i]',
	];
}

function cardNumberSelectors(): string[] {
	return [
		'input[autocomplete="cc-number"]',
		'input[name="card_number"]',
		'input[name="cardNumber"]',
		'input[name="number"]',
		'input[name*="number" i]',
		'input[id*="number" i]',
		'input[aria-label*="card number" i]',
		'input[placeholder*="card number" i]',
	];
}

function cardNumberTarget(): PaymentInputTarget {
	return {
		fieldName: "card number",
		frameSelectors: [
			'iframe[src*="/number-"]',
			'iframe[name*="number" i]',
			'iframe[title*="card number" i]',
		],
		frameUrlIncludes: ["/number-"],
		labels: [/card number/i, /credit card number/i],
		required: true,
		selectors: cardNumberSelectors(),
	};
}

function cardNameSelectors(): string[] {
	return [
		'input[autocomplete="cc-name"]',
		'input[name="name_on_card"]',
		'input[name="cardholder"]',
		'input[name="cardHolder"]',
		'input[id*="name_on_card" i]',
		'input[id*="cardholder" i]',
		'input[aria-label*="name on card" i]',
		'input[placeholder*="name on card" i]',
	];
}

function cardNameTarget(): PaymentInputTarget {
	return {
		fieldName: "name on card",
		frameSelectors: [
			'iframe[src*="/name-"]',
			'iframe[name*="name" i]',
			'iframe[title*="name on card" i]',
		],
		frameUrlIncludes: ["/name-"],
		labels: [/name on card/i, /cardholder/i],
		required: false,
		selectors: cardNameSelectors(),
	};
}

function cardExpirySelectors(): string[] {
	return [
		'input[name="expiry"]',
		'input[name="expiry_date"]',
		'input[autocomplete="cc-exp"]',
		'input[id*="expiry" i]',
		'input[id*="expiration" i]',
		'input[name*="expiry" i]',
		'input[name*="expiration" i]',
		'input[aria-label*="expiration" i]',
		'input[placeholder*="expiration" i]',
	];
}

function cardExpiryTarget(): PaymentInputTarget {
	return {
		fieldName: "expiry",
		frameSelectors: [
			'iframe[src*="/expiry-"]',
			'iframe[name*="expiry" i]',
			'iframe[title*="expiration" i]',
		],
		frameUrlIncludes: ["/expiry-"],
		labels: [/expiration date/i, /expiry date/i],
		required: true,
		selectors: cardExpirySelectors(),
	};
}

function cardSecurityCodeSelectors(): string[] {
	return [
		'input[name="verification_value"]',
		'input[name="security_code"]',
		'input[autocomplete="cc-csc"]',
		'input[id*="verification" i]',
		'input[id*="security" i]',
		'input[id*="cvv" i]',
		'input[name*="verification" i]',
		'input[name*="security" i]',
		'input[name*="cvv" i]',
		'input[aria-label*="security" i]',
		'input[aria-label*="cvv" i]',
		'input[placeholder*="security" i]',
		'input[placeholder*="cvv" i]',
	];
}

function cardSecurityCodeTarget(): PaymentInputTarget {
	return {
		fieldName: "security code",
		frameSelectors: [
			'iframe[src*="/verification_value-"]',
			'iframe[name*="verification" i]',
			'iframe[title*="security" i]',
			'iframe[title*="cvv" i]',
		],
		frameUrlIncludes: ["/verification_value-"],
		labels: [/security code/i, /cvv/i, /verification/i],
		required: true,
		selectors: cardSecurityCodeSelectors(),
	};
}
