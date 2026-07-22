# Levelogy password-protected acceptance consumer

This private consumer proves the CLI and manually attached storefront fixture against `https://levelogy-development.myshopify.com/`. It is a local, headed acceptance check. It is excluded from `npm run verify` and must never run in CI because it needs the live store, network access, consumer-owned Chromium, saved local role states, and the storefront password.

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

Keep `.env`, passwords, browser state, screenshots, traces, `test-results`, and `node_modules` uncommitted. The URL is already set in `.env.example`. Add the real password only to the copied consumer root `.env`:

```dotenv
SHOPIFY_STOREFRONT_PASSWORD=your-local-secret
```

The CLI loads that root `.env` and passes the environment to Playwright. The fixture reads the password only after it has verified the configured origin and the exact Shopify password form. Direct `npx playwright test` runs do not get package-owned dotenv loading; the consumer must provide its environment for those runs.

The consumer config explicitly disables tracing. Playwright 1.61.1 traces may contain sequentially typed values, so never enable tracing for this credential acceptance or retain/share an artifact that may contain the password.

## 1. Prepare both role states

```sh
shopify-e2e auth capture --role guest
shopify-e2e auth capture --role storefront-access
```

Capture the roles in their intended starting state and confirm each save in the terminal. The tracked test never receives a password argument and never attaches or unlocks fixtures automatically.

## 2. Run both roles serially

```sh
shopify-e2e run --role guest --role storefront-access
```

The CLI runs the configured order, `guest` then `storefront-access`, with one worker and no simultaneous tests. Each tagged test manually uses the consumer-owned fixture:

- `storefront.open()` opens the configured store.
- The first explicit `storefront.unlock()` unlocks the store when challenged or safely does nothing when the saved state is already unlocked.
- The second explicit `storefront.unlock()` proves the already-unlocked no-op.
- The test verifies a stable visible page with no remaining password challenge.

## 3. Repeat the same run

```sh
shopify-e2e run --role guest --role storefront-access
```

Expected: both roles pass again, still strictly serially, with one visible Chromium window for the command and no password form left after either test.

## Troubleshooting

- Missing Chromium: run `npx playwright install chromium` from this consumer.
- Missing password: set `SHOPIFY_STOREFRONT_PASSWORD` only in the ignored copied consumer root `.env`.
- Expired role state: run `shopify-e2e auth refresh --role <role>`; the CLI does not auto-refresh.
- Wrong origin partition: confirm `.env` contains the exact Levelogy `.myshopify.com` origin used during capture.
- Suspected state compromise: revoke the Shopify session first, then remove the relevant role state.

Do not convert this checklist into CI or store credentials, role state, credential-bearing traces, or other browser artifacts in repository files.
