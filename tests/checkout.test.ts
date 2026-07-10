import type { Locator, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import {
	completeShopifyCheckout,
	fillShopifyPaymentFields,
	formatCheckoutTimings,
} from "../src/playwright/checkout.js";

describe("checkout helpers", () => {
	it("completes checkout with buyer fields and a submit button", async () => {
		const page = checkoutPageDouble();

		const result = await completeShopifyCheckout({
			actionDelayMs: 0,
			buyer: {
				email: "buyer@example.com",
			},
			inputDelayMs: 0,
			maxSteps: 1,
			page,
		});

		expect(page.email.pressSequentially).toHaveBeenCalledWith(
			"buyer@example.com",
			{ delay: 0 },
		);
		expect(page.payButton.click).toHaveBeenCalledWith({ delay: 0 });
		expect(result.submitted).toBe(true);
		expect(result.timings.map((timing) => timing.phase)).toEqual([
			"checkout.customer",
			"checkout.shipping",
			"checkout.payment",
			"checkout.submit",
			"checkout.thank_you",
		]);
	});

	it("records Thank You timing on the default successful checkout path", async () => {
		const page = checkoutPageDouble();

		const result = await completeShopifyCheckout({
			actionDelayMs: 0,
			inputDelayMs: 0,
			page,
		});

		expect(result.timings.map((timing) => timing.phase)).toContain(
			"checkout.thank_you",
		);
		expect(page.payButton.click).toHaveBeenCalledTimes(1);
	});

	it("returns immediately when checkout already reached Thank You", async () => {
		const page = checkoutPageDouble({
			currentUrl:
				"https://example.myshopify.com/checkouts/cn/1/thank_you",
		});

		const result = await completeShopifyCheckout({
			actionDelayMs: 0,
			inputDelayMs: 0,
			page,
		});

		expect(result).toEqual({
			diagnostics: {
				usedPaymentFrameFallback: false,
			},
			submitted: false,
			timings: [],
		});
		expect(page.email.pressSequentially).not.toHaveBeenCalled();
		expect(page.payButton.click).not.toHaveBeenCalled();
	});

	it("fails with visible checkout validation context", async () => {
		const page = checkoutPageDouble({
			completeAfterSubmit: false,
			validationText: "Your card was declined. Try a different card.",
		});

		await expect(
			completeShopifyCheckout({
				actionDelayMs: 0,
				inputDelayMs: 0,
				maxSteps: 1,
				page,
			}),
		).rejects.toThrow("Your card was declined");
	});

	it("does not treat Shopify's free-order message as validation", async () => {
		const page = checkoutPageDouble({
			completeAfterSubmit: false,
			validationText: "Your order is free. No payment is required.",
		});

		await expect(
			completeShopifyCheckout({
				actionDelayMs: 0,
				inputDelayMs: 0,
				maxSteps: 1,
				page,
			}),
		).rejects.toThrow("did not show progress");
	});

	it("identifies the Thank You phase when checkout completion times out", async () => {
		const page = checkoutPageDouble({
			completeAfterSubmit: false,
		});

		await expect(
			completeShopifyCheckout({
				actionDelayMs: 0,
				inputDelayMs: 0,
				maxSteps: 0,
				page,
				thankYouTimeoutMs: 1,
			}),
		).rejects.toThrow("checkout.thank_you");
	});

	it("does not treat existing checkout copy as submit progress", async () => {
		const page = checkoutPageDouble({
			completeAfterSubmit: false,
			progressTextVisible: true,
		});

		await expect(
			completeShopifyCheckout({
				actionDelayMs: 0,
				inputDelayMs: 0,
				maxSteps: 2,
				page,
			}),
		).rejects.toThrow("did not show progress");
		expect(page.payButton.click).toHaveBeenCalledTimes(1);
	});

	it("waits for Thank You after payment submit reaches an intermediate URL", async () => {
		const page = checkoutPageDouble({
			completeOnThankYouWait: true,
			intermediateUrlAfterSubmit:
				"https://example.myshopify.com/checkouts/cn/1/processing",
			paymentFrameElementVisible: true,
			paymentSectionVisible: true,
		});

		const result = await completeShopifyCheckout({
			actionDelayMs: 0,
			inputDelayMs: 0,
			maxSteps: 1,
			page,
			payment: {
				cardNumber: "4242424242424242",
				expiry: "12 / 30",
				name: "Filebean E2E",
				securityCode: "111",
			},
		});

		expect(result.timings.map((timing) => timing.phase)).toEqual([
			"checkout.customer",
			"checkout.shipping",
			"checkout.payment",
			"checkout.submit",
			"checkout.thank_you",
		]);
		expect(page.payButton.click).toHaveBeenCalledTimes(1);
		expect(page.waitForURL).toHaveBeenCalledTimes(2);
	});

	it("fills Shopify card iframes through frame locators before scanning frames", async () => {
		const page = paymentPageDouble();

		const result = await fillShopifyPaymentFields(
			page,
			{
				cardNumber: "4242424242424242",
				expiry: "12 / 30",
				name: "Filebean E2E",
				securityCode: "111",
			},
			{ actionDelayMs: 0, inputDelayMs: 0 },
		);

		expect(result).toEqual({
			filled: true,
			sawPaymentForm: true,
			usedFallback: false,
		});
		expect(page.cardNumber.pressSequentially).toHaveBeenCalledWith(
			"4242424242424242",
			{ delay: 0 },
		);
		expect(page.cardExpiry.pressSequentially).toHaveBeenCalledWith(
			"12 / 30",
			{
				delay: 0,
			},
		);
		expect(page.cardSecurityCode.pressSequentially).toHaveBeenCalledWith(
			"111",
			{ delay: 0 },
		);
		expect(page.cardName.pressSequentially).toHaveBeenCalledWith(
			"Filebean E2E",
			{ delay: 0 },
		);
		expect(page.cardNumber.waitFor).not.toHaveBeenCalled();
		expect(page.cardExpiry.waitFor).not.toHaveBeenCalled();
		expect(page.cardSecurityCode.waitFor).not.toHaveBeenCalled();
		expect(page.frames).not.toHaveBeenCalled();
	});

	it("falls back to bounded frame discovery when frame locators do not resolve", async () => {
		const page = paymentPageDouble({ paymentFrameLocatorVisible: false });

		const result = await fillShopifyPaymentFields(
			page,
			{
				cardNumber: "4242424242424242",
				expiry: "12 / 30",
				name: "Filebean E2E",
				securityCode: "111",
			},
			{ actionDelayMs: 0, inputDelayMs: 0 },
		);

		expect(result).toEqual({
			filled: true,
			sawPaymentForm: true,
			usedFallback: true,
		});
		expect(page.frames).toHaveBeenCalled();
		expect(page.fallbackCardNumber.pressSequentially).toHaveBeenCalledWith(
			"4242424242424242",
			{ delay: 0 },
		);
	});

	it("skips payment filling when the saved payment method is selected", async () => {
		const page = paymentPageDouble({ savedPaymentSelected: true });

		const result = await fillShopifyPaymentFields(
			page,
			{
				cardNumber: "4242424242424242",
				expiry: "12 / 30",
				securityCode: "111",
			},
			{ actionDelayMs: 0, inputDelayMs: 0 },
		);

		expect(result).toEqual({
			filled: false,
			sawPaymentForm: true,
			usedFallback: false,
		});
		expect(page.cardNumber.pressSequentially).not.toHaveBeenCalled();
	});

	it("skips payment filling when Shopify says no payment is required", async () => {
		const page = paymentPageDouble({ noPaymentRequired: true });

		const result = await fillShopifyPaymentFields(
			page,
			{
				cardNumber: "4242424242424242",
				expiry: "12 / 30",
				securityCode: "111",
			},
			{ actionDelayMs: 0, inputDelayMs: 0 },
		);

		expect(result).toEqual({
			filled: false,
			sawPaymentForm: true,
			usedFallback: false,
		});
		expect(page.cardNumber.pressSequentially).not.toHaveBeenCalled();
	});

	it("skips payment discovery when no payment form is present", async () => {
		const page = paymentPageDouble({
			paymentFrameElementVisible: false,
			paymentSectionVisible: false,
		});

		const result = await fillShopifyPaymentFields(
			page,
			{
				cardNumber: "4242424242424242",
				expiry: "12 / 30",
				securityCode: "111",
			},
			{ actionDelayMs: 0, inputDelayMs: 0 },
		);

		expect(result).toEqual({
			filled: false,
			sawPaymentForm: false,
			usedFallback: false,
		});
		expect(page.frameLocator).not.toHaveBeenCalled();
		expect(page.frames).not.toHaveBeenCalled();
	});

	it("reports the exact required payment fields that could not be filled", async () => {
		const page = paymentPageDouble({
			paymentFieldVisibility: {
				expiry: false,
			},
			fallbackPaymentFieldVisibility: {
				expiry: false,
			},
			paymentSectionVisible: true,
		});

		await expect(
			fillShopifyPaymentFields(
				page,
				{
					cardNumber: "4242424242424242",
					expiry: "12 / 30",
					securityCode: "111",
				},
				{ actionDelayMs: 0, inputDelayMs: 0 },
			),
		).rejects.toThrow("expiry");
	});

	it("formats timing output without urls or customer data", () => {
		expect(
			formatCheckoutTimings([
				{ phase: "checkout.customer", durationMs: 12.2 },
				{ phase: "checkout.payment", durationMs: 34.8 },
			]),
		).toBe("checkout.customer=12ms, checkout.payment=35ms");
	});
});

type LocatorDouble = Locator & ReturnType<typeof locatorShape>;

type CheckoutPageDouble = Page & {
	email: LocatorDouble;
	payButton: LocatorDouble;
};

type PaymentPageDouble = Page & {
	cardExpiry: LocatorDouble;
	cardName: LocatorDouble;
	cardNumber: LocatorDouble;
	cardSecurityCode: LocatorDouble;
	fallbackCardNumber: LocatorDouble;
	frames: ReturnType<typeof vi.fn>;
};

interface CheckoutPageDoubleOptions {
	completeOnThankYouWait?: boolean;
	completeAfterSubmit?: boolean;
	currentUrl?: string;
	intermediateUrlAfterSubmit?: string;
	paymentFrameElementVisible?: boolean;
	paymentSectionVisible?: boolean;
	progressTextVisible?: boolean;
	validationText?: string;
}

interface PaymentPageDoubleOptions {
	fallbackPaymentFieldVisibility?: Partial<
		Record<"cardNumber" | "expiry" | "name" | "securityCode", boolean>
	>;
	paymentFieldVisibility?: Partial<
		Record<"cardNumber" | "expiry" | "name" | "securityCode", boolean>
	>;
	paymentFrameElementVisible?: boolean;
	paymentFrameLocatorVisible?: boolean;
	paymentSectionVisible?: boolean;
	noPaymentRequired?: boolean;
	savedPaymentSelected?: boolean;
}

function checkoutPageDouble(
	options: CheckoutPageDoubleOptions = {},
): CheckoutPageDouble {
	const state = {
		currentUrl:
			options.currentUrl ??
			"https://example.myshopify.com/checkouts/cn/1",
	};
	const hidden = locatorDouble({ visible: false });
	const email = locatorDouble();
	const cardNumber = locatorDouble();
	const cardExpiry = locatorDouble();
	const cardName = locatorDouble();
	const cardSecurityCode = locatorDouble();
	const paymentSection = locatorDouble({
		visible: options.paymentSectionVisible ?? false,
	});
	const paymentFrameElement = locatorDouble({
		visible: options.paymentFrameElementVisible ?? false,
	});
	const payButton = locatorDouble({
		onClick: () => {
			if (options.intermediateUrlAfterSubmit) {
				state.currentUrl = options.intermediateUrlAfterSubmit;
			} else if (options.completeAfterSubmit ?? true) {
				state.currentUrl =
					"https://example.myshopify.com/checkouts/cn/1/thank_you";
			}
		},
	});
	const validation = locatorDouble({
		innerText: options.validationText,
		visible: Boolean(options.validationText),
	});
	const progressText = locatorDouble({
		innerText: "Pay now",
		visible: options.progressTextVisible ?? false,
	});

	return {
		email,
		payButton,
		frameLocator: vi.fn((selector: string) =>
			paymentFrameLocatorDouble(
				selector,
				{ cardExpiry, cardName, cardNumber, cardSecurityCode },
				hidden,
			),
		),
		frames: vi.fn(() => []),
		getByRole: vi.fn((_role: string, options?: { name?: RegExp }) => ({
			first: () => (options?.name?.test("Pay now") ? payButton : hidden),
		})),
		getByText: vi.fn((name: RegExp | string) => ({
			first: () => {
				if (
					typeof name !== "string" &&
					options.validationText &&
					name.test(options.validationText)
				) {
					return validation;
				}

				if (
					typeof name !== "string" &&
					options.paymentSectionVisible &&
					name.test("Payment")
				) {
					return paymentSection;
				}

				if (
					typeof name !== "string" &&
					options.progressTextVisible &&
					name.test("Pay now")
				) {
					return progressText;
				}

				return hidden;
			},
		})),
		keyboard: {
			press: vi.fn(async () => undefined),
		},
		locator: vi.fn((selector: string) => ({
			first: () => {
				if (selector === 'input[name="email"]') {
					return email;
				}

				if (selector.startsWith("iframe")) {
					return paymentFrameElement;
				}

				return hidden;
			},
		})),
		url: vi.fn(() => state.currentUrl),
		waitForLoadState: vi.fn(async () => undefined),
		waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
			if (predicate(new URL(state.currentUrl))) {
				return;
			}

			if (
				options.completeOnThankYouWait &&
				state.currentUrl === options.intermediateUrlAfterSubmit
			) {
				state.currentUrl =
					"https://example.myshopify.com/checkouts/cn/1/thank_you";

				if (predicate(new URL(state.currentUrl))) {
					return;
				}
			}

			throw new Error("URL did not match.");
		}),
	} as unknown as CheckoutPageDouble;
}

function paymentPageDouble(
	options: PaymentPageDoubleOptions = {},
): PaymentPageDouble {
	const hidden = locatorDouble({ visible: false });
	const cardNumber = locatorDouble({
		visible: options.paymentFieldVisibility?.cardNumber ?? true,
	});
	const cardExpiry = locatorDouble({
		visible: options.paymentFieldVisibility?.expiry ?? true,
	});
	const cardName = locatorDouble({
		visible: options.paymentFieldVisibility?.name ?? true,
	});
	const cardSecurityCode = locatorDouble({
		visible: options.paymentFieldVisibility?.securityCode ?? true,
	});
	const fallbackCardNumber = locatorDouble({
		visible: options.fallbackPaymentFieldVisibility?.cardNumber ?? true,
	});
	const fallbackCardExpiry = locatorDouble({
		visible: options.fallbackPaymentFieldVisibility?.expiry ?? true,
	});
	const fallbackCardSecurityCode = locatorDouble({
		visible: options.fallbackPaymentFieldVisibility?.securityCode ?? true,
	});
	const fallbackCardName = locatorDouble({
		visible: options.fallbackPaymentFieldVisibility?.name ?? true,
	});
	const paymentSection = locatorDouble({
		visible: options.paymentSectionVisible ?? false,
	});
	const noPaymentRequired = locatorDouble({
		visible: options.noPaymentRequired ?? false,
	});
	const savedPayment = locatorDouble({
		checked: options.savedPaymentSelected ?? false,
	});
	const paymentFrameElement = locatorDouble({
		visible: options.paymentFrameElementVisible ?? true,
	});
	const fallbackFrames = [
		frameDouble("/number-", fallbackCardNumber),
		frameDouble("/expiry-", fallbackCardExpiry),
		frameDouble("/verification_value-", fallbackCardSecurityCode),
		frameDouble("/name-", fallbackCardName),
	];

	const page = {
		cardExpiry,
		cardName,
		cardNumber,
		cardSecurityCode,
		fallbackCardNumber,
		frameLocator: vi.fn((selector: string) =>
			paymentFrameLocatorDouble(
				selector,
				{ cardExpiry, cardName, cardNumber, cardSecurityCode },
				hidden,
				options.paymentFrameLocatorVisible !== false,
			),
		),
		frames: vi.fn(() => fallbackFrames),
		getByRole: vi.fn((_role: string, options?: { name?: RegExp }) => ({
			first: () => (options?.name?.test("4242") ? savedPayment : hidden),
		})),
		getByText: vi.fn((text: RegExp | string) => ({
			first: () => {
				if (
					typeof text !== "string" &&
					options.noPaymentRequired &&
					text.test("No payment is required")
				) {
					return noPaymentRequired;
				}

				return typeof text !== "string" && text.test("Payment")
					? paymentSection
					: hidden;
			},
		})),
		locator: vi.fn((selector: string) => ({
			first: () =>
				selector.startsWith("iframe") ? paymentFrameElement : hidden,
		})),
		url: vi.fn(() => "https://example.myshopify.com/checkouts/cn/1"),
		waitForURL: vi.fn(async () => undefined),
	};

	return page as unknown as PaymentPageDouble;
}

function frameDouble(url: string, locator: LocatorDouble) {
	return {
		getByRole: vi.fn(() => ({
			first: () => locator,
		})),
		locator: vi.fn(() => ({
			first: () => locator,
		})),
		url: vi.fn(() => `https://checkout.shopifycs.com${url}field`),
	};
}

function paymentFrameLocatorDouble(
	selector: string,
	locators: {
		cardExpiry: LocatorDouble;
		cardName: LocatorDouble;
		cardNumber: LocatorDouble;
		cardSecurityCode: LocatorDouble;
	},
	hidden: LocatorDouble,
	enabled = true,
) {
	if (!enabled) {
		return frameLocatorDouble(hidden);
	}

	if (selector.includes("/number-")) {
		return frameLocatorDouble(locators.cardNumber);
	}

	if (selector.includes("/expiry-")) {
		return frameLocatorDouble(locators.cardExpiry);
	}

	if (selector.includes("/name-")) {
		return frameLocatorDouble(locators.cardName);
	}

	if (selector.includes("/verification_value-")) {
		return frameLocatorDouble(locators.cardSecurityCode);
	}

	return frameLocatorDouble(hidden);
}

function frameLocatorDouble(locator: LocatorDouble) {
	return {
		getByRole: vi.fn(() => ({
			first: () => locator,
		})),
		locator: vi.fn(() => ({
			first: () => locator,
		})),
	};
}

function locatorDouble(
	options: {
		checked?: boolean;
		innerText?: string;
		onClick?: () => void;
		visible?: boolean;
	} = {},
): LocatorDouble {
	return locatorShape(options) as unknown as LocatorDouble;
}

function locatorShape(options: {
	checked?: boolean;
	innerText?: string;
	onClick?: () => void;
	visible?: boolean;
}) {
	return {
		innerText: vi.fn(async () => options.innerText ?? ""),
		click: vi.fn(async () => {
			options.onClick?.();
		}),
		fill: vi.fn(async () => undefined),
		focus: vi.fn(async () => undefined),
		inputValue: vi.fn(async () => ""),
		isChecked: vi.fn(async () => options.checked ?? false),
		isEnabled: vi.fn(async () => true),
		isVisible: vi.fn(async () => options.visible ?? true),
		pressSequentially: vi.fn(async () => undefined),
		scrollIntoViewIfNeeded: vi.fn(async () => undefined),
		selectOption: vi.fn(async () => undefined),
		waitFor: vi.fn(async () => {
			if (options.visible === false) {
				throw new Error("Locator is hidden.");
			}
		}),
	};
}
