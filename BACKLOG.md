# Backlog

Known follow-ups and enhancements that haven't shipped yet. Anything here
that gets built moves to `CHANGELOG.md` under its release and is removed
from this list — this file is only what's still outstanding.

## Feature
- [ ] Process for allowing the dashboard to be on a different device than the data management. Allowing many computers to log into the same "event" for maximum capabilities

## Security

- [ ] **Validate transaction amounts.** `submitTransaction()` /
      `editTransactionAmount()` only check `isNaN`, so negative, zero, or
      absurd values are accepted silently. Decide whether negative amounts
      are an intentional feature (refunds/corrections) — if so, label them
      as such in the UI; if not, reject them.
- [ ] **Add a Content-Security-Policy.** Blocked today by the inline
      `onclick="..."` handlers used throughout `index.html` — a strict CSP
      can't allow inline event handlers. Requires moving those to
      `addEventListener` first (see structural split below).
- [ ] **Constrain `imageUrl`/`logoUrl` schemes.** They're HTML-escaped
      (1.12.0) so attribute-breakout XSS is closed, but there's no scheme
      allowlist (e.g. restrict to `http(s)://`) for defense in depth.

## Code quality / maintainability

- [ ] **Finish the structural split.** `js/logic.js` (1.12.0) carries the
      pure totals/sort/gauge/retry logic, but DOM rendering, auth, and the
      Dropbox API calls are still one ~700-line inline `<script>` in
      `index.html`. Splitting those into their own files (e.g.
      `js/dropbox-api.js`, `js/render.js`) would make the file navigable
      and testable in pieces, without adding a build step.
- [ ] **Replace inline `onclick="..."` handlers with `addEventListener`.**
      Needed for the CSP item above, and makes the render functions easier
      to unit test.
- [ ] **Add ESLint + Prettier.** No lint/format config exists; add one and
      wire it into `.github/workflows/test.yml` so style issues are caught
      in CI, not just on push.

## Reliability

- [ ] **Tidy the 401-vs-retry interaction.** `saveState()`'s 401 branch
      calls `handleAuthFailure()` (which reloads the page) but still
      returns `false`, so a 401 mid-retry burns a retry attempt before the
      reload takes over. Harmless today, but worth cleaning up if the
      retry loop (`runUpdateWithRetry` in `js/logic.js`) grows more logic.
- [ ] **Offline/queued writes.** A failed save currently surfaces an alert
      and drops the change — an operator has to redo the entry. Worth a
      small local queue that retries once connectivity returns, given the
      target environment (venue wifi) is exactly where this happens.
- [ ] **Bulk JSON editor bypasses per-record validation.** Saving through
      the "Raw JSON" tab only checks the top-level shape (`validateAppDataShape`
      in `js/logic.js`) — it doesn't re-run entity name uniqueness or any
      future URL scheme allowlist the individual forms enforce. Also, since
      it replaces the entire file, a concurrent edit made by someone else
      between opening the editor and hitting Save is silently overwritten
      (no merge) — acceptable for a power-user bulk-edit tool, but worth
      calling out in the UI if it becomes a recurring pain point.

## Product / docs

- [ ] **Clarify the operating model in the README.** The feature list's
      "voting" language can read as open public self-service; the app is
      actually single-operator manual entry (an admin types in amounts).
      Worth a short paragraph making that explicit.
- [ ] **Document the BYOS scaling ceiling.** Everything lives in one
      `data.json` file in the operator's Dropbox App Folder — fine for a
      typical single-event fundraiser, not intended for very high
      transaction volume or many concurrent operators editing at once.

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
