# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.16.0] - 2026-08-25
### Security
- **Content-Security-Policy:** Added a strict CSP (`default-src 'self'`, no `'unsafe-inline'` anywhere) via a `<meta>` tag in `index.html`. Required extracting the app's inline `<script>` into `js/app.js` and its inline `<style>` block into `css/app.css` (CSP's script-src/style-src block inline content, not just `onclick="..."`-style attribute handlers), and replacing every `onclick="..."`/`onchange="..."` attribute and the one `javascript:` href with `addEventListener` — static elements bind directly, dynamically-rendered lists (events/entities/transactions) use one delegated listener per container via `data-action`/`data-id` attributes instead of re-binding on every render.
### Changed
- **`js/app.js` extracted from `index.html`.** All app logic (auth, Dropbox API calls, rendering, event wiring) now lives in its own file, loaded via `<script src="js/app.js">`. `tailwind.config.js`'s `content` glob updated to scan `js/*.js` too, since Tailwind classes referenced only inside JS template strings (badge/status colors, etc.) would otherwise silently stop being generated now that they're no longer in `index.html` itself.
- **ESLint:** dropped `eslint-plugin-html` (no longer needed — there's no more inline script in `index.html` to lint via it) and the `no-unused-vars` override that came with it; real unused-variable checking now applies to `js/app.js`, which caught two genuinely dead locals during this change.
### Added
- **DOM event-wiring tests (`test/dom.test.js`):** New test group dispatches real `click`/`change` events (dark mode toggle, tab navigation, the submit button, the active-event select, and a delegated list-button click) rather than calling app functions directly, so a wiring mistake in `bindStaticEventListeners()` would actually be caught.

## [1.15.0] - 2026-08-24
### Added
- **ESLint + Prettier:** `eslint.config.js` lints `js/logic.js`, `test/*.js`, `tailwind.config.js`, and — via `eslint-plugin-html` — the inline `<script>` in `index.html`. Prettier formats the standalone `.js` files (`index.html` is intentionally left out to avoid a large, low-value reformat of markup + script together). Both are wired into CI (`npm run lint`, `npm run format:check`) so style/correctness issues are caught before merge, not just on push.

## [1.14.0] - 2026-08-24
### Security
- **Constrained `imageUrl`/`logoUrl` to http(s) schemes:** Entity and logo image URLs were only HTML-escaped, with no scheme restriction. `isAllowedMediaUrl()` (`js/logic.js`) now rejects `javascript:`, `data:`, and other non-http(s) values in `addEntity`, `editEntity`, and `saveSettings`, before they're ever saved.
### Fixed
- **Unvalidated transaction amounts:** `submitTransaction()`/`editTransactionAmount()` only checked `isNaN`, silently accepting zero, negative, or absurd amounts. `isValidTransactionAmount()` now requires a finite positive number; corrections still go through the existing edit/delete tools.
- **401 mid-retry wasted a conflict-retry attempt:** `saveState()`'s 401 branch triggered `handleAuthFailure()` (which reloads the page) but returned `false`, so `runUpdateWithRetry` treated it as a retryable 409 conflict — burning an attempt and a backoff delay on something that was never going to succeed. `saveState()` now throws on 401, surfaced as a distinct `'save-failed'` status that `updateDataWrapper` doesn't retry.
### Added
- **README:** New "How It Works & Scope" section — explicit that this is a single-operator, manual-entry tool (not open public self-service voting), and that the single-`data.json` design isn't intended for high transaction volume or many concurrent operators.

## [1.13.0] - 2026-08-24
### Fixed
- **Submit button permanently stuck on "Setup Required":** `renderApp()`'s re-enable check was gated on `submitBtn.disabled` itself, which the button's own "Setup Required" state had already set to `true` — so once an event/team list went from empty to populated, the button could never recover. Re-enabling is now tracked via a dedicated `isSubmittingTransaction` flag instead of overloading the disabled state, which also still correctly protects the "Saving..." state during an in-flight submission.
- **Transaction submission always reported "saved" even on failure:** `submitTransaction()`'s completion handler ran unconditionally after `updateDataWrapper()` settled, regardless of whether the save actually succeeded. It now checks the real result and shows an accurate success/failure message.
- **Dashboard leaderboard scrollbar:** With more entries than fit on screen, the leaderboard scrolled internally. It now measures available space and shows as many rows as actually fit (with a small "+N more" note), instead of scrolling.
### Changed
- **Data Management layout:** Replaced the single long-scrolling two-column page with sub-tabs (Settings, Teams, Events, Transactions, Raw JSON), so each section fills the available height independently instead of forcing one continuous scroll across unrelated data.
- **Extracted more testable logic:** Row-fit math and JSON validation now live in `js/logic.js` alongside the rest. Top-level app state (`appData`, `accessToken`, etc.) switched from `let` to `var` so it's a real, introspectable `window` property rather than script-only lexical state — needed for the new DOM-level test suite, and generally useful for debugging.
### Added
- **Bulk JSON editor:** A new "Raw JSON" tab in Data Management for bulk edits — a textarea seeded with the current dataset, a Save button that validates JSON syntax and top-level shape before persisting (through the existing fetch/save/retry pipeline), and a Reload-from-server action. Invalid input is rejected with a specific error and never touches the saved data.
- **DOM-level test suite (`test/dom.test.js`):** Loads `index.html` into `jsdom` and exercises real app functions — tab navigation, dashboard rendering (including an XSS regression check at the DOM level), the JSON editor's full validate/confirm/save pipeline against a mocked `fetch`, and a regression test for the stuck-submit-button bug above.

## [1.12.0] - 2026-08-24
### Security
- **Stored XSS via team/event names and image URLs:** Entity names, event names, and image URLs were interpolated into `innerHTML` unescaped, so a crafted name or URL could break out of an attribute and run script — able to steal the Dropbox access token from `localStorage`. All render paths now escape untrusted strings through a shared `escapeHtml()` helper (`js/logic.js`).
### Fixed
- **Duplicate transactions on network failure:** `fetchState()` used to swallow fetch errors internally; if the pre-save refresh failed mid-save (e.g. flaky venue wifi), the in-flight update was re-applied against stale local state and could be recorded twice. Fetch failures now abort the update instead of proceeding.
- **Unbounded conflict retry:** A save that kept hitting a 409 conflict retried itself recursively with no cap. Retries are now bounded (5 attempts) with exponential backoff, surfacing a clear error if they're exhausted.
- **Forced re-login on token expiry:** The Dropbox OAuth flow now requests offline access and stores a refresh token, so an expired access token is silently renewed instead of forcing a full re-authentication (and app reload) mid-event.
### Changed
- **Production Tailwind build:** Replaced the `cdn.tailwindcss.com` runtime compiler (dev-only, per Tailwind's own docs) with a precompiled, minified `css/tailwind.css` generated via the Tailwind CLI. No GitHub Pages configuration changes required to deploy.
- **Extracted testable logic:** Totals, sorting, gauge geometry, duplicate-name checks, and the fetch/save/retry cycle now live in `js/logic.js`, covered by a `node --test` suite (`npm test`) with no new runtime dependencies.
### Added
- **`BACKLOG.md`:** Tracks known follow-ups and enhancements not yet built (validation gaps, CSP, further structural split, etc.), grouped by area. README now points to it and to this changelog as the project's ongoing record of fixes and enhancements.

## [1.11.0] - 2026-08-07
### Fixed
- **Management Input Compression:** Fixed a layout bug in the Data Management tab where the browser's native `datetime-local` input field was forcing the "Goal" number input to collapse on small screens. The event editing controls now utilize `flex-wrap` and explicit minimum widths to ensure all inputs remain usable.

## [1.10.0] - 2026-08-07
### Changed
- **TV Mode Top 10 Scaling:** Redesigned the sizing algorithm for TV Mode elements. The leaderboard view is now explicitly restricted to the Top 10 entities to perfectly fit standard 1080p display aspect ratios without ever showing a scrollbar. 
- **Absolute Bar Label Positioning:** Changed the rendering structure of the progress bars. The dollar amounts overlay is now positioned absolutely within the row relative to the background track, rather than inside the constrained width wrapper of the colored bar fill, preventing text cut-off on fractional percentages. 
### Fixed
- **TV Mode Ticker Display:** Fixed an issue where the top leaders ticker bar was forcefully hidden by an overly aggressive display state check in TV mode.

## [1.9.0] - 2026-08-07
### Changed
- **Optimistic UI Data Sync:** Overhauled the transaction submission logic. The dashboard updates instantly (0ms latency).
- **Viewport Constraints (Scrollbar Fix):** Re-engineered the application layout using strict flexbox boundaries (`h-screen`, `flex-1`, `min-h-0`). 
### Fixed
- **Ticker Overflow:** Fixed an issue where the top leaders scrolling ticker would clip its text against the bottom of the header container.

## [1.8.1] - 2026-08-07
### Fixed
- **Entity Uniqueness Validation:** Enforced strict case-insensitive uniqueness checks for public team names.