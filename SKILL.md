# Touch Grass Mode Agent Skill

## Purpose

This repo is a local-first Chrome extension for traders who need an anti-revenge-trading circuit breaker.

When a large realized loss is detected on a trading webpage, the extension blocks the page with animated grass until a cooldown expires.

## Core product promise

"If your PnL says you should stop, your browser makes you touch grass."

## What the agent should do

When a user points you to this repo, help them set up the extension locally.

### Standard setup flow

1. Clone or open the repo.
2. Confirm the repo contains `manifest.json`, `src/content.js`, `src/overlay.css`, `src/popup.html`, and `src/options.html`.
3. Run `node scripts/smoke-test.js`.
4. Ask the user which trading site they want to test first only if it is not obvious.
5. Add the site's domain to the enabled domain list if needed.
6. Load the repo as an unpacked Chrome extension:
   - Open `chrome://extensions`
   - Enable Developer Mode
   - Click Load unpacked
   - Select the repo folder
7. Open the trading site.
8. Click the extension icon.
9. Click **Enable current site**.
10. Click **Check support**.
11. If PnL-like text is detected, click **Test overlay**.
12. Adjust PnL keywords and threshold in Options.

## Critical safety/privacy rules

Never ask for or store:

- Exchange passwords
- API keys
- Wallet private keys
- Seed phrases
- 2FA codes
- Personal identity documents

The extension should remain:

- Local-first
- No backend
- No analytics
- No remote scripts
- No trading execution
- No account control
- Visible page text only

## How detection works

The extension scans `document.body.innerText` on enabled domains.

It searches for configured PnL keywords, then parses nearby money-like negative values.

Trigger example:

- User threshold: `$500`
- Page shows: `Realized PnL -$720.55`
- Parsed loss: `-720.55`
- Result: overlay activates

Common supported formats include `-$720.55`, `($1,250.00)`, `USD -500`, `$-500`, and `-1.2k USDC`.

Pure percentages such as `-5.2%` are ignored by the USD loss detector.

## Known limitations

Detection may fail if the exchange renders PnL inside:

- Canvas
- Iframes
- Images
- Protected shadow DOM
- Obfuscated frontend components

If detection fails, instruct the user to:

1. Open the account / portfolio / realized PnL panel.
2. Add the exact PnL label to Options.
3. Use Check Support again.
4. If still not detected, create an exchange-specific adapter or move to API/OCR in a later version.

## Development principles

- Keep the extension simple.
- Avoid broad claims like "supports all exchanges".
- Add one exchange at a time.
- Keep all detection local in the content script unless the product direction explicitly changes.
- Do not add backend, analytics, login, API key support, wallet support, or trading execution.
- Prefer explicit support matrix statuses:
  - Supported
  - Experimental
  - Not tested
  - Unsupported
- Keep permissions minimal when preparing for Chrome Web Store.

## Static validation

Run this before handing work back:

```bash
node scripts/smoke-test.js
```

The smoke test checks manifest file references, JavaScript syntax, default settings consistency, and representative PnL parsing samples.

## Test checklist

- Extension loads unpacked without errors.
- Popup opens.
- Options page saves settings.
- Enable current site works.
- Support check returns domain and detection result.
- Test overlay appears.
- Countdown updates every second.
- Emergency unlock appears after configured delay.
- Overlay reappears after page refresh during active cooldown.
- Overlay disappears after cooldown expires.

## Suggested next build tasks

1. Add exchange-specific detector files:
   - `src/detectors/hyperliquid.js`
   - `src/detectors/binance.js`
   - `src/detectors/bybit.js`
   - `src/detectors/okx.js`
2. Replace generic regex-only parsing with structured detector results.
3. Add a local trade journal prompt after cooldown.
4. Add a Web Store permission profile without `<all_urls>`.
5. Add Playwright-based extension smoke tests.
