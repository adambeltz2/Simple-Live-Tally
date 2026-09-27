// Pure logic shared by index.html (loaded as a plain <script>) and the
// Node test suite (loaded via require()). No DOM access here.
(function (root) {
    'use strict';

    const ESCAPE_MAP = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    };

    // Neutralizes HTML metacharacters so untrusted strings (entity names,
    // event names, URLs, settings) can be safely interpolated into
    // innerHTML template strings, including inside quoted attributes.
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
    }

    // Sums transaction amounts per entity for a given event. Works over the
    // flat, immutable ledger of transaction entries (creates, edit-deltas,
    // and delete-negatives all mixed together) — summing every entry's
    // amount already produces the correct current total, since an edit's
    // amount is the delta needed to reach the new value and a delete's
    // amount is the negative of the running total at the time it was
    // written. No collapsing/grouping needed for this calculation; see
    // collapseTransactionLedger() below for the view that does need it.
    // Entities with no entries still appear in the result with a total of 0.
    function computeTotals(entities, transactions, eventId) {
        const totals = {};
        (entities || []).forEach((e) => {
            totals[e.id] = 0;
        });
        (transactions || [])
            .filter((t) => t.eventId === eventId)
            .forEach((t) => {
                if (totals[t.entityId] !== undefined) totals[t.entityId] += t.amount;
            });
        return totals;
    }

    // Returns entities ordered highest-total-first (stable for ties).
    function sortEntitiesByTotal(entities, totals) {
        return [...(entities || [])].sort((a, b) => (totals[b.id] || 0) - (totals[a.id] || 0));
    }

    // SVG arc geometry for the goal gauge: how far along the dash array the
    // stroke should be drawn to represent totalRaised / goalAmount.
    function computeGaugeGeometry(totalRaised, goalAmount, dashArray) {
        const arrayLength = dashArray || 125.66;
        if (!goalAmount || goalAmount <= 0) {
            return { percentage: 0, dashOffset: arrayLength };
        }
        const percentage = Math.min((totalRaised / goalAmount) * 100, 100);
        const dashOffset = arrayLength - (arrayLength * percentage) / 100;
        return { percentage, dashOffset };
    }

    // Case-insensitive, trim-insensitive uniqueness check for public entity
    // names, optionally excluding one entity id (used when editing).
    function isDuplicateName(entities, namePublic, excludeId) {
        const target = (namePublic || '').trim().toLowerCase();
        return (entities || []).some((e) => {
            if (excludeId && e.id === excludeId) return false;
            return (e.namePublic || '').trim().toLowerCase() === target;
        });
    }

    // A transaction amount must be a finite positive number. Corrections to
    // a mis-entered amount go through editTransactionAmount() (or deletion)
    // instead of allowing a negative/zero entry here. Applies to the
    // *current net amount* an operator types into a form — the raw ledger
    // entry an edit/delete produces is allowed to be negative (see
    // computeEditDelta/computeDeleteAmount below), since that's the whole
    // point of a delta/negation entry.
    function isValidTransactionAmount(amount) {
        return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
    }

    // Restricts entity/logo image URLs to http(s) links. Empty/absent is
    // allowed since these fields are optional; anything that isn't a
    // parseable absolute http(s) URL (javascript:, data:, relative paths,
    // malformed input) is rejected.
    function isAllowedMediaUrl(value) {
        if (!value) return true;
        let url;
        try {
            url = new URL(value);
        } catch {
            return false;
        }
        return url.protocol === 'http:' || url.protocol === 'https:';
    }

    // URL hash for a display-only "viewer" device — a second computer that
    // only needs to show the live leaderboard, never add/edit data. Reuses
    // the exact same #tv styling (see checkViewMode() in js/app.js); the
    // only functional difference is the restricted OAuth scope requested
    // when signing in (see the active storage provider's viewerScope, e.g.
    // js/providers/dropbox.js).
    const VIEWER_HASH = '#tv-viewer';

    function isViewerHash(hash) {
        return hash === VIEWER_HASH;
    }

    // URL hash for a "keyer" device — a station where a volunteer only adds
    // donations, never touches Settings/Teams/Events. Unlike the viewer,
    // this needs a full read-write Dropbox token (it has to create
    // transaction entries), so there's no scope restriction possible here —
    // Dropbox has no concept of "write-only, and only under this one
    // subfolder." The restriction is UI-only: checkViewMode() hides every
    // management surface for this hash, same trust tier as the admin flow.
    const KEYER_HASH = '#keyer';

    function isKeyerHash(hash) {
        return hash === KEYER_HASH;
    }

    // Exponential backoff delay (ms) for retrying a save after a 409
    // conflict, capped so retries don't grow unbounded.
    function computeRetryDelay(attempt, baseMs, maxMs) {
        const base = baseMs || 250;
        const cap = maxMs || 4000;
        return Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), cap);
    }

    // Drives the fetch -> mutate -> save cycle used by config-changing
    // actions (Settings/Teams/Events — still a single shared file multiple
    // devices could edit concurrently). Transaction entries no longer go
    // through this: each is its own uniquely-named file that nothing else
    // ever writes to, so there's nothing to fetch-and-merge before saving
    // one (see writeTransactionEntry-style helpers in js/app.js). Dependency-
    // injected (fetchState/updateFn/saveState/delay) so it has no DOM or
    // network dependency of its own and can be unit tested directly.
    //
    // Three failure modes this specifically guards against:
    //  - If fetchState() fails/throws, updateFn() must NOT run against
    //    stale local state, or a change already recorded locally gets
    //    appended a second time on top of itself once the caller later
    //    succeeds. So a fetch failure aborts immediately.
    //  - A 409 conflict must not retry forever; it retries up to
    //    maxAttempts times with backoff, then gives up cleanly.
    //  - If saveState() throws (e.g. a 401 that's already triggering a
    //    re-auth/reload elsewhere), that isn't a retryable conflict — it
    //    must not burn a retry attempt/delay waiting on something that was
    //    never going to succeed.
    //
    // Returns one of:
    //   { status: 'success' }
    //   { status: 'fetch-failed', error }
    //   { status: 'save-failed', error }
    //   { status: 'conflict-exhausted' }
    async function runUpdateWithRetry({ fetchState, updateFn, saveState, delay, maxAttempts, retryDelay }) {
        const attempts = maxAttempts || 5;
        const delayFn = delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        const delayForAttempt = retryDelay || computeRetryDelay;

        try {
            await fetchState();
        } catch (error) {
            return { status: 'fetch-failed', error };
        }
        updateFn();

        for (let attempt = 1; attempt <= attempts; attempt++) {
            let success;
            try {
                success = await saveState();
            } catch (error) {
                return { status: 'save-failed', error };
            }
            if (success) return { status: 'success' };
            if (attempt === attempts) return { status: 'conflict-exhausted' };

            await delayFn(delayForAttempt(attempt));
            try {
                await fetchState();
            } catch (error) {
                return { status: 'fetch-failed', error };
            }
            updateFn();
        }
        return { status: 'conflict-exhausted' };
    }

    // Drains a queue of pending "attempt" functions one at a time, in
    // order, using the supplied run(attemptFn) callback (expected to
    // return the same { status, ... } shape runUpdateWithRetry does — every
    // queue item is already a fully-formed retry attempt, whether it's a
    // config save (wraps runUpdateWithRetry) or a single transaction-entry
    // upload, so run is normally just `(attemptFn) => attemptFn()`).
    // Stops at the first non-success result and leaves it — and everything
    // queued after it — in `remaining`, rather than dropping a write that
    // still hasn't saved. Returns which items succeeded (already removed
    // from the queue) so the caller can decide whether to re-render.
    async function flushPendingQueue(queue, run) {
        const remaining = [...queue];
        const succeeded = [];
        while (remaining.length > 0) {
            const result = await run(remaining[0]);
            if (result.status !== 'success') {
                return { succeeded, remaining };
            }
            succeeded.push(remaining.shift());
        }
        return { succeeded, remaining };
    }

    // Collapses the flat, immutable transaction-entry ledger (one file per
    // create/edit/delete, grouped by logicalId — see js/app.js) into "one
    // row per logical transaction" for the Data Management > Transactions
    // list, which needs to show/edit *current* amounts, not a raw delta
    // log. Groups entries by logicalId, sums each group's amount to get the
    // current net amount, and flags a group deleted if any entry in it has
    // kind 'delete' (a delete entry always zeroes the group's net amount by
    // construction, but checking kind directly is unambiguous even in the
    // edge case of a net-zero group that was never actually deleted).
    // Returns rows sorted newest-created-first, deleted ones excluded —
    // matching the old array-based list's behavior where a deleted
    // transaction simply disappeared.
    function collapseTransactionLedger(entries) {
        const groups = new Map();
        (entries || []).forEach((entry) => {
            if (!groups.has(entry.logicalId)) groups.set(entry.logicalId, []);
            groups.get(entry.logicalId).push(entry);
        });

        const rows = [];
        groups.forEach((group, logicalId) => {
            const isDeleted = group.some((e) => e.kind === 'delete');
            if (isDeleted) return;

            const sorted = [...group].sort((a, b) => new Date(a.createDate) - new Date(b.createDate));
            const first = sorted[0];
            const last = sorted[sorted.length - 1];
            const amount = group.reduce((sum, e) => sum + e.amount, 0);

            rows.push({
                id: logicalId,
                entityId: first.entityId,
                eventId: first.eventId,
                amount,
                createDate: first.createDate,
                modifiedDate: last.createDate,
                createdBy: first.createdBy,
            });
        });

        return rows.sort((a, b) => new Date(b.createDate) - new Date(a.createDate));
    }

    // The ledger entry amount for correcting a transaction from
    // currentAmount to newAmount without rewriting the original entry —
    // summing every entry for a logicalId (including this delta) must equal
    // newAmount.
    function computeEditDelta(currentAmount, newAmount) {
        return newAmount - currentAmount;
    }

    // The ledger entry amount for deleting a transaction without removing
    // any file — summing every entry for a logicalId (including this
    // negation) must equal exactly 0.
    function computeDeleteAmount(currentAmount) {
        return -currentAmount;
    }

    // Leaderboard layout thresholds for the "Minimal Ticker" design (see the
    // "Scoreboard Concepts" visual exploration this was picked from). A
    // short roster gets one column of full-size rows; a medium one splits
    // into two columns so the numbers stay large; past that only the top
    // TICKER_SPOTLIGHT_SIZE stay large ("spotlight") and everyone else moves
    // into a denser, wrapping grid ("field") instead of ever being hidden
    // behind a "+N more" note.
    const TICKER_HERO_MAX = 6;
    const TICKER_TWIN_MAX = 12;
    const TICKER_SPOTLIGHT_SIZE = 5;
    // On the TV display (never scrolls, read from a distance) the field
    // grid itself pages through TICKER_TV_FIELD_PAGE_SIZE entries at a time,
    // auto-rotating, once a roster is large enough that no single page could
    // show everyone at a legible size — see startTvFieldRotation() in
    // js/app.js. The dashboard has no such cap: the operator is right at the
    // screen, so its field grid just grows and scrolls.
    const TICKER_TV_FIELD_PAGE_SIZE = 18;

    function pickTickerTier(count) {
        if (count <= TICKER_HERO_MAX) return 'hero';
        if (count <= TICKER_TWIN_MAX) return 'twin';
        return 'spotlight';
    }

    // Splits list into consecutive pages of pageSize items, preserving
    // order. A non-positive/missing pageSize is treated as "one page with
    // everything" rather than throwing or looping forever.
    function paginate(list, pageSize) {
        if (!pageSize || pageSize <= 0) return [list];
        const pages = [];
        for (let i = 0; i < list.length; i += pageSize) {
            pages.push(list.slice(i, i + pageSize));
        }
        return pages;
    }

    const api = {
        escapeHtml,
        computeTotals,
        sortEntitiesByTotal,
        computeGaugeGeometry,
        isDuplicateName,
        isValidTransactionAmount,
        isAllowedMediaUrl,
        VIEWER_HASH,
        isViewerHash,
        KEYER_HASH,
        isKeyerHash,
        computeRetryDelay,
        runUpdateWithRetry,
        flushPendingQueue,
        collapseTransactionLedger,
        computeEditDelta,
        computeDeleteAmount,
        TICKER_HERO_MAX,
        TICKER_TWIN_MAX,
        TICKER_SPOTLIGHT_SIZE,
        TICKER_TV_FIELD_PAGE_SIZE,
        pickTickerTier,
        paginate,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(root, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
