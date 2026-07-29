<div align="center">

# @sematico/shopify-e2e

Run Playwright tests against a live Shopify store, one role at a time.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-3c873a?style=flat-square)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.61.1-2ead33?style=flat-square)](https://playwright.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org)

[Install](#install) · [Set up](#set-up) · [Write tests](#write-tests) · [Commands](#commands)

</div>

`shopify-e2e` gives your Shopify tests their own Playwright lane. It keeps them away from the rest of your application's browser tests, loads the saved state for each role, and runs every selected role in order.

The CLI always opens a visible Chromium window and uses one worker. It is meant for a developer running tests locally against a real Shopify store.

> [!IMPORTANT]
> This CLI does not support CI, headless runs, parallel roles, Playwright projects, or arbitrary Playwright arguments.

## Install

```sh
npm install --save-dev @sematico/shopify-e2e @playwright/test@1.61.1
npx playwright install chromium
```

The package is ESM-only and requires Node.js 20 or newer.

## Set up

Add `shopify-e2e.config.ts` to the root of your application:

```ts
import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";

export default defineShopifyE2EConfig({
	testDir: "tests/shopify-e2e",
	roles: ["guest", "admin"],
	retries: 1,
	reporter: [["html", { outputFolder: "playwright-report/shopify" }]],
	outputDir: "test-results/shopify",
	use: {
		trace: "off",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
});
```

This is a separate config for Shopify tests. The CLI does not load your application's normal `playwright.config.ts`.

The CLI owns these settings:

- `projects`
- `workers`
- `grep`
- `grepInvert`
- `use.storageState`
- `use.connectOptions`

Playwright still controls reporters, retries, timeouts, traces, screenshots, videos, hooks, web servers, and output folders.

Create an ignored `.env` file beside the config:

```dotenv
SHOPIFY_STORE_URL=https://your-store.myshopify.com/
SHOPIFY_STOREFRONT_PASSWORD=
```

`SHOPIFY_STOREFRONT_PASSWORD` is only needed for a password-protected storefront. Shell variables take priority over values in `.env`.

## Write tests

Tag each test with the role that should run it:

```ts
import { expect, test } from "@playwright/test";

test(
	"admin can view orders",
	{ tag: "@shopify-e2e-role-admin" },
	async ({ page }) => {
		await expect(page).toHaveURL(/orders/);
	},
);
```

Tests for more than one role can use a tag array:

```ts
test(
	"shared account page",
	{
		tag: ["@shopify-e2e-role-admin", "@shopify-e2e-role-customer"],
	},
	async ({ page }) => {
		await expect(page.locator("main")).toBeVisible();
	},
);
```

Only files inside the configured `testDir` are loaded.

### Storefront fixture

Attach the package fixture to your own Playwright test:

```ts
import { expect, test as base } from "@playwright/test";
import {
	shopifyFixtures,
	type ShopifyFixtures,
} from "@sematico/shopify-e2e/playwright";

const test = base.extend<ShopifyFixtures>(shopifyFixtures);

test("opens the storefront", async ({ page, storefront }) => {
	await storefront.open();
	await storefront.unlock();

	await expect(page.locator("main")).toBeVisible();
});
```

`storefront.open()` opens `SHOPIFY_STORE_URL`. `storefront.unlock()` reads the password from the environment and types it into Shopify's password form. Calling `unlock()` on an open storefront does nothing.

The package also exports `typeLikeHuman` for fields that should receive sequential keyboard input:

```ts
import { typeLikeHuman } from "@sematico/shopify-e2e/playwright";

await typeLikeHuman(page.getByLabel("Search"), "summer products");
```

> [!WARNING]
> Playwright traces can contain text entered one character at a time. Disable tracing when a test types a real password, and never commit `.env`, saved browser state, traces, screenshots, or videos containing credentials.

## Run tests

Check the project first:

```sh
npx shopify-e2e doctor
```

Capture browser state for each configured role:

```sh
npx shopify-e2e auth capture --role guest
npx shopify-e2e auth capture --role admin
```

The CLI opens Chromium and waits while you sign in. It saves state only after you confirm in the terminal.

Run one role or several:

```sh
npx shopify-e2e run --role admin
npx shopify-e2e run --role guest --role admin
```

If you omit the role in an interactive terminal, the CLI asks which configured roles to use:

```sh
npx shopify-e2e auth
npx shopify-e2e run
```

The selected roles follow the order in `shopify-e2e.config.ts`. Each role must finish before the next starts. A failed role stops the run.

## Trust and local data

Your config, hooks, reporters, web server, and test files are executable code and are treated as trusted.

Saved browser state can contain cookies, local storage, and IndexedDB data. The CLI stores it outside the project and separates it by Shopify origin and role. Treat that state like a password.

# Usage

<!-- usage -->
```sh-session
$ npm install -g @sematico/shopify-e2e
$ shopify-e2e COMMAND
running command...
$ shopify-e2e (--version)
@sematico/shopify-e2e/0.7.0 darwin-arm64 node-v24.18.0
$ shopify-e2e --help [COMMAND]
USAGE
  $ shopify-e2e COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`shopify-e2e auth`](#shopify-e2e-auth)
* [`shopify-e2e auth capture`](#shopify-e2e-auth-capture)
* [`shopify-e2e auth list`](#shopify-e2e-auth-list)
* [`shopify-e2e auth refresh`](#shopify-e2e-auth-refresh)
* [`shopify-e2e auth remove`](#shopify-e2e-auth-remove)
* [`shopify-e2e doctor`](#shopify-e2e-doctor)
* [`shopify-e2e run`](#shopify-e2e-run)

## `shopify-e2e auth`

Capture, refresh, remove, or inspect role-keyed browser authentication state. Credentials are entered only in the dedicated browser window.

```
USAGE
  $ shopify-e2e auth

DESCRIPTION
  Capture, refresh, remove, or inspect role-keyed browser authentication state. Credentials are entered only in the
  dedicated browser window.

EXAMPLES
  $ shopify-e2e auth
```

## `shopify-e2e auth capture`

Capture browser authentication state for one configured role in consumer-owned headed Chromium. The CLI never asks for credentials.

```
USAGE
  $ shopify-e2e auth capture [--role <value>]

FLAGS
  --role=<value>  Configured role (ASCII lower-kebab, max 64 UTF-8 bytes)

DESCRIPTION
  Capture browser authentication state for one configured role in consumer-owned headed Chromium. The CLI never asks for
  credentials.

EXAMPLES
  $ shopify-e2e auth capture --role admin
```

## `shopify-e2e auth list`

List configured and orphaned role-state readiness without loading Playwright.

```
USAGE
  $ shopify-e2e auth list

DESCRIPTION
  List configured and orphaned role-state readiness without loading Playwright.
```

## `shopify-e2e auth refresh`

Refresh browser authentication state for one configured role in consumer-owned headed Chromium.

```
USAGE
  $ shopify-e2e auth refresh [--role <value>]

FLAGS
  --role=<value>  Configured role (ASCII lower-kebab, max 64 UTF-8 bytes)

DESCRIPTION
  Refresh browser authentication state for one configured role in consumer-owned headed Chromium.

EXAMPLES
  $ shopify-e2e auth refresh --role customer
```

## `shopify-e2e auth remove`

Remove one saved role-keyed browser-authentication state for the configured Shopify store.

```
USAGE
  $ shopify-e2e auth remove [--role <value>] [--yes]

FLAGS
  --role=<value>  Role state name (ASCII lower-kebab, max 64 UTF-8 bytes)
  --yes           Skip confirmation. Non-interactive removal requires --role and --yes.

DESCRIPTION
  Remove one saved role-keyed browser-authentication state for the configured Shopify store.

EXAMPLES
  $ shopify-e2e auth remove

  $ shopify-e2e auth remove --role admin

  $ shopify-e2e auth remove --role admin --yes
```

## `shopify-e2e doctor`

Inspect bounded Shopify E2E readiness without running tests or launching a browser.

```
USAGE
  $ shopify-e2e doctor

DESCRIPTION
  Inspect bounded Shopify E2E readiness without running tests or launching a browser.
```

## `shopify-e2e run`

Run one or more Shopify roles serially through one headed Chromium instance. Run controls are package-owned; arbitrary Playwright arguments are not accepted. Playwright workers, projects, file selectors, reporter overrides, UI, and debug controls are intentionally unavailable.

```
USAGE
  $ shopify-e2e run [-g <value>] [--grep-invert <value>] [--role <value>...]

FLAGS
  -g, --grep=<value>         Run Shopify tests whose titles match this pattern
      --grep-invert=<value>  Exclude Shopify tests whose titles match this pattern
      --role=<value>...      Configured role to run (repeatable); omit in a terminal to select roles

DESCRIPTION
  Run one or more Shopify roles serially through one headed Chromium instance. Run controls are package-owned; arbitrary
  Playwright arguments are not accepted. Playwright workers, projects, file selectors, reporter overrides, UI, and debug
  controls are intentionally unavailable.
```
<!-- commandsstop -->

# License

This project is available under the [MIT License](./LICENSE).
