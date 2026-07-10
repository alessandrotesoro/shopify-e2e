# shopify-e2e

Reusable CLI and Playwright helpers for serial live end-to-end tests against a
Shopify development store.

`shopify-e2e` owns local Chrome/CDP startup, named browser profiles, isolated
test contexts, and the serialized Playwright runner. The consuming application
owns products, fixtures, account and order assertions, webhooks, and other
application-specific behavior.

## Requirements

- Node.js 20 or newer
- Google Chrome for interactive Shopify login and live tests
- Playwright in the consuming project
- A development or test Shopify store
- A reachable application URL, usually an HTTPS tunnel

For this package's headless isolation regression, install bundled Chromium:

```sh
npx playwright install chromium
```

## Installation

```sh
npm install --save-dev shopify-e2e @playwright/test
```

For local package development:

```sh
npm install
npm run build
npm link
```

Then run `npm link shopify-e2e` in the consuming project.

## Configuration

Create `shopify-e2e.config.mjs` in the project that owns the tests:

```js
import { defineShopifyE2EConfig } from "shopify-e2e";

export default defineShopifyE2EConfig({
	shopDomain: "example.myshopify.com",
	appUrl: "https://app.example.test",
	authProfile: "default",
	cdpPort: 9222,
	chromeProfilePath: ".shopify-e2e/chrome-profile",
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
	},
});
```

Environment variables override config-file values. Use `SHOPIFY_E2E_ENV_FILE`
or `--env-file` for a local environment file.

| Config key | Environment variable |
| --- | --- |
| `shopDomain` | `SHOPIFY_E2E_SHOP_DOMAIN` |
| `appUrl` | `SHOPIFY_E2E_APP_URL` |
| `authProfile` | `SHOPIFY_E2E_AUTH_PROFILE` |
| `cdpUrl` | `SHOPIFY_E2E_CDP_URL` |
| `cdpPort` | `SHOPIFY_E2E_CDP_PORT` |
| `chromeExecutablePath` | `SHOPIFY_E2E_CHROME_PATH` |
| `chromeProfilePath` | `SHOPIFY_E2E_CHROME_PROFILE_PATH` |
| `storefrontDomain` | `SHOPIFY_E2E_STOREFRONT_DOMAIN` |
| `storefrontPassword` | `SHOPIFY_E2E_STOREFRONT_PASSWORD` |
| `testFiles` | `SHOPIFY_E2E_TEST_FILES` |

`appSetupCommand` and `testCommand` are config-file only. App setup prepares
application-owned fixtures before Playwright starts; it does not receive the
selected customer profile. The package always adds `--workers=1` to its
Playwright child command.

CLI flags override environment and config values. Use `--auth-profile` for the
saved identity and `--chrome-profile-path` for Chrome's persistent operator
profile. They are separate concepts.

## Named Profiles

Profile names are lowercase kebab-case. Use pseudonymous labels such as
`admin-base`, `customer-a`, and `customer-b`; do not put names or email addresses
in profile labels. With no selection, the `default` profile resolves to:

```text
.shopify-e2e/auth/profiles/default.json
```

Other profiles use `.shopify-e2e/auth/profiles/<profile>.json`.

Profile files are raw bearer credentials. They may contain cookies,
localStorage, and IndexedDB records. Keep `.shopify-e2e/` ignored, never commit
or share these files, and protect backups as secrets. The package creates the
profile directory and files with restrictive local permissions where the
platform supports them.

### Capture An Admin Base

Create or refresh a clean Admin-only base:

```sh
shopify-e2e auth save --auth-profile admin-base --empty
```

The package opens a fresh capture context. Complete Shopify Admin login and
press Enter to save; closing the page or pressing Ctrl-C cancels without
writing. `--empty` deliberately ignores any existing `admin-base` file.

### Capture Customers

Seed each customer profile from the Admin base so Admin login is reusable while
customer identity starts from the same known base:

```sh
shopify-e2e auth save --auth-profile customer-a --from-auth-profile admin-base
shopify-e2e auth save --auth-profile customer-b --from-auth-profile admin-base
```

Complete only the intended customer login in each fresh capture context, then
press Enter. Saving replaces only the selected profile atomically and includes
portable IndexedDB state.

Inspect a profile without changing it:

```sh
shopify-e2e open --auth-profile customer-a
```

Run the selected profile serially:

```sh
shopify-e2e run --auth-profile customer-a -- --project=chromium
```

Run `shopify-e2e doctor --auth-profile customer-a` to check the selected file,
Chrome, CDP, runner setup, and isolated Admin freshness without printing stored
credentials.

### Refresh, Delete, And Rotate

When a customer snapshot is stale, repeat its capture from `admin-base`. When
the Admin session is stale, refresh `admin-base` with `--empty`, then recapture
dependent customer profiles. Deleting a profile means deleting only its JSON
file below `.shopify-e2e/auth/profiles/`; the next operation that requires it
will fail rather than selecting another identity.

After suspected credential exposure, delete the affected local profiles,
invalidate the corresponding Shopify sessions, and recapture them. Rotate any
copied backups as well.

Playwright storage state is a snapshot, not a complete browser profile. It
ports cookies, localStorage, and IndexedDB captured by Playwright, but it does
not preserve sessionStorage, browser extensions, cache, or arbitrary disk state.

For bearer safety, profile-bearing operations accept only loopback CDP
endpoints. A remote CDP URL is rejected before a profile file is loaded.

## CLI Commands

| Command | Purpose |
| --- | --- |
| `shopify-e2e auth save` | Create or refresh one named profile after explicit confirmation. |
| `shopify-e2e open` | Inspect one existing profile in an isolated context. |
| `shopify-e2e doctor` | Diagnose configuration and selected-profile readiness. |
| `shopify-e2e run` | Validate one profile, prepare app fixtures, and run serial Playwright tests. |

Use command help for all profile, Chrome, store, and environment flags:

```sh
shopify-e2e auth save --help
shopify-e2e open --help
shopify-e2e run --help
shopify-e2e doctor --help
```

## Playwright Setup

Use the package global setup when live tests may also run directly through
Playwright:

```ts
import { defineConfig } from "@playwright/test";
import { globalSetupPath } from "shopify-e2e";

export default defineConfig({
	globalSetup: globalSetupPath,
	workers: 1,
	use: {
		screenshot: "off",
		trace: "off",
		video: "off",
	},
});
```

Global setup prepares Shopify only when live mode is enabled. Set
`SHOPIFY_E2E_LIVE=1` or `live: true`; `shopify-e2e run` enables it for the child
process. Non-live runs and `SHOPIFY_E2E_SKIP_GLOBAL_SETUP=1` return before
reading a profile file.

## Test API

Select one immutable profile per client. Always close the client in `finally`
before creating another profile client:

```ts
import { test } from "@playwright/test";
import { createShopifyE2E } from "shopify-e2e";

test("opens checkout", async () => {
	const shopify = await createShopifyE2E({ authProfile: "customer-a" });

	try {
		const variantId = await shopify.storefront.variantId({
			handle: "test-product",
		});

		await shopify.checkout.openCart({ variantId });
	} finally {
		await shopify.close();
	}
});
```

The client lazily creates one isolated context and one package-owned automated
page from the selected profile. It exposes:

- `shopify.admin.page()`, `open()`, and `goto()` for Admin navigation.
- `shopify.storefront.variantId()` and `unlock()` for storefront setup.
- `shopify.checkout.cartUrl()`, `openCart()`, `purchase()`, `complete()`, and
  `expectComplete()` for checkout workflows.
- `shopify.inputs` for slower input helpers when Shopify rejects instant typing.
- `shopify.close()` for idempotent context, connection, and lease cleanup.

Creating a second client before closing the first fails immediately. To switch
profiles, close client A and then create client B.

## Advanced Imports

The root export is intentionally small. Lower-level helpers are available from
explicit subpaths:

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

Prefer `createShopifyE2E` unless an advanced helper is required.

## Live Test Constraints

- Use one Playwright worker and one package-owned automated page.
- Close the active client before selecting another profile.
- Do not run parallel checkout or account tabs.
- Keep product, order, account, webhook, and database logic in the consuming app.
- Disable screenshots, traces, and video for authenticated live runs.
- Keep profile files, Chrome data, passwords, and local environment files out of git.

## Troubleshooting

Start with `shopify-e2e doctor --auth-profile <profile>`.

- Missing profile: capture that exact profile; no fallback occurs.
- Malformed profile: delete it and capture it again.
- Stale customer login: refresh from `admin-base`.
- Stale Admin login: refresh `admin-base` with `--empty`, then refresh customers.
- Chrome not found: set `SHOPIFY_E2E_CHROME_PATH` or pass `--chrome-path`.
- CDP unavailable: check `--cdp-port` and `--chrome-profile-path`.
- Storefront lock: set `SHOPIFY_E2E_STOREFRONT_PASSWORD` and, when necessary,
  `SHOPIFY_E2E_STOREFRONT_DOMAIN`.

## Development

```sh
npm run lint
npm run typecheck
npm test
npm run test:browser
npm run build
```

The browser gate launches bundled headless Chromium and exercises production
session/context creation with conflicting profile storage. It never connects to
the operator's Chrome/CDP session.

Reusable browser and Shopify interaction mechanics belong in this package.
Application assertions and fixture setup belong in the consuming project.

## License

MIT. See [LICENSE](LICENSE).
