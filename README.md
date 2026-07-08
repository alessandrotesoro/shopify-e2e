# shopify-e2e

Reusable CLI and Playwright helpers for running live end-to-end tests against a
Shopify store.

`shopify-e2e` manages the shared browser and Shopify Admin session work that
otherwise ends up copied into every project: Chrome CDP startup, persistent
Chrome profiles, auth-state restore/save, manual login polling, one shared page,
and a serialized Playwright test runner.

Product fixtures, checkout-download assertions, webhook setup, and
application-specific test logic belong in the consuming project.

## Requirements

- Node.js 20 or newer
- Google Chrome
- Playwright in the consuming project
- A development or test Shopify store
- A reachable application URL, usually an HTTPS tunnel during local development

## Installation

Install the package in the project that owns the tests:

```sh
npm install --save-dev shopify-e2e @playwright/test
```

For local package development:

```sh
npm install
npm run build
npm link
```

Then link the package from the consuming project:

```sh
npm link shopify-e2e
```

## Configuration

Create `shopify-e2e.config.mjs` in the consuming project:

```js
import { defineShopifyE2EConfig } from "shopify-e2e";

export default defineShopifyE2EConfig({
	shopDomain: "example.myshopify.com",
	appUrl: "https://example-app.ngrok.app",
	cdpPort: 9222,
	chromeProfilePath: ".shopify-e2e/chrome-profile",
	authStatePath: ".shopify-e2e/auth/shopify-storage-state.json",
	storefrontPassword: process.env.SHOPIFY_E2E_STOREFRONT_PASSWORD,
	appSetupCommand: {
		command: "npm",
		args: ["run", "e2e:shopify:prepare"],
		mode: "custom",
	},
	testFiles: ["e2e"],
	testCommand: {
		command: process.platform === "win32" ? "npx.cmd" : "npx",
		args: ["playwright", "test"],
		mode: "playwright",
	},
});
```

Environment variables override config-file values. Use `SHOPIFY_E2E_ENV_FILE`
or `--env-file` when values should be loaded from a local env file.

| Config key | Environment variable |
| --- | --- |
| `shopDomain` | `SHOPIFY_E2E_SHOP_DOMAIN` |
| `appUrl` | `SHOPIFY_E2E_APP_URL` |
| `cdpUrl` | `SHOPIFY_E2E_CDP_URL` |
| `cdpPort` | `SHOPIFY_E2E_CDP_PORT` |
| `chromeExecutablePath` | `SHOPIFY_E2E_CHROME_PATH` |
| `chromeProfilePath` | `SHOPIFY_E2E_CHROME_PROFILE_PATH` |
| `authStatePath` | `SHOPIFY_E2E_AUTH_STATE_PATH` |
| `storefrontDomain` | `SHOPIFY_E2E_STOREFRONT_DOMAIN` |
| `storefrontPassword` | `SHOPIFY_E2E_STOREFRONT_PASSWORD` |
| `testFiles` | `SHOPIFY_E2E_TEST_FILES` |
| `testCommand` | `SHOPIFY_E2E_TEST_COMMAND` |

`appSetupCommand` is intentionally config-file only. Use it for app-owned
fixture readiness, such as preparing local database rows after Shopify Admin
login is ready and before Playwright starts. Environment-file values are
available to this command, and real shell environment variables take precedence.
During `shopify-e2e run`, the package prints the setup command before executing
it so app-owned fixture work is visible.

Do not commit Chrome profiles, auth-state files, storefront passwords, or local
env files. Auth state contains Shopify cookies.

## CLI Commands

Run commands from the project that contains the tests.

| Command | Purpose |
| --- | --- |
| `shopify-e2e doctor` | Check config, Chrome, CDP, auth state, runner setup, and the current Admin session. |
| `shopify-e2e open` | Start Chrome if needed, restore auth state, open Shopify Admin, and wait for login. |
| `shopify-e2e auth save` | Save storage state from the current CDP Chrome context. |
| `shopify-e2e auth restore` | Restore saved auth state into Chrome when a state file exists. |
| `shopify-e2e run` | Prepare the Admin session, run the configured app setup command, and run the configured test command. |

Pass Playwright arguments after `--`:

```sh
shopify-e2e run -- --project=chromium
```

In the default Playwright mode, `shopify-e2e run` adds `--workers=1`. Custom
shell commands are allowed, but the package cannot inspect them or enforce worker
count inside them. If `appSetupCommand` exits non-zero, Playwright is not
started.

## Playwright Setup

Use the package global setup when live tests may also be run directly through
Playwright:

```ts
import { defineConfig } from "@playwright/test";
import { globalSetupPath } from "shopify-e2e";

export default defineConfig({
	globalSetup: globalSetupPath,
	workers: 1,
	use: {
		trace: "retain-on-failure",
	},
});
```

`globalSetupPath` points Playwright at the package-owned global setup module.
The setup prepares Shopify only when live mode is enabled. Set
`SHOPIFY_E2E_LIVE=1` or `live: true` in config. The CLI sets
`SHOPIFY_E2E_LIVE=1` for `shopify-e2e run`.

## Test API

Use `createShopifyE2E` from live tests. It resolves configuration once and
returns a small context object for Admin, storefront, checkout, and input
helpers.

```ts
import { test } from "@playwright/test";
import { createShopifyE2E } from "shopify-e2e";

test("opens checkout", async () => {
	const shopify = await createShopifyE2E();

	await shopify.admin.prepare();

	const variantId = await shopify.storefront.variantId({
		handle: "test-product",
	});

	await shopify.checkout.purchase({
		variantId,
		buyer: {
			email: "buyer@example.com",
			firstName: "Ada",
			lastName: "Lovelace",
		},
		payment: {
			cardNumber: "4242424242424242",
			expiry: "12 / 30",
			name: "Ada Lovelace",
			securityCode: "111",
		},
	});
});
```

The context exposes:

- `shopify.admin.prepare()` to start Chrome, restore auth state, open Shopify
  Admin, wait for login, and save auth state after login.
- `shopify.admin.page()` to return the shared live Shopify page.
- `shopify.admin.goto(pathOrUrl)` to navigate the shared Admin page.
- `shopify.storefront.variantId(product)` to use an explicit variant ID or
  resolve a product handle through Shopify product JSON.
- `shopify.storefront.unlock()` to enter the storefront password on the
  configured storefront host.
- `shopify.checkout.cartUrl(options)` to build a Shopify cart permalink.
- `shopify.checkout.openCart(options)` to open a cart permalink on the shared
  page.
- `shopify.checkout.purchase(options)` to open the cart permalink and complete
  the Shopify checkout on the shared page.
- `shopify.checkout.complete(options)` to complete the current Shopify checkout
  with Playwright locators, package-owned payment iframe handling, and sanitized
  phase timings. Pass `page` only when overriding the shared page.
- `shopify.checkout.expectComplete(options)` to wait for Shopify's Thank You
  page. Pass `page` only when overriding the shared page.
- `shopify.inputs` for slower input helpers when Shopify pages reject instant
  typing.

## Advanced Imports

The root package export is intentionally small. Lower-level helpers are available
through explicit subpaths:

```ts
import { resolveShopifyE2EConfig } from "shopify-e2e/config";
import { slowFill } from "shopify-e2e/inputs";
import {
	completeShopifyCheckout,
	createLiveShopifyPage,
	fillShopifyPaymentFields,
} from "shopify-e2e/playwright";
import { buildCartPermalinkUrl } from "shopify-e2e/storefront";
```

Prefer `createShopifyE2E` in tests unless a lower-level helper is genuinely
needed.

## Live Test Constraints

Live Shopify tests should stay serialized:

- Use one Playwright worker.
- Use the shared Chrome tab/page.
- Do not run parallel checkout tabs.
- Keep product data, checkout-download assertions, and webhook setup in the
  consuming project.
- Use `appSetupCommand` only for app-owned fixture readiness. The package should
  not contain application-specific product, order, webhook, or database logic.
- Keep session files and secrets out of git.

## Troubleshooting

Start with:

```sh
shopify-e2e doctor
```

Common issues:

- Chrome is not found: set `SHOPIFY_E2E_CHROME_PATH` or pass `--chrome-path`.
- CDP is not reachable: check the configured port and Chrome profile path.
- The CLI is waiting at login: complete Shopify Admin login in the Chrome
  window.
- Storefront unlock fails: set `SHOPIFY_E2E_STOREFRONT_PASSWORD`. If the store
  redirects to another host, set `SHOPIFY_E2E_STOREFRONT_DOMAIN`.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The CLI uses oclif file discovery:

- `src/commands/open.ts` maps to `shopify-e2e open`
- `src/commands/auth/save.ts` maps to `shopify-e2e auth save`
- `src/commands/auth/restore.ts` maps to `shopify-e2e auth restore`

Reusable Shopify session and checkout mechanics belong in this package.
Application-specific assertions and fixture setup belong in the project that
owns the tests.

## License

MIT. See [LICENSE](LICENSE).
