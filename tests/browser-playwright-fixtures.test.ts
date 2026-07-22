import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { unlockStorefront } from "../src/playwright/storefront.cjs";

const origin = "https://fixture.shop.test";
const testPassword = "not-a-secret";

const protectedMarkup = (
	action = "/password",
	mutation = "",
) => `<!doctype html>
<html>
<head><script src="/delayed-script.js"></script></head>
<body>
  <form action="${action}" method="post">
    <input type="password" name="password">
    <input type="hidden" name="keyEvents" value="">
    <button type="submit">Enter</button>
  </form>
  <script>
    const password = document.querySelector('input[type="password"]');
    const events = [];
    for (const name of ['keydown', 'keypress', 'input', 'keyup']) {
      password.addEventListener(name, event => events.push(name + ':' + (event.key || 'input')));
    }
    ${mutation}
    document.querySelector('form').addEventListener('submit', () => {
      document.querySelector('input[name="keyEvents"]').value = JSON.stringify(events);
    });
  </script>
</body>
</html>`;

describe.sequential("headed Playwright storefront fixture contract", () => {
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: false });
		context = await browser.newContext();
		page = await context.newPage();
		vi.stubEnv("SHOPIFY_STORE_URL", origin);
		vi.stubEnv("SHOPIFY_STOREFRONT_PASSWORD", testPassword);
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		await context?.close();
		await browser?.close();
	});

	it("waits for delayed markup, emits sequential keys, and follows the form", async () => {
		let submittedBody = "";
		await page.route(`${origin}/**`, async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.pathname === "/delayed-script.js") {
				await new Promise((resolve) => setTimeout(resolve, 75));
				await route.fulfill({ body: "window.delayedScriptLoaded = true;" });
				return;
			}
			if (url.pathname === "/password" && request.method() === "POST") {
				submittedBody = request.postData() ?? "";
				await route.fulfill({
					body: '<!doctype html><h1 id="unlocked">Unlocked</h1>',
					contentType: "text/html",
				});
				return;
			}
			await route.fulfill({
				body: protectedMarkup(),
				contentType: "text/html",
			});
		});

		await page.goto(`${origin}/protected`, { waitUntil: "commit" });
		await unlockStorefront(page);

		const decodedBody = decodeURIComponent(submittedBody);
		expect(await page.locator("#unlocked").isVisible()).toBe(true);
		expect(decodedBody).toContain(testPassword);
		expect(decodedBody).toContain("keydown");
		expect(decodedBody).toContain("keypress");
		expect(decodedBody).toContain("input");
		expect(decodedBody).toContain("keyup");
	});

	it("rejects real cross-origin and unrelated password forms before typing", async () => {
		await page.unrouteAll({ behavior: "wait" });
		await page.route(`${origin}/**`, async (route) => {
			await route.fulfill({
				body: protectedMarkup("https://other.example/password"),
				contentType: "text/html",
			});
		});
		await page.goto(`${origin}/cross-origin`);

		await expect(unlockStorefront(page)).rejects.toThrow(/password challenge/i);
		expect(await page.locator('input[type="password"]').inputValue()).toBe("");
	});

	it("does not retarget the password when the verified input is replaced on focus", async () => {
		await page.unrouteAll({ behavior: "wait" });
		let submittedBody = "";
		await page.route(`${origin}/**`, async (route) => {
			const request = route.request();
			if (
				new URL(request.url()).pathname === "/password" &&
				request.method() === "POST"
			) {
				submittedBody = request.postData() ?? "";
				await route.fulfill({
					body: protectedMarkup(),
					contentType: "text/html",
				});
				return;
			}
			await route.fulfill({
				body: protectedMarkup(
					"/password",
					"password.addEventListener('focus', () => password.replaceWith(password.cloneNode()), { once: true });",
				),
				contentType: "text/html",
			});
		});
		await page.goto(`${origin}/replacement`);

		await expect(unlockStorefront(page)).rejects.toThrow(/password challenge/i);
		expect(decodeURIComponent(submittedBody)).not.toContain(testPassword);
		expect(await page.locator('input[type="password"]').inputValue()).toBe("");
	});

	it("does not post the password when the verified form action mutates on focus", async () => {
		await page.unrouteAll({ behavior: "wait" });
		let passwordPostCount = 0;
		let mutatedDestinationPostCount = 0;
		await page.route(`${origin}/**`, async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			if (request.method() === "POST" && pathname === "/password") {
				passwordPostCount += 1;
			}
			if (request.method() === "POST" && pathname === "/account/login") {
				mutatedDestinationPostCount += 1;
			}
			await route.fulfill({
				body: protectedMarkup(
					"/password",
					"password.addEventListener('focus', () => { password.form.action = '/account/login'; }, { once: true });",
				),
				contentType: "text/html",
			});
		});
		await page.goto(`${origin}/action-mutation`);

		await expect(unlockStorefront(page)).rejects.toThrow(
			/submitted successfully/i,
		);
		expect(passwordPostCount).toBe(0);
		expect(mutatedDestinationPostCount).toBe(0);
	});

	it("fails safely when navigation detaches the verified challenge during typing", async () => {
		await page.unrouteAll({ behavior: "wait" });
		let passwordSubmissionCount = 0;
		await page.route(`${origin}/**`, async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			if (pathname === "/password" && request.method() === "POST") {
				passwordSubmissionCount += 1;
			}
			await route.fulfill({
				body:
					pathname === "/moved"
						? '<!doctype html><h1 id="moved">Moved</h1>'
						: protectedMarkup(
								"/password",
								"password.addEventListener('focus', () => { window.location.href = '/moved'; }, { once: true });",
							),
				contentType: "text/html",
			});
		});
		await page.goto(`${origin}/navigation`);

		await expect(unlockStorefront(page)).rejects.toThrow(
			/submitted successfully/i,
		);
		expect(passwordSubmissionCount).toBe(0);
		expect(page.url()).toBe(`${origin}/moved`);
	});

	it("rejects a replacement challenge after a real submission", async () => {
		await page.unrouteAll({ behavior: "wait" });
		await page.route(`${origin}/**`, async (route) => {
			await route.fulfill({
				body: protectedMarkup(),
				contentType: "text/html",
			});
		});
		await page.goto(`${origin}/rejected`);

		await expect(unlockStorefront(page)).rejects.toThrow(/did not unlock/i);
	});
});
