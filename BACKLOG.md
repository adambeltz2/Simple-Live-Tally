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

## Product

- [ ] **[FEATURE] Shared-link viewer connection (no Dropbox OAuth grant at all, not even a one-time one).**
      v2.4.0 shipped the "Viewer Link" hand-off (Settings > Second Device):
      the second device connects without doing its own Dropbox login, but
      it's still a real Dropbox OAuth token underneath, obtained via one
      read-only grant on the admin's device. A shared-link version would go
      further — the admin's browser periodically writes a small public
      summary file (just what a viewer needs to render: settings, active
      event, per-entity totals, overall total) and creates a Dropbox shared
      link to it; the second device just polls that plain URL, no OAuth
      concept involved at all. Needs: the `sharing.write` scope (not
      currently requested — enabling it means re-authenticating the admin's
      existing session once, since this app's token wouldn't have it),
      wiring a "write public summary" step into the existing 60s poll cycle
      in `js/app.js`, and extending `index.html`'s CSP `connect-src` to
      Dropbox's shared-link content domain. Tradeoff worth stating clearly
      in the UI if built: unlike the OAuth-based viewer link, a Dropbox
      shared link has no expiry and isn't revoked by generating a new
      one — revoking it means unsharing the file directly in Dropbox.

- [ ] **[FEATURE] Show which Dropbox account is connected, not just "Connected."**
      Every role (Admin, `#keyer`, `#tv-viewer`) has to sign into the exact
      same Dropbox account to see the same data — there's no other
      isolation between them. Right now the app never shows an account
      email anywhere, so a device authenticated against the wrong Dropbox
      account (a real mistake: someone at a keyer station signs into their
      own personal Dropbox instead of the organization's) fails silently —
      it just shows an empty/unrelated event with no error. A call to
      Dropbox's `/2/users/get_current_account` after connecting, showing the
      email next to "Connected" (or in the Disconnect confirmation), would
      make a mismatch obvious at setup time instead of discovered mid-event.

- [ ] **[FEATURE] Google Drive as a second storage provider.** The
      fetch/save/retry orchestration in `js/app.js` (`runUpdateWithRetry`,
      the offline write queue) already only talks to the interface in
      `js/providers/dropbox.js` (`getAuthUrl`/`exchangeCodeForToken`/
      `refreshAccessToken`/`fetchConfig`/`saveConfig`/`fetchLedger`/
      `writeLedgerEntry`), not to Dropbox's raw API — that extraction is
      done and covered by `test/providers/dropbox.test.js`. A
      `GoogleDriveProvider` implementing the same shape is real work, not a
      thin wrapper, for two confirmed reasons: (1) Drive's REST API has no
      equivalent to Dropbox's single-call `files/download_zip` — reading a
      whole ledger folder would mean `files.list` (paginated) plus batched
      `files.get` calls (Drive's batch endpoint caps at 100 requests per
      batch, still counted individually against quota), a real change to
      the flat-read-cost property the ledger design depends on; (2) Drive's
      `files.update` has no If-Match/ETag conditional-write support, so
      `saveConfig`'s clean "reject if it changed since I read it" guarantee
      (Dropbox's `rev` parameter) would become a racier read-then-compare-
      then-write for the shared config file. Before building this: spike
      the list+batch read pattern's real latency at a realistic transaction
      count, and settle whether Drive's ledger should use the same
      per-transaction-file shape or something coarser suited to Drive's
      strengths instead. Also needed regardless of the ledger question: a
      find-or-create-and-cache-folder-ID layer (Drive addresses files by ID,
      not path), a provider picker at sign-in time, and `index.html`'s CSP
      `connect-src` extended to Google's API hosts.

## Process

Every PR that fixes a bug or ships an enhancement should:
1. Add an entry under `[Unreleased]` (or the next version) in
   `CHANGELOG.md`.
2. Remove the corresponding item from this file, if one existed.
3. Add a new item here for anything it surfaces but doesn't fully resolve.
