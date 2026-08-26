# Backlog

Known follow-ups and enhancements that haven't shipped yet. Anything here
that gets built moves to `CHANGELOG.md` under its release and is removed
from this list — this file is only what's still outstanding.

## Feature
- [ ] Process for allowing the dashboard to be on a different device than the data management. Allowing many computers to log into the same "event" for maximum capabilities

## Code quality / maintainability

- [ ] **Split `js/app.js` into focused modules.** It carries auth, the
      Dropbox API calls, and all rendering in one ~950-line file (extracted
      from `index.html`'s inline `<script>` in 1.16.0 so the CSP could drop
      `'unsafe-inline'`). Splitting it further into e.g. `js/dropbox-api.js`
      / `js/render.js` would make it navigable and testable in pieces,
      without adding a build step.

## Reliability

- [ ] **Offline/queued writes.** A failed save currently surfaces an alert
      and drops the change — an operator has to redo the entry. Worth a
      small local queue that retries once connectivity returns, given the
      target environment (venue wifi) is exactly where this happens.
- [ ] **Bulk JSON editor replace-the-whole-file has no merge.** Since saving
      through the "Raw JSON" tab replaces the entire file, a concurrent edit
      made by someone else between opening the editor and hitting Save is
      silently overwritten (no merge) — acceptable for a power-user
      bulk-edit tool, but worth calling out in the UI if it becomes a
      recurring pain point. (Per-record validation on save — name
      uniqueness, media URL allowlist, transaction amounts — shipped in
      1.17.0.)

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
