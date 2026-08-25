# Backlog

Known follow-ups and enhancements that haven't shipped yet. Anything here
that gets built moves to `CHANGELOG.md` under its release and is removed
from this list — this file is only what's still outstanding.

## Feature
- [ ] Process for allowing the dashboard to be on a different device than the data management. Allowing many computers to log into the same "event" for maximum capabilities

## Security

- [ ] **Add a Content-Security-Policy.** Blocked today by the inline
      `onclick="..."` handlers used throughout `index.html` — a strict CSP
      can't allow inline event handlers. Requires moving those to
      `addEventListener` first (see structural split below).

## Code quality / maintainability

- [ ] **Finish the structural split.** `js/logic.js` (1.12.0) carries the
      pure totals/sort/gauge/retry logic, but DOM rendering, auth, and the
      Dropbox API calls are still one ~700-line inline `<script>` in
      `index.html`. Splitting those into their own files (e.g.
      `js/dropbox-api.js`, `js/render.js`) would make the file navigable
      and testable in pieces, without adding a build step.
- [ ] **Replace inline `onclick="..."` handlers with `addEventListener`.**
      Needed for the CSP item above, and makes the render functions easier
      to unit test. Also re-enables `no-unused-vars` for `index.html` in
      `eslint.config.js` (currently off there — see the comment on that
      rule — because `eslint-plugin-html` can't see an `onclick="..."`
      attribute as a usage of the function it calls).

## Reliability

- [ ] **Offline/queued writes.** A failed save currently surfaces an alert
      and drops the change — an operator has to redo the entry. Worth a
      small local queue that retries once connectivity returns, given the
      target environment (venue wifi) is exactly where this happens.
- [ ] **Bulk JSON editor bypasses per-record validation.** Saving through
      the "Raw JSON" tab only checks the top-level shape (`validateAppDataShape`
      in `js/logic.js`) — it doesn't re-run entity name uniqueness, the
      `isAllowedMediaUrl` scheme allowlist, or the transaction amount check
      that the individual forms enforce. Also, since it replaces the entire
      file, a concurrent edit made by someone else between opening the
      editor and hitting Save is silently overwritten (no merge) —
      acceptable for a power-user bulk-edit tool, but worth calling out in
      the UI if it becomes a recurring pain point.

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
