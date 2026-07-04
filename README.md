# shopify-e2e

Reusable Shopify live E2E helper CLI and Playwright package.

This is the shared version of the Shopify test setup that started in Filebean. It handles the fussy part of live Shopify tests: Chrome CDP startup, a persistent Admin session, auth-state restore/save, one-tab Playwright access, and manual login prompts.

App repositories still own the app-specific work: products, checkout assertions, webhook setup, seed data, and UI expectations.

Last reviewed: 2026-07-04

## when to use it

Use this package when an app repo needs Playwright tests against a real Shopify shop. It is not meant for unit tests, fake checkout flows, or product-specific test data.

You need:

- Node 20 or newer
- Google Chrome
- Playwright in the consuming app
- a development or test Shopify shop
- an app URL that Shopify can reach, usually an HTTPS tunnel

## install

For a consuming app, install the published package and Playwright:

```sh
npm install --save-dev shopify-e2e @playwright/test
```

For local package development from this checkout:

```sh
npm install
npm run build
npm link
```

Then, in the app repo:

```sh
npm link shopify-e2e
```

## configure an app repo

Create `shopify-e2e.config.mjs` in the app repo:

```js
import { defineShopifyE2EConfig } from "shopify-e2e";

export default defineShopifyE2EConfig({
	shopDomain: "example.myshopify.com",
	appUrl: "https://example-app.ngrok.app",
	cdpPort: 9222,
	chromeProfilePath: ".shopify-e2e/chrome-profile",
	authStatePath: ".shopify-e2e/auth/shopify-storage-state.json",
	storefrontDomain: "www.example-store.com",
	storefrontPassword: process.env.SHOPIFY_E2E_STOREFRONT_PASSWORD,
	testFiles: ["e2e"],
	testCommand: {
		command: process.platform === "win32" ? "npx.cmd" : "npx",
		args: ["playwright", "test"],
		mode: "playwright",
	},
});
```

Shell values override the config file. A local env file also works through `SHOPIFY_E2E_ENV_FILE` or `--env-file`.

| variable | purpose |
| --- | --- |
| `SHOPIFY_E2E_SHOP_DOMAIN` | Shopify Admin shop, for example `example.myshopify.com` |
| `SHOPIFY_E2E_APP_URL` | app URL used by the app under test |
| `SHOPIFY_E2E_CDP_URL` | Chrome DevTools URL, for example `http://127.0.0.1:9222` |
| `SHOPIFY_E2E_CDP_PORT` | CDP port when no full URL is set |
| `SHOPIFY_E2E_CHROME_PATH` | Chrome executable path |
| `SHOPIFY_E2E_CHROME_PROFILE_PATH` | persistent Chrome profile directory |
| `SHOPIFY_E2E_AUTH_STATE_PATH` | Playwright storage-state file |
| `SHOPIFY_E2E_STOREFRONT_DOMAIN` | storefront host when it differs from the Admin shop domain |
| `SHOPIFY_E2E_STOREFRONT_PASSWORD` | password for a locked storefront |
| `SHOPIFY_E2E_TEST_FILES` | comma-separated test files or directories |
| `SHOPIFY_E2E_TEST_COMMAND` | custom shell command for the test runner |

Keep Chrome profiles, auth state, and env files out of source control. Auth state contains Shopify cookies.

## CLI

Run commands from the app repo:

```sh
shopify-e2e doctor
shopify-e2e open
shopify-e2e auth save
shopify-e2e auth restore
shopify-e2e run
```

`shopify-e2e doctor` checks config, Chrome, CDP, auth state, the test runner, and the current Shopify Admin session.

`shopify-e2e open` starts Chrome when CDP is not reachable, restores saved auth state when it can, opens Shopify Admin, and waits for a logged-in session. If login is needed, finish it in Chrome. The CLI keeps polling and continues after the Admin session is ready.

`shopify-e2e auth save` writes storage state from the current CDP Chrome context.

`shopify-e2e auth restore` starts Chrome only when saved auth state exists, then restores it into the CDP context.

`shopify-e2e run` prepares the Admin session, saves auth state after login, and runs the configured test command. The default Playwright mode appends `--workers=1`.

Pass Playwright args after `--`:

```sh
shopify-e2e run -- --project=chromium --grep @live
```

Useful flags:

```sh
shopify-e2e run --shop example.myshopify.com --app-url https://example-app.ngrok.app
shopify-e2e open --cdp-port 9333 --storefront-domain www.example-store.com
shopify-e2e doctor --config shopify-e2e.config.mjs
```

## Playwright setup

Use the package global setup when tests may be run directly with Playwright:

```ts
import { defineConfig } from "@playwright/test";
import { globalSetup } from "shopify-e2e";

export default defineConfig({
	globalSetup,
	workers: 1,
	use: {
		trace: "retain-on-failure",
	},
});
```

The global setup only prepares Shopify when live mode is enabled. Set `SHOPIFY_E2E_LIVE=1` or `live: true` in config. The CLI sets `SHOPIFY_E2E_LIVE=1` for `shopify-e2e run`.

## Playwright API

Use the context API in app tests. It resolves config once, reuses the shared Chrome page, and groups helpers by Shopify domain:

```ts
import { createShopifyE2E } from "shopify-e2e";

test("opens checkout", async () => {
	const shopify = await createShopifyE2E();

	await shopify.admin.prepare();
	const variantId = await shopify.storefront.variantId({
		handle: "test-product",
	});

	await shopify.checkout.openCart({
		variantId,
		buyer: {
			email: "buyer@example.com",
			firstName: "Ada",
			lastName: "Lovelace",
		},
	});
});
```

`shopify.admin.prepare` starts Chrome when needed, restores auth state, opens Shopify Admin, waits for login when required, and saves auth state after a successful login.

`shopify.admin.page` returns the shared live Shopify page.

`shopify.admin.goto` navigates the shared Admin page to an Admin path or full URL. `shopify.admin.open` is the same operation with a friendlier name for setup scripts.

`shopify.storefront.unlock` opens `/password` on the configured storefront and enters the storefront password only when the page is on the expected host.

`shopify.storefront.variantId` accepts either a variant ID or a product handle. With a handle, it reads Shopify's product JSON and returns the first available variant.

`shopify.checkout.cartUrl` and `shopify.checkout.openCart` create Shopify cart permalink flows. They can prefill buyer fields that Shopify accepts in checkout query parameters.

`shopify.inputs` exposes slower input helpers for live Shopify pages where instant typing is brittle.

Advanced helpers remain available through explicit subpath imports:

```ts
import { resolveShopifyE2EConfig } from "shopify-e2e/config";
import { createLiveShopifyPage } from "shopify-e2e/playwright";
import { slowFill } from "shopify-e2e/inputs";
import { buildCartPermalinkUrl } from "shopify-e2e/storefront";
```

## live-test rules

Live Shopify tests must be boring and serialized:

- run one worker
- use one shared Chrome tab/page
- avoid parallel checkout tabs
- keep product setup and checkout assertions in the app repo
- do not commit auth state, Chrome profiles, storefront passwords, or `.env` files

The default CLI runner enforces one worker for Playwright mode. If you use a custom shell command, `shopify-e2e` prints a warning because it cannot inspect the command.

## troubleshooting

Start with:

```sh
shopify-e2e doctor
```

If Chrome is not found, set `SHOPIFY_E2E_CHROME_PATH` or pass `--chrome-path`.

If CDP is not reachable, the CLI will try to start Chrome with the configured profile and port. Check that another Chrome process is not already using the same profile.

If the CLI waits at login, complete Shopify Admin login in the Chrome window it opened. Once the URL is a non-login Admin page for the configured shop, the CLI continues.

If a password-protected storefront fails, check `SHOPIFY_E2E_STOREFRONT_PASSWORD`. If the storefront redirects to a custom domain, set `SHOPIFY_E2E_STOREFRONT_DOMAIN`.

## develop this package

```sh
npm install
npm run typecheck
npm test
npm run build
```

The command layout follows oclif file discovery:

- `src/commands/open.ts` becomes `shopify-e2e open`
- `src/commands/auth/save.ts` becomes `shopify-e2e auth save`
- `src/commands/auth/restore.ts` becomes `shopify-e2e auth restore`

Keep reusable Shopify session behavior in this package. Keep app data, product IDs, checkout assertions, and webhook wiring in the app repositories.

## repository

Private source repository: `git@github.com:alessandrotesoro/shopify-e2e.git`

## license

MIT
