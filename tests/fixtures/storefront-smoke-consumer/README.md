# Levelogy password-protected acceptance consumer

This private consumer manually proves the phase-two CLI against `https://levelogy-development.myshopify.com/`. It is excluded from `npm run verify`: it needs network access, consumer-owned Chromium, the storefront password, and a human storefront-unlock step.

## Prepare the CLI and consumer

From the package repository root:

```sh
npm run build
npm link
consumer="$(mktemp -d)/storefront-smoke-consumer"
mkdir "$consumer"
rsync -a \
	--exclude '.env' \
	--exclude 'node_modules' \
	--exclude 'test-results' \
	tests/fixtures/storefront-smoke-consumer/ "$consumer/"
cd "$consumer"
npm install
npm link @sematico/shopify-e2e --no-save
npx playwright install chromium
cp .env.example .env
```

The temporary copy keeps the consumer install and manual output outside the package repository. Keep every later command in that copied consumer directory. Rebuild the package before retesting source changes because the linked executable reads compiled files from `dist`.

Keep `.env`, passwords, browser state, screenshots, traces, `test-results`, and `node_modules` uncommitted. The URL is already set in `.env.example`; the storefront password is entered only in Chromium.

## 1. Capture the storefront access profile

```sh
shopify-e2e auth capture --role storefront-access --profile storefront-unlocked
```

In the dedicated headed browser, enter the Levelogy storefront password and wait for the storefront to appear. Return to the terminal and confirm the save. The CLI does not detect completion and must never receive the password in a terminal prompt.

## 2. Prove the saved storefront access lane

```sh
shopify-e2e run --profile storefront-unlocked
```

Expected: one storefront-access-tagged test passes, the storefront is visible, and no password challenge is present.

## 3. Prove explicit empty guest state

```sh
shopify-e2e run --profile guest
```

Expected: one guest-tagged test passes and the password challenge is visible. No guest profile file is created.

## 4. Refresh and prove the storefront access lane again

```sh
shopify-e2e auth refresh --profile storefront-unlocked
shopify-e2e run --profile storefront-unlocked
```

Unlock the storefront in the new dedicated browser if the password challenge appears, explicitly confirm replacement, and expect the storefront-access test to bypass the challenge again. A declined or failed refresh must leave the previous saved state usable.

## Troubleshooting

- Missing Chromium: run `npx playwright install chromium` from this consumer.
- Expired storefront access state: run the explicit refresh command; the CLI does not auto-refresh.
- Wrong origin partition: confirm `.env` contains the exact Levelogy `.myshopify.com` origin used during capture.
- Suspected state compromise: revoke the Shopify session first, then manually remove the relevant CLI application-data profile or data root.

Do not convert this checklist into CI or store credentials/profile state in repository files.
