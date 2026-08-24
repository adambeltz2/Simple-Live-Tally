# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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