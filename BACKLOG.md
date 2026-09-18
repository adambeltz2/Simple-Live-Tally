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

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
