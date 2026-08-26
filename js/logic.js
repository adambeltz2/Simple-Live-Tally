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

    // Sums transaction amounts per entity for a given event. Entities with
    // no transactions still appear in the result with a total of 0.
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

    // Percentage of a value against a track/goal, clamped to [0, 100].
    function computeBarPercentage(amount, maxTotal) {
        if (!maxTotal || maxTotal <= 0) return 0;
        return Math.min((amount / maxTotal) * 100, 100);
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
    // instead of allowing a negative/zero entry here.
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

    // Exponential backoff delay (ms) for retrying a save after a 409
    // conflict, capped so retries don't grow unbounded.
    function computeRetryDelay(attempt, baseMs, maxMs) {
        const base = baseMs || 250;
        const cap = maxMs || 4000;
        return Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), cap);
    }

    // Drives the fetch -> mutate -> save cycle used by every data-changing
    // action in the app. Dependency-injected (fetchState/updateFn/saveState/
    // delay) so it has no DOM or network dependency of its own and can be
    // unit tested directly.
    //
    // Three failure modes this specifically guards against:
    //  - If fetchState() fails/throws, updateFn() must NOT run against
    //    stale local state, or a transaction already recorded locally gets
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

    // How many rows fit in availableHeight without scrolling, given the
    // measured height of one row and the gap between rows. Falls back to
    // showing everything if rowHeight can't be measured (e.g. rendered
    // off-screen or in an environment with no real layout engine) rather
    // than hiding entries no one asked to hide.
    function computeMaxVisibleRows(availableHeight, rowHeight, rowGap) {
        const gap = rowGap || 0;
        if (!rowHeight || rowHeight <= 0) return Infinity;
        return Math.max(1, Math.floor((availableHeight + gap) / (rowHeight + gap)));
    }

    // Shape-checks a parsed appData object (used by the bulk JSON editor).
    // Only checks the top-level contract the rest of the app relies on
    // (array vs. object fields) — not deep per-record validation.
    function validateAppDataShape(parsed) {
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { valid: false, error: 'Root value must be a JSON object.' };
        }
        const arrayFields = ['events', 'entities', 'transactions'];
        for (const field of arrayFields) {
            if (!Array.isArray(parsed[field])) {
                return { valid: false, error: `"${field}" must be an array.` };
            }
        }
        if (typeof parsed.settings !== 'object' || parsed.settings === null || Array.isArray(parsed.settings)) {
            return { valid: false, error: '"settings" must be an object.' };
        }
        return { valid: true };
    }

    // Per-record validation for the bulk JSON editor: the same checks the
    // individual entity/settings/transaction forms enforce (public name
    // required + unique, image/logo URL scheme allowlist, positive
    // transaction amounts), run across every record in an already
    // shape-valid appData object. Assumes validateAppDataShape() has
    // already passed, so entities/transactions are arrays and settings is
    // an object.
    function validateAppDataRecords(parsed) {
        const seenNames = new Set();
        for (const entity of parsed.entities) {
            const name = ((entity && entity.namePublic) || '').trim();
            if (!name) {
                return {
                    valid: false,
                    error: `Entity "${(entity && entity.id) || '(no id)'}" is missing a public name.`,
                };
            }
            const key = name.toLowerCase();
            if (seenNames.has(key)) {
                return { valid: false, error: `Duplicate entity public name: "${name}".` };
            }
            seenNames.add(key);
            if (!isAllowedMediaUrl(entity.imageUrl)) {
                return {
                    valid: false,
                    error: `Entity "${name}" has an invalid image URL (must be http:// or https://).`,
                };
            }
        }
        if (!isAllowedMediaUrl(parsed.settings.logoUrl)) {
            return { valid: false, error: 'Settings logo URL must be a valid http:// or https:// link.' };
        }
        for (const tx of parsed.transactions) {
            if (!isValidTransactionAmount(tx && tx.amount)) {
                return {
                    valid: false,
                    error: `Transaction "${(tx && tx.id) || '(no id)'}" has an invalid amount (must be a positive number).`,
                };
            }
        }
        return { valid: true };
    }

    // Parses and validates the bulk JSON editor's text in one step: a
    // JSON.parse() syntax error, a shape-validation failure, and a
    // per-record validation failure all come back through the same
    // { valid, error } / { valid, data } shape.
    function parseAppDataJson(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            return { valid: false, error: `Invalid JSON: ${error.message}` };
        }
        const shapeResult = validateAppDataShape(parsed);
        if (!shapeResult.valid) return shapeResult;
        const recordsResult = validateAppDataRecords(parsed);
        if (!recordsResult.valid) return recordsResult;
        return { valid: true, data: parsed };
    }

    const api = {
        escapeHtml,
        computeTotals,
        sortEntitiesByTotal,
        computeBarPercentage,
        computeGaugeGeometry,
        isDuplicateName,
        isValidTransactionAmount,
        isAllowedMediaUrl,
        computeRetryDelay,
        runUpdateWithRetry,
        computeMaxVisibleRows,
        validateAppDataShape,
        validateAppDataRecords,
        parseAppDataJson,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(root, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
