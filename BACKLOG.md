# Backlog

Known follow-ups and enhancements that haven't shipped yet. Anything here
that gets built moves to `CHANGELOG.md` under its release and is removed
from this list — this file is only what's still outstanding.

## Reliability

- [ ] **[DEBT] No ledger compaction/archival as an event approaches Dropbox's
      `download_zip` ceiling.** Every transaction add/edit/delete appends a
      new file under `/transactions/<eventId>/`; nothing is ever removed.
      An exceptionally long-running or high-volume event could in theory
      approach Dropbox's `download_zip` limits (10,000 files / 20GB per
      folder — see README's [How It Works & Scope](README.md#how-it-works--scope)),
      at which point `downloadTransactionEntries()` would start failing.
      Well beyond what a normal live event produces, but worth a compaction
      strategy (e.g. periodically collapsing old delta chains into a single
      snapshot entry) if it ever becomes a real constraint. Affected:
      `js/app.js` (`downloadTransactionEntries`), `js/logic.js`
      (`collapseTransactionLedger`).

- [ ] **[DEBT] TV field-grid page size and rotation interval are informed
      estimates, not measured against a real screen.** `TICKER_TV_FIELD_PAGE_SIZE`
      (18) and the 6-second rotation interval in `startTvFieldRotation()`
      (`js/app.js`) were sized to look right in a browser window during
      development, the same way the old hardcoded "top 10" TV cap was — not
      measured against an actual 1080p projector at event-room viewing
      distance, and not adaptive to how many field-grid columns a given
      screen actually fits. Worth revisiting either constant if real event
      usage at a large team count (20+) shows the pacing feels too fast/slow
      or a page ends up more sparsely filled than expected.

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
