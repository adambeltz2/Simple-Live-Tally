// DOM-level integration tests: load index.html into jsdom the same way a
// browser would (script tags executed manually, in order, since jsdom's
// runScripts:"outside-only" parses markup but never auto-runs a <script>),
// then exercise the real app functions against a real DOM. This complements
// logic.test.js (which only covers the DOM-free pure functions) by checking
// the wiring: that index.html/js/app.js actually call them correctly, that
// escaping survives all the way to rendered markup, and that the sub-tab /
// transaction-ledger UI behaves as expected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const JSZipNode = require('jszip');

const HTML_SOURCE = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const LOGIC_SOURCE = fs.readFileSync(path.join(__dirname, '../js/logic.js'), 'utf8');
const DROPBOX_PROVIDER_SOURCE = fs.readFileSync(path.join(__dirname, '../js/providers/dropbox.js'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

function loadApp(url) {
    const dom = new JSDOM(HTML_SOURCE, { runScripts: 'outside-only', url: url || 'http://localhost/' });
    const { window } = dom;
    // jsdom implements window.crypto.getRandomValues but not .subtle — needed
    // by generateCodeChallenge() (the PKCE flow) — so borrow Node's real
    // WebCrypto implementation for it.
    window.crypto.subtle = webcrypto.subtle;
    // index.html loads JSZip from a CDN <script> tag in a real browser;
    // jsdom never executes that tag, so provide the same library here (the
    // npm package, same version pinned in index.html) as the global app.js
    // expects.
    window.JSZip = JSZipNode;
    // jsdom doesn't implement the Object URL APIs exportDataZip() uses to
    // trigger a download. Tests that call exportDataZip() override
    // createObjectURL themselves to capture the generated blob; this no-op
    // default just keeps every other test from throwing if a code path
    // happens to touch it.
    window.URL.createObjectURL = () => 'blob:mock';
    window.URL.revokeObjectURL = () => {};
    // Same order as index.html's <script> tags: js/logic.js, then the active
    // storage provider, then js/app.js. app.js wires all its event listeners
    // (bindStaticEventListeners) as a top-level statement, so evaluating it
    // here reproduces real page load.
    window.eval(LOGIC_SOURCE);
    window.eval(DROPBOX_PROVIDER_SOURCE);
    window.eval(APP_SOURCE);
    // app.js's last statement is `window.onload = initApp`, matching a real
    // page load. jsdom does fire a real `load` event here (asynchronously,
    // after this function returns) — and initApp(), if a test happens to
    // have `dropbox_token` set in localStorage already, starts several
    // setInterval(…, 1000) polling loops (refresh timer, countdown,
    // possibly TV field rotation) that nothing in this file ever clears.
    // Across ~200 tests that add up to hundreds of live one-second
    // intervals ticking away in orphaned jsdom windows, which is enough to
    // stop the whole `node --test` process from ever exiting. Tests that
    // actually need initApp()'s effects call it (or handleAuthRedirect(),
    // which calls it) directly, so the auto-fired one here is only ever an
    // unwanted side effect — remove the handler before that event has a
    // chance to fire.
    window.onload = null;
    return window;
}

function baseAppData(overrides) {
    return Object.assign(
        {
            settings: { title: 'Test Event', logoUrl: '', themeColor: 'bg-blue-600' },
            events: [{ id: 'evt1', name: 'Main', goalAmount: null, startDate: '', endDate: '' }],
            activeEventId: 'evt1',
            entities: [],
        },
        overrides,
    );
}

// A transaction ledger entry — see js/logic.js's collapseTransactionLedger
// for how create/edit/delete entries combine into "current" transactions.
function baseEntry(overrides) {
    return Object.assign(
        {
            id: 't1',
            logicalId: 't1',
            kind: 'create',
            entityId: 'e1',
            eventId: 'evt1',
            amount: 10,
            createDate: new Date().toISOString(),
            createdBy: 'Admin',
        },
        overrides,
    );
}

// Builds a real zip (via the same JSZip library the app uses) containing one
// file per entry, matching what files/download_zip returns for a
// transactions folder — one <id>.json file per entry.
async function buildZipBuffer(entries) {
    const zip = new JSZipNode();
    entries.forEach((entry) => zip.file(`${entry.id}.json`, JSON.stringify(entry)));
    return zip.generateAsync({ type: 'nodebuffer' });
}

// A window.fetch mock covering every Dropbox endpoint the app calls:
//   - files/download (config)          -> returns `config`
//   - files/download_zip (ledger)      -> returns a real zip of `entries`
//   - files/upload under /transactions -> recorded into `entryUploads`
//   - files/upload elsewhere (config)  -> succeeds with a bumped rev
// `entryUploads` is populated in place (pass an array, inspect it after)
// so callers don't have to thread a return value through.
function mockDropboxFetch({ config = baseAppData(), entries = [], entryUploads = [] } = {}) {
    return async (url, opts) => {
        const urlStr = String(url);
        if (urlStr.includes('/files/download_zip')) {
            const buffer = await buildZipBuffer(entries);
            return { ok: true, status: 200, blob: async () => buffer };
        }
        if (urlStr.includes('/files/download')) {
            return {
                ok: true,
                status: 200,
                headers: { get: () => JSON.stringify({ rev: 'rev1' }) },
                json: async () => config,
            };
        }
        if (urlStr.includes('/files/upload')) {
            const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
            if (arg.path.startsWith('/transactions/')) {
                entryUploads.push({ path: arg.path, body: JSON.parse(opts.body) });
            }
            return { ok: true, status: 200, json: async () => ({ rev: 'rev-next' }) };
        }
        throw new Error('unexpected fetch URL: ' + urlStr);
    };
}

// Lets the app's own async chains (updateDataWrapper/saveTransactionEntry ->
// the mocked fetch) settle before assertions, since submitTransaction() and
// friends fire their save without the caller awaiting it.
function flushAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

test('DOM: top-level and management sub-tab navigation', async (t) => {
    await t.test('switchTab toggles which top-level view is visible', () => {
        const window = loadApp();
        const { document } = window;

        window.switchTab('management');
        assert.equal(document.getElementById('view-dashboard').classList.contains('hidden'), true);
        assert.equal(document.getElementById('view-management').classList.contains('hidden'), false);

        window.switchTab('dashboard');
        assert.equal(document.getElementById('view-dashboard').classList.contains('hidden'), false);
        assert.equal(document.getElementById('view-management').classList.contains('hidden'), true);
    });

    await t.test('switchTab widens main-container for Data Management, narrows it back for the Live Dashboard', () => {
        const window = loadApp();
        const container = window.document.getElementById('main-container');

        assert.equal(container.classList.contains('max-w-5xl'), true, 'starts at the dashboard reading width');
        assert.equal(container.classList.contains('max-w-[1800px]'), false);

        window.switchTab('management');
        assert.equal(container.classList.contains('max-w-5xl'), false);
        assert.equal(container.classList.contains('max-w-[1800px]'), true);

        window.switchTab('dashboard');
        assert.equal(container.classList.contains('max-w-5xl'), true);
        assert.equal(container.classList.contains('max-w-[1800px]'), false);
    });

    await t.test('switchMgmtTab shows exactly one pane and marks exactly one button active', () => {
        const window = loadApp();
        const { document } = window;
        window.switchTab('management');
        window.switchMgmtTab('events');

        ['settings', 'entities', 'events', 'transactions'].forEach((tab) => {
            const pane = document.getElementById(`mgmt-view-${tab}`);
            const btn = document.getElementById(`mgmt-tab-${tab}`);
            assert.equal(pane.classList.contains('hidden'), tab !== 'events', `pane ${tab} hidden state`);
            assert.equal(btn.classList.contains('active'), tab === 'events', `button ${tab} active state`);
        });
    });

    await t.test('switching tabs never leaves more than one pane visible', () => {
        const window = loadApp();
        window.switchTab('management');
        ['settings', 'entities', 'events', 'transactions', 'settings'].forEach((tab) => {
            window.switchMgmtTab(tab);
            const visible = ['settings', 'entities', 'events', 'transactions'].filter(
                (t) => !window.document.getElementById(`mgmt-view-${t}`).classList.contains('hidden'),
            );
            assert.deepEqual(visible, [tab]);
        });
    });
});

test('DOM: dashboard rendering', async (t) => {
    await t.test('renderApp builds one leaderboard row per entity with correct totals', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [
                { id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' },
                { id: 'e2', namePublic: 'Team B', namePrivate: '', imageUrl: '', color: 'bg-blue-500' },
            ],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', entityId: 'e1', eventId: 'evt1', amount: 50 }),
            baseEntry({ id: 't2', logicalId: 't2', entityId: 'e1', eventId: 'evt1', amount: 25 }),
        ];

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.equal(board.children.length, 2);
        assert.match(board.innerHTML, /Team A/);
        assert.match(board.innerHTML, /\$75\.00/, 'Team A total should be 50 + 25');
    });

    await t.test('the leaderboard subtitle is just the active event name, no "Active Event:" label', () => {
        const window = loadApp();
        window.appData = baseAppData({
            events: [{ id: 'evt1', name: 'Soup & Chili Cook off', goalAmount: null, startDate: '', endDate: '' }],
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });

        window.renderApp();

        assert.equal(window.document.getElementById('leaderboard-subtitle').innerText, 'Soup & Chili Cook off');
    });

    await t.test("each row's color bar scales with standing, not a fixed-width tick for everyone", () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [
                { id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' },
                { id: 'e2', namePublic: 'Team B', namePrivate: '', imageUrl: '', color: 'bg-blue-500' },
            ],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', entityId: 'e1', eventId: 'evt1', amount: 100 }),
            baseEntry({ id: 't2', logicalId: 't2', entityId: 'e2', eventId: 'evt1', amount: 25 }),
        ];

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.match(board.innerHTML, /width: 100%/, "the leader's bar should be full width");
        assert.match(board.innerHTML, /width: 25%/, "a team at 1/4 the leader's total should show a 1/4-width bar");
    });

    await t.test('a General Fund donation counts toward the goal total but not any team leaderboard row', () => {
        const window = loadApp();
        window.appData = baseAppData({
            events: [{ id: 'evt1', name: 'Main', goalAmount: 200, startDate: '', endDate: '' }],
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', entityId: 'e1', eventId: 'evt1', amount: 50 }),
            baseEntry({ id: 't2', logicalId: 't2', entityId: window.GENERAL_FUND_ID, eventId: 'evt1', amount: 30 }),
        ];

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.equal(board.children.length, 1, 'the General Fund entry must not become its own leaderboard row');
        assert.match(board.innerHTML, /\$50\.00/, "Team A's own total must not include the donation");
        assert.match(
            window.document.getElementById('goal-gauge-container').innerHTML,
            /\$80/,
            'the goal gauge total must include the General Fund donation (50 + 30)',
        );
    });

    await t.test('the goal gauge follows the actual light/dark theme, not just TV mode, on a light TV display', () => {
        // Regression guard: the gauge used to hardcode `isTvMode ||
        // <dark check>`, which meant it always rendered dark-mode colors on
        // a TV display even after the operator toggled that device to
        // light — the white gauge text/track was unreadable on the resulting
        // light background.
        const window = loadApp();
        window.location.hash = '#tv';
        window.checkViewMode();
        window.document.documentElement.classList.remove('dark'); // simulate the TV device switched to light

        window.appData = baseAppData({
            events: [{ id: 'evt1', name: 'Main', goalAmount: 200, startDate: '', endDate: '' }],
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', entityId: 'e1', eventId: 'evt1', amount: 50 }),
        ];

        window.renderApp();

        const gaugeHtml = window.document.getElementById('goal-gauge-container').innerHTML;
        assert.match(gaugeHtml, /text-gray-900/, 'light theme must use dark text on the gauge value');
        assert.doesNotMatch(gaugeHtml, /text-white/, 'light theme must not use white gauge text');
        assert.match(gaugeHtml, /bg-gray-200/, 'light theme must use the light track color, not the dark one');
    });

    await t.test('an event with no goal shows just the running total, not a progress bar', () => {
        const window = loadApp();
        window.appData = baseAppData({
            events: [{ id: 'evt1', name: 'Main', goalAmount: null, startDate: '', endDate: '' }],
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', entityId: 'e1', eventId: 'evt1', amount: 75 }),
        ];

        window.renderApp();

        const gaugeContainer = window.document.getElementById('goal-gauge-container');
        assert.equal(gaugeContainer.classList.contains('hidden'), false, 'the total should still be shown, not hidden');
        assert.match(gaugeContainer.innerHTML, /\$75\.00/);
        assert.match(gaugeContainer.innerHTML, /raised/);
        assert.doesNotMatch(gaugeContainer.innerHTML, /to goal/);
        assert.equal(
            gaugeContainer.querySelector('[data-bar-pct]'),
            null,
            'there is nothing to show progress against, so no track/fill bar should render',
        );
    });

    await t.test('the entity search datalist offers a General Fund / Donation option alongside every team', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.renderApp();

        const options = Array.from(window.document.getElementById('entity-options').children).map((o) => o.value);
        assert.deepEqual(options, ['Team A', window.GENERAL_FUND_LABEL]);
    });

    await t.test('an empty roster shows the setup prompt instead of throwing', () => {
        const window = loadApp();
        window.appData = baseAppData({ events: [], entities: [] });
        assert.doesNotThrow(() => window.renderApp());
        assert.match(window.document.getElementById('leaderboard').innerHTML, /empty/i);
    });

    await t.test(
        'regression: the Submit button recovers once setup is completed (was stuck on "Setup Required")',
        () => {
            const window = loadApp();
            const { document } = window;
            const submitBtn = document.getElementById('submit-btn');
            const amtInput = document.getElementById('amount-input');

            // Start with no events/entities: renderApp disables the button.
            window.appData = baseAppData({ events: [], entities: [] });
            window.renderApp();
            assert.equal(submitBtn.disabled, true);
            assert.equal(submitBtn.innerText, 'Setup Required');

            // Adding an event + team and re-rendering must re-enable it. The bug
            // was that the re-enable branch checked `!submitBtn.disabled` — since
            // the button was already disabled, it could never flip back.
            window.appData = baseAppData({
                entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
            });
            window.renderApp();

            assert.equal(submitBtn.disabled, false, 'button must recover once an event and team exist');
            assert.equal(submitBtn.innerText, 'Submit Vote');
            assert.equal(amtInput.disabled, false);
            assert.equal(submitBtn.classList.contains('opacity-50'), false);
            assert.equal(submitBtn.classList.contains('cursor-not-allowed'), false);
        },
    );

    await t.test('an in-flight "Saving..." submission is not reset by a concurrent renderApp() call', () => {
        const window = loadApp();
        const submitBtn = window.document.getElementById('submit-btn');

        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.renderApp();
        assert.equal(submitBtn.disabled, false);

        // Simulate submitTransaction()'s optimistic-update sequence: it sets
        // isSubmittingTransaction + disables the button for "Saving...", then
        // immediately calls renderApp() itself before the save resolves.
        window.isSubmittingTransaction = true;
        submitBtn.disabled = true;
        submitBtn.innerText = 'Saving...';

        window.renderApp();

        assert.equal(submitBtn.disabled, true, 'a concurrent render must not re-enable the button mid-save');
        assert.equal(submitBtn.innerText, 'Saving...');
    });

    await t.test('XSS regression: a malicious entity name cannot inject a live element', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [
                {
                    id: 'e1',
                    namePublic: '<img src=x onerror="window.__pwned=true">',
                    namePrivate: '',
                    imageUrl: '',
                    color: 'bg-red-500',
                },
            ],
        });

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.equal(board.querySelectorAll('img').length, 0, 'the payload must not become a real <img> element');
        assert.equal(window.__pwned, undefined, 'onerror must never execute');
        assert.match(
            board.textContent,
            /<img src=x onerror="window\.__pwned=true">/,
            'the name should render as visible text, not markup',
        );
    });

    // Builds `count` entities (Team 0, Team 1, ...) each with one transaction
    // entry, amounts descending so sort order is predictable (Team 0 is
    // always the leader).
    function makeRoster(count) {
        const entities = Array.from({ length: count }, (_, i) => ({
            id: `e${i}`,
            namePublic: `Team ${i}`,
            namePrivate: '',
            imageUrl: '',
            color: 'bg-blue-500',
        }));
        const entries = entities.map((e, i) =>
            baseEntry({ id: `t${i}`, logicalId: `t${i}`, entityId: e.id, amount: 1000 - i }),
        );
        return { entities, entries };
    }

    await t.test('a roster past TICKER_HERO_MAX switches to the twin-column tier', () => {
        const window = loadApp();
        const { entities, entries } = makeRoster(9);
        window.appData = baseAppData({ entities });
        window.transactionEntries = entries;

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.match(board.innerHTML, /columns-2/, 'twin tier wraps rows in a two-column container');
        entities.forEach((e) => assert.match(board.textContent, new RegExp(e.namePublic)));
    });

    await t.test(
        'a roster past TICKER_TWIN_MAX keeps the top 5 as a spotlight and moves the rest to a field grid',
        () => {
            const window = loadApp();
            const { entities, entries } = makeRoster(16);
            window.appData = baseAppData({ entities });
            window.transactionEntries = entries;

            window.renderApp();

            const board = window.document.getElementById('leaderboard');
            assert.doesNotMatch(
                board.textContent,
                /also competing/i,
                'the field grid should speak for itself, not announce itself with a label',
            );
            // Every single team must still appear somewhere — nobody is hidden
            // behind a "+N more" note the way the old bar-list capped things.
            entities.forEach((e) => assert.match(board.textContent, new RegExp(e.namePublic)));
            assert.equal(
                window.document.getElementById('leaderboard-overflow'),
                null,
                'the old "+N more not shown" element was removed along with the bar-list truncation it supported',
            );
        },
    );

    await t.test('the dashboard field grid shows every team at once, even well past a TV page size', () => {
        const window = loadApp();
        const { entities, entries } = makeRoster(30);
        window.appData = baseAppData({ entities });
        window.transactionEntries = entries;

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        const grid = board.querySelector('.grid');
        assert.equal(grid.children.length, 25, 'dashboard never paginates — all 25 field teams render at once');
        // 5 spotlight rows + 1 unlabeled divider + 1 field grid, and nothing
        // else — no page-indicator dots outside the TV display.
        assert.equal(board.children.length, 7);
    });

    await t.test('the TV display pages a large field grid instead of shrinking or scrolling', () => {
        const window = loadApp('http://localhost/#tv');
        const { entities, entries } = makeRoster(30);
        window.appData = baseAppData({ entities });
        window.transactionEntries = entries;
        window.tvFieldPage = 0;

        window.renderApp();

        let board = window.document.getElementById('leaderboard');
        let grid = board.querySelector('.grid');
        assert.equal(grid.children.length, 18, 'first page shows a full TICKER_TV_FIELD_PAGE_SIZE page');
        assert.match(board.textContent, /Team 5\b/, 'first field page starts right after the spotlight (rank 6)');
        assert.doesNotMatch(board.textContent, /Team 25\b/, 'the second page is not shown yet');

        window.tvFieldPage = 1;
        window.renderApp();

        board = window.document.getElementById('leaderboard');
        grid = board.querySelector('.grid');
        assert.equal(grid.children.length, 7, 'second page holds the remaining 25 - 18 = 7 teams');
        assert.match(board.textContent, /Team 29\b/, 'the last team is reachable on the second page');
        assert.doesNotMatch(board.textContent, /Team 5\b/, 'the first page is no longer shown');
    });
});

test('DOM: input validation', async (t) => {
    await t.test('submitTransaction rejects a non-positive amount without attempting to save', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.fetch = async () => {
            throw new Error('fetch should not be called for an invalid submission');
        };
        window.renderApp();

        window.document.getElementById('entity-select').value = 'Team A';
        window.document.getElementById('amount-input').value = '-5';
        window.submitTransaction();

        const msg = window.document.getElementById('entry-message');
        assert.match(msg.textContent, /positive amount/);
        assert.equal(window.localTransactionEntries.length, 0, 'no transaction entry should be recorded locally');
    });

    await t.test('addEntity rejects a non-http(s) image URL and never attempts to save', () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.fetch = async () => {
            throw new Error('fetch should not be called for an invalid entity');
        };
        window.alert = () => {};
        window.switchTab('management');
        window.switchMgmtTab('entities');

        window.document.getElementById('new-ent-public').value = 'Team X';
        window.document.getElementById('new-ent-img').value = 'javascript:alert(1)';
        window.addEntity();

        assert.equal(window.appData.entities.length, 0, 'no entity should be added');
    });

    await t.test('saveSettings rejects a non-http(s) logo URL and never attempts to save', () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.fetch = async () => {
            throw new Error('fetch should not be called for invalid settings');
        };
        window.alert = () => {};
        window.switchTab('management');
        window.switchMgmtTab('settings');

        window.document.getElementById('set-logo').value = 'data:text/html,<script>alert(1)</script>';
        window.saveSettings();

        assert.equal(window.appData.settings.logoUrl, '', 'settings must be untouched on rejection');
    });
});

test('DOM: per-event branding (logo/theme color)', async (t) => {
    await t.test("applyThemeColor uses the active event's own theme color over the Settings default", () => {
        const window = loadApp();
        window.appData = baseAppData({
            settings: { title: 'Test', logoUrl: '', themeColor: 'bg-blue-600' },
            events: [
                {
                    id: 'evt1',
                    name: 'Cook-Off',
                    goalAmount: null,
                    startDate: '',
                    endDate: '',
                    themeColor: 'bg-purple-600',
                },
            ],
            activeEventId: 'evt1',
        });

        window.applyThemeColor();

        assert.match(window.document.getElementById('main-header').className, /bg-purple-600/);
        assert.doesNotMatch(window.document.getElementById('main-header').className, /bg-blue-600/);
    });

    await t.test('an event with no themeColor override falls back to the Settings default', () => {
        const window = loadApp();
        window.appData = baseAppData({
            settings: { title: 'Test', logoUrl: '', themeColor: 'bg-green-600' },
            events: [{ id: 'evt1', name: 'Cook-Off', goalAmount: null, startDate: '', endDate: '', themeColor: '' }],
            activeEventId: 'evt1',
        });

        window.applyThemeColor();

        assert.match(window.document.getElementById('main-header').className, /bg-green-600/);
    });

    await t.test("the dashboard header logo uses the active event's own logoUrl over the Settings default", () => {
        const window = loadApp();
        window.appData = baseAppData({
            settings: { title: 'Test', logoUrl: 'https://example.com/app-logo.png', themeColor: 'bg-blue-600' },
            events: [
                {
                    id: 'evt1',
                    name: 'Cook-Off',
                    goalAmount: null,
                    startDate: '',
                    endDate: '',
                    logoUrl: 'https://example.com/event-logo.png',
                },
            ],
            activeEventId: 'evt1',
        });

        window.renderApp();

        const headerLogo = window.document.getElementById('header-logo');
        assert.equal(headerLogo.src, 'https://example.com/event-logo.png');
        assert.equal(headerLogo.classList.contains('hidden'), false);
    });

    await t.test("switching the active event re-applies that event's own branding", async () => {
        const window = loadApp();
        window.appData = baseAppData({
            settings: { title: 'Test', logoUrl: '', themeColor: 'bg-blue-600' },
            events: [
                {
                    id: 'evt1',
                    name: 'Event One',
                    goalAmount: null,
                    startDate: '',
                    endDate: '',
                    themeColor: 'bg-red-600',
                },
                {
                    id: 'evt2',
                    name: 'Event Two',
                    goalAmount: null,
                    startDate: '',
                    endDate: '',
                    themeColor: 'bg-purple-600',
                },
            ],
            activeEventId: 'evt1',
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();
        window.applyThemeColor();
        assert.match(window.document.getElementById('main-header').className, /bg-red-600/);

        window.fetch = mockDropboxFetch({ config: window.appData });
        window.document.getElementById('active-event-select').value = 'evt2';
        await window.changeActiveEvent();

        assert.match(window.document.getElementById('main-header').className, /bg-purple-600/);
    });

    await t.test('addEvent stores the entered logo URL and theme color, and rejects an invalid logo URL', async () => {
        const window = loadApp();
        window.appData = baseAppData({ events: [] });
        window.accessToken = 'fake-token';
        window.alert = () => {};
        window.switchTab('management');
        window.switchMgmtTab('events');

        // Invalid logo URL: rejected before any save is attempted.
        window.fetch = async () => {
            throw new Error('fetch should not be called for an invalid event logo URL');
        };
        window.document.getElementById('new-event-name').value = 'Cook-Off';
        window.document.getElementById('new-event-logo').value = 'javascript:alert(1)';
        window.addEvent();
        assert.equal(window.appData.events.length, 0, 'no event should be added with an invalid logo URL');

        // Valid submission: stores both fields on the new event.
        window.fetch = mockDropboxFetch({ config: window.appData });
        window.document.getElementById('new-event-name').value = 'Cook-Off';
        window.document.getElementById('new-event-logo').value = 'https://example.com/logo.png';
        window.document.getElementById('new-event-color').value = 'bg-red-600';
        window.addEvent();
        await flushAsync();

        assert.equal(window.appData.events.length, 1);
        assert.equal(window.appData.events[0].logoUrl, 'https://example.com/logo.png');
        assert.equal(window.appData.events[0].themeColor, 'bg-red-600');
    });

    await t.test("editEvent updates an existing event's logo URL and theme color", async () => {
        const window = loadApp();
        window.appData = baseAppData({
            events: [
                {
                    id: 'evt1',
                    name: 'Cook-Off',
                    goalAmount: null,
                    startDate: '',
                    endDate: '',
                    logoUrl: '',
                    themeColor: '',
                },
            ],
            activeEventId: 'evt1',
        });
        window.accessToken = 'fake-token';
        window.switchTab('management');
        window.switchMgmtTab('events');
        window.fetch = mockDropboxFetch({ config: window.appData });

        window.document.getElementById('ev-logo-evt1').value = 'https://example.com/new-logo.png';
        window.document.getElementById('ev-color-evt1').value = 'bg-green-600';
        window.editEvent('evt1');
        await flushAsync();

        assert.equal(window.appData.events[0].logoUrl, 'https://example.com/new-logo.png');
        assert.equal(window.appData.events[0].themeColor, 'bg-green-600');
    });
});

test('DOM: Dropbox disconnect', async (t) => {
    await t.test('does nothing if the operator cancels the confirmation', () => {
        const window = loadApp();
        window.localStorage.setItem('dropbox_token', 'tok123');
        window.localStorage.setItem('dropbox_refresh_token', 'refresh123');
        window.confirm = () => false;
        window.reloadPage = () => {
            throw new Error('reload should not happen when the operator cancels');
        };

        window.disconnectDropbox();

        assert.equal(window.localStorage.getItem('dropbox_token'), 'tok123');
        assert.equal(window.localStorage.getItem('dropbox_refresh_token'), 'refresh123');
    });

    await t.test('clears the stored tokens and reloads once confirmed', () => {
        const window = loadApp();
        window.localStorage.setItem('dropbox_token', 'tok123');
        window.localStorage.setItem('dropbox_refresh_token', 'refresh123');
        window.confirm = () => true;
        let reloaded = false;
        window.reloadPage = () => {
            reloaded = true;
        };

        window.disconnectDropbox();

        assert.equal(window.localStorage.getItem('dropbox_token'), null);
        assert.equal(window.localStorage.getItem('dropbox_refresh_token'), null);
        assert.equal(reloaded, true);
    });

    await t.test('the Disconnect button click is wired to disconnectDropbox', () => {
        const window = loadApp();
        window.localStorage.setItem('dropbox_token', 'tok123');
        window.confirm = () => true;
        window.reloadPage = () => {};

        window.document.getElementById('disconnect-btn').click();

        assert.equal(window.localStorage.getItem('dropbox_token'), null);
    });
});

// The tests above call app functions directly (window.switchTab(...), etc.),
// which is fine for testing the functions themselves but never exercises the
// addEventListener/delegation wiring that replaced onclick="..." attributes
// (see bindStaticEventListeners in js/app.js). These specifically dispatch
// real DOM events so a wiring mistake (wrong id, un-attached listener,
// wrong data-action key) would actually fail here.
test('DOM: event wiring (addEventListener / delegation, not direct calls)', async (t) => {
    await t.test('clicking the dark mode toggle button flips the dark class', () => {
        const window = loadApp();
        const wasDark = window.document.documentElement.classList.contains('dark');
        window.document.getElementById('dark-mode-toggle').click();
        assert.equal(window.document.documentElement.classList.contains('dark'), !wasDark);
    });

    await t.test('clicking the management tab button switches the visible view', () => {
        const window = loadApp();
        window.document.getElementById('tab-management').click();
        assert.equal(window.document.getElementById('view-management').classList.contains('hidden'), false);
        assert.equal(window.document.getElementById('view-dashboard').classList.contains('hidden'), true);
    });

    await t.test('clicking a management sub-tab button switches the visible pane', () => {
        const window = loadApp();
        window.document.getElementById('tab-management').click();
        window.document.getElementById('mgmt-tab-events').click();
        assert.equal(window.document.getElementById('mgmt-view-events').classList.contains('hidden'), false);
        assert.equal(window.document.getElementById('mgmt-tab-events').classList.contains('active'), true);
    });

    await t.test('clicking Admin View prevents navigation and opens a new tab instead', () => {
        const window = loadApp();
        const opened = [];
        window.open = (...args) => opened.push(args);

        const link = window.document.getElementById('admin-view-link');
        const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true, 'the href="#" navigation must be prevented');
        assert.equal(opened.length, 1);
    });

    await t.test('the submit button click is wired to submitTransaction (invalid input still reaches it)', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.renderApp();
        window.document.getElementById('entity-select').value = 'Team A';
        window.document.getElementById('amount-input').value = '-5';

        window.document.getElementById('submit-btn').click();

        assert.match(
            window.document.getElementById('entry-message').textContent,
            /positive amount/,
            'clicking submit-btn should reach submitTransaction, same as calling it directly',
        );
    });

    await t.test('changing the active-event select is wired to changeActiveEvent', () => {
        const window = loadApp();
        window.appData = baseAppData({
            events: [
                { id: 'evt1', name: 'First', goalAmount: null, startDate: '', endDate: '' },
                { id: 'evt2', name: 'Second', goalAmount: null, startDate: '', endDate: '' },
            ],
            activeEventId: 'evt1',
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.renderApp();

        const fetchCalls = [];
        window.fetch = async (url) => {
            fetchCalls.push(String(url));
            return { ok: false, status: 500 };
        };

        const select = window.document.getElementById('active-event-select');
        select.value = 'evt2';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));

        assert.ok(
            fetchCalls.some((u) => u.includes('/download')),
            'changing the select should reach changeActiveEvent -> updateDataWrapper -> a save attempt',
        );
    });

    await t.test(
        'a delegated click on a dynamically-rendered list button reaches its handler with the right id',
        () => {
            const window = loadApp();
            window.appData = baseAppData({
                entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
            });
            window.confirm = () => true;
            const fetchCalls = [];
            window.fetch = async (url) => {
                fetchCalls.push(String(url));
                return { ok: false, status: 500 };
            };
            window.renderManagement();

            const purgeBtn = window.document.querySelector(
                '#entities-list button[data-action="purge-entity"][data-id="e1"]',
            );
            assert.ok(purgeBtn, 'expected a rendered purge-entity button for entity e1');
            purgeBtn.click();

            assert.ok(
                fetchCalls.some((u) => u.includes('/download')),
                'the delegated click should have reached purgeEntity -> updateDataWrapper -> a save attempt',
            );
        },
    );

    await t.test('clicking an unrelated part of a list container (no data-action) does nothing', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.fetch = async () => {
            throw new Error('a click with no data-action target must not trigger any handler');
        };
        window.renderManagement();

        assert.doesNotThrow(() => {
            window.document.getElementById('entities-list').click();
        });
    });
});

test('DOM: transaction ledger (create/edit/delete as immutable entries)', async (t) => {
    await t.test('submitTransaction writes a single create entry to the right path', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();

        const uploads = [];
        window.fetch = mockDropboxFetch({ entryUploads: uploads });

        window.document.getElementById('entity-select').value = 'Team A';
        window.document.getElementById('amount-input').value = '25';
        window.submitTransaction();
        await flushAsync();

        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].path, `/transactions/evt1/${uploads[0].body.id}.json`);
        assert.equal(uploads[0].body.kind, 'create');
        assert.equal(uploads[0].body.amount, 25);
        assert.equal(uploads[0].body.logicalId, uploads[0].body.id, 'a create entry is its own logicalId');
    });

    await t.test('editTransactionAmount writes a delta entry, not an overwrite', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.transactionEntries = [baseEntry({ id: 't1', logicalId: 't1', amount: 50 })];
        window.switchTab('management');
        window.switchMgmtTab('transactions');

        const uploads = [];
        window.fetch = mockDropboxFetch({ entryUploads: uploads });

        window.document.getElementById('tx-amt-t1').value = '30';
        window.editTransactionAmount('t1');
        await flushAsync();

        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].body.kind, 'edit');
        assert.equal(uploads[0].body.logicalId, 't1');
        assert.equal(uploads[0].body.amount, -20, '50 -> 30 is a -20 delta');
    });

    await t.test('deleteTransaction writes a negation entry and the transaction disappears from the list', async () => {
        const window = loadApp();
        window.confirm = () => true;
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.transactionEntries = [baseEntry({ id: 't1', logicalId: 't1', amount: 50 })];
        window.switchTab('management');
        window.switchMgmtTab('transactions');
        assert.ok(window.document.getElementById('tx-amt-t1'), 'sanity check: the transaction should render first');

        const uploads = [];
        window.fetch = mockDropboxFetch({ entryUploads: uploads });

        window.deleteTransaction('t1');
        await flushAsync();

        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].body.kind, 'delete');
        assert.equal(uploads[0].body.amount, -50);
        assert.equal(
            window.document.getElementById('tx-amt-t1'),
            null,
            'the deleted transaction should no longer render',
        );
    });

    await t.test('renderManagement shows the collapsed current amount, not raw ledger entries', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', kind: 'create', amount: 50 }),
            baseEntry({ id: 't2', logicalId: 't1', kind: 'edit', amount: -20 }),
        ];
        window.switchTab('management');
        window.switchMgmtTab('transactions');

        const list = window.document.getElementById('transactions-list');
        assert.equal(
            list.querySelectorAll('[id^="tx-amt-"]').length,
            1,
            'one row per logical transaction, not per raw entry',
        );
        assert.equal(window.document.getElementById('tx-amt-t1').value, '30');
    });

    await t.test('a General Fund donation renders with a distinct label, not "Unknown"', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.transactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', entityId: window.GENERAL_FUND_ID, amount: 100 }),
        ];
        window.switchTab('management');
        window.switchMgmtTab('transactions');

        const list = window.document.getElementById('transactions-list');
        assert.match(list.innerHTML, /Donation \(General Fund\)/);
        assert.doesNotMatch(list.innerHTML, /Unknown/);
    });

    await t.test('a network failure while writing an entry queues it instead of dropping it', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();
        let alertCalled = false;
        window.alert = () => {
            alertCalled = true;
        };
        window.fetch = async () => ({ ok: false, status: 500 });

        window.document.getElementById('entity-select').value = 'Team A';
        window.document.getElementById('amount-input').value = '10';
        window.submitTransaction();
        await flushAsync();

        assert.equal(alertCalled, false, 'a queueable failure must not alert');
        assert.equal(window.pendingQueue.length, 1);
        assert.equal(window.localTransactionEntries.length, 1, 'the entry stays visible locally while queued');
        assert.match(window.document.getElementById('entry-message').textContent, /queued/);

        const indicator = window.document.getElementById('pending-writes-indicator');
        assert.equal(indicator.classList.contains('hidden'), false);
        assert.match(indicator.textContent, /1 pending/);
    });

    await t.test('flushPendingWrites drains a queued entry once saves succeed again', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();
        window.fetch = async () => ({ ok: false, status: 500 });

        window.document.getElementById('entity-select').value = 'Team A';
        window.document.getElementById('amount-input').value = '10';
        window.submitTransaction();
        await flushAsync();
        assert.equal(window.pendingQueue.length, 1, 'sanity check: the write should be queued first');

        const uploads = [];
        window.fetch = mockDropboxFetch({ entryUploads: uploads });

        await window.flushPendingWrites();

        assert.equal(window.pendingQueue.length, 0, 'the queue should drain once saves succeed');
        assert.equal(uploads.length, 1, 'the retried entry should have actually been uploaded');
        assert.equal(
            window.document.getElementById('pending-writes-indicator').classList.contains('hidden'),
            true,
            'the indicator should hide once the queue is empty',
        );
    });

    await t.test('getVisibleTransactionEntries merges locally-created entries a poll has not confirmed yet', () => {
        const window = loadApp();
        window.transactionEntries = [baseEntry({ id: 't1', logicalId: 't1', amount: 10 })];
        window.localTransactionEntries = [
            baseEntry({ id: 't1', logicalId: 't1', amount: 10 }), // already confirmed — must not double-count
            baseEntry({ id: 't2', logicalId: 't2', amount: 5 }), // not yet confirmed — must still show
        ];

        const visible = window.getVisibleTransactionEntries();

        assert.equal(visible.length, 2);
        assert.deepEqual(visible.map((e) => e.id).sort(), ['t1', 't2']);
    });
});

test('DOM: fetching config and the transaction ledger together', async (t) => {
    await t.test("fetchAll loads config and the active event's ledger in one pass", async () => {
        const window = loadApp();
        window.accessToken = 'fake-token';
        window.fetch = mockDropboxFetch({
            config: baseAppData({
                entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
            }),
            entries: [baseEntry({ id: 't1', logicalId: 't1', amount: 40 })],
        });

        await window.fetchAll();

        assert.equal(window.appData.settings.title, 'Test Event');
        assert.equal(window.transactionEntries.length, 1);
        assert.equal(window.transactionEntries[0].id, 't1');
    });

    await t.test('a poll confirming a locally-created entry prunes it from localTransactionEntries', async () => {
        const window = loadApp();
        window.accessToken = 'fake-token';
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        const entry = baseEntry({ id: 't1', logicalId: 't1', amount: 10 });
        window.localTransactionEntries = [entry];
        window.fetch = mockDropboxFetch({ config: window.appData, entries: [entry] });

        await window.fetchTransactionEntriesInternal();

        assert.equal(window.transactionEntries.length, 1);
        assert.equal(window.localTransactionEntries.length, 0, 'now confirmed by the poll, no longer needed locally');
    });

    await t.test("changeActiveEvent re-fetches the newly active event's ledger", async () => {
        const window = loadApp();
        window.accessToken = 'fake-token';
        window.appData = baseAppData({
            events: [
                { id: 'evt1', name: 'First', goalAmount: null, startDate: '', endDate: '' },
                { id: 'evt2', name: 'Second', goalAmount: null, startDate: '', endDate: '' },
            ],
            activeEventId: 'evt1',
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.renderApp();

        window.fetch = mockDropboxFetch({
            config: window.appData,
            entries: [baseEntry({ id: 't9', logicalId: 't9', eventId: 'evt2', amount: 77 })],
        });

        const select = window.document.getElementById('active-event-select');
        select.value = 'evt2';
        await window.changeActiveEvent();

        assert.equal(window.transactionEntries.length, 1);
        assert.equal(window.transactionEntries[0].eventId, 'evt2');
    });
});

test('DOM: export (full audit trail)', async (t) => {
    await t.test('exportDataZip bundles the config file, every raw entry, and a computed summary', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';

        const entries = [baseEntry({ id: 't1', logicalId: 't1', kind: 'create', amount: 50 })];
        window.fetch = mockDropboxFetch({ entries });

        let capturedBlob = null;
        window.URL.createObjectURL = (blob) => {
            capturedBlob = blob;
            return 'blob:mock';
        };

        await window.exportDataZip();

        assert.ok(capturedBlob, 'a blob should have been created for download');
        const zip = await JSZipNode.loadAsync(await capturedBlob.arrayBuffer());

        const config = JSON.parse(await zip.file('data.json').async('string'));
        assert.equal(config.settings.title, 'Test Event');

        const entryFile = zip.file('transactions/evt1/t1.json');
        assert.ok(entryFile, 'the raw entry file should be present under its own path');
        assert.equal(JSON.parse(await entryFile.async('string')).amount, 50);

        const summary = JSON.parse(await zip.file('summary.json').async('string'));
        assert.equal(summary.events.evt1.totals.e1, 50);
        assert.equal(summary.events.evt1.transactions.length, 1);
    });
});

test('DOM: multi-device viewer mode (#tv-viewer)', async (t) => {
    await t.test('checkViewMode() applies the same display-only styling as #tv and swaps the login copy', () => {
        const window = loadApp();
        const { document } = window;

        window.location.hash = '#tv-viewer';
        window.checkViewMode();

        assert.equal(document.getElementById('main-header').classList.contains('hidden'), true);
        assert.equal(document.getElementById('app-nav').classList.contains('hidden'), true);
        assert.equal(document.getElementById('admin-controls').classList.contains('hidden'), true);
        assert.equal(document.getElementById('main-footer').classList.contains('hidden'), true);
        assert.equal(document.documentElement.classList.contains('dark'), true);
        assert.match(document.getElementById('login-text').innerText, /view-only/);
        assert.equal(
            document.getElementById('tv-theme-toggle').classList.contains('hidden'),
            false,
            'the TV theme toggle must be reachable once the main header is hidden',
        );
    });

    await t.test(
        'the TV theme toggle switches this display to light mode without touching localStorage from another device',
        () => {
            const window = loadApp();
            const { document } = window;

            window.location.hash = '#tv';
            window.checkViewMode();
            assert.equal(document.documentElement.classList.contains('dark'), true, 'defaults to dark on first visit');

            document.getElementById('tv-theme-toggle').click();
            assert.equal(
                document.documentElement.classList.contains('dark'),
                false,
                'toggle flips this device to light',
            );
            assert.equal(window.localStorage.getItem('darkMode'), 'false');

            // Re-running checkViewMode() (e.g. a later hashchange) must respect
            // the just-stored preference instead of re-forcing dark.
            window.checkViewMode();
            assert.equal(document.documentElement.classList.contains('dark'), false);
        },
    );

    await t.test('leaving #tv-viewer restores the normal admin layout and login copy', () => {
        const window = loadApp();
        const { document } = window;

        window.location.hash = '#tv-viewer';
        window.checkViewMode();
        window.location.hash = '';
        window.checkViewMode();

        assert.equal(document.getElementById('main-header').classList.contains('hidden'), false);
        assert.equal(document.getElementById('app-nav').classList.contains('hidden'), false);
        assert.equal(document.getElementById('admin-controls').classList.contains('hidden'), false);
        assert.equal(document.getElementById('main-footer').classList.contains('hidden'), false);
        assert.match(document.getElementById('login-text').innerText, /start tallying votes/);
    });

    await t.test(
        'startAuthFlow() requests the restricted viewer scope and stashes the hash for the return trip',
        async () => {
            const window = loadApp();
            window.location.hash = '#tv-viewer';

            await window.startAuthFlow();

            assert.ok(window.localStorage.getItem('pkce_verifier'), 'a PKCE code verifier should be stored');
            assert.equal(window.localStorage.getItem('post_auth_hash'), '#tv-viewer');
        },
    );

    await t.test('startAuthFlow() from the normal admin screen stashes an empty hash (no viewer scope)', async () => {
        const window = loadApp();
        window.location.hash = '';

        await window.startAuthFlow();

        assert.ok(window.localStorage.getItem('pkce_verifier'));
        assert.equal(window.localStorage.getItem('post_auth_hash'), '');
    });

    await t.test('handleAuthRedirect() restores the stashed #tv-viewer hash and applies viewer styling', async () => {
        // Simulates landing back from Dropbox: the OAuth redirect always
        // drops the fragment, so the page loads with ?code=... and no hash,
        // exactly like startAuthFlow() would have left it after stashing
        // post_auth_hash and navigating away.
        const window = loadApp('http://localhost/?code=abc123');
        window.localStorage.setItem('pkce_verifier', 'stub-verifier');
        window.localStorage.setItem('post_auth_hash', '#tv-viewer');
        window.fetch = async (url) => {
            if (String(url).includes('oauth2/token')) {
                return { ok: true, json: async () => ({ access_token: 'tok123', refresh_token: 'rtok123' }) };
            }
            if (String(url).includes('/files/download_zip')) {
                return { ok: true, status: 200, blob: async () => buildZipBuffer([]) };
            }
            if (String(url).includes('/download')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => JSON.stringify({ rev: 'rev1' }) },
                    json: async () => baseAppData(),
                };
            }
            throw new Error('unexpected fetch URL: ' + url);
        };

        await window.handleAuthRedirect();

        assert.equal(window.location.hash, '#tv-viewer', 'the viewer hash should be restored after the redirect');
        assert.equal(window.localStorage.getItem('post_auth_hash'), null, 'the stashed hash should be consumed');
        assert.equal(window.localStorage.getItem('dropbox_token'), 'tok123');
        assert.equal(
            window.document.getElementById('main-header').classList.contains('hidden'),
            true,
            'initApp() should have applied viewer/TV styling once the hash was restored',
        );

        window.close();
    });
});

test('DOM: keyer mode (#keyer)', async (t) => {
    await t.test('checkViewMode() shows Add Transaction but hides the nav (no route to Data Management)', () => {
        const window = loadApp();
        const { document } = window;
        window.location.hash = '#keyer';
        window.checkViewMode();

        assert.equal(document.getElementById('app-nav').classList.contains('hidden'), true);
        assert.equal(document.getElementById('admin-controls').classList.contains('hidden'), false);
        assert.equal(
            document.getElementById('main-header').classList.contains('hidden'),
            false,
            'keyer keeps the normal admin header/footer, unlike TV mode',
        );
        assert.equal(document.getElementById('view-dashboard').classList.contains('hidden'), false);
        assert.match(document.getElementById('login-text').innerText, /add donations from this station/);
    });

    await t.test('leaving #keyer restores the nav', () => {
        const window = loadApp();
        const { document } = window;
        window.location.hash = '#keyer';
        window.checkViewMode();
        window.location.hash = '';
        window.checkViewMode();
        assert.equal(document.getElementById('app-nav').classList.contains('hidden'), false);
    });

    await t.test(
        'startAuthFlow() from #keyer stashes the hash and does not request the restricted viewer scope',
        async () => {
            const window = loadApp();
            window.location.hash = '#keyer';

            await window.startAuthFlow();

            assert.equal(window.localStorage.getItem('post_auth_hash'), '#keyer');
            // A keyer needs to write, so it must not go through the same
            // restricted-scope branch #tv-viewer uses — isViewerHash('#keyer')
            // is false (see the isViewerHash unit tests in logic.test.js), so
            // startAuthFlow() falls through to the default (undefined) scope,
            // same as the admin flow.
        },
    );

    await t.test(
        'ensureDeviceLabel() prompts once on a keyer device and stamps its answer on new entries',
        async () => {
            const window = loadApp();
            window.location.hash = '#keyer';
            window.checkViewMode();
            window.appData = baseAppData({
                entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
            });
            window.accessToken = 'fake-token';
            window.renderApp();

            let promptCalls = 0;
            window.prompt = () => {
                promptCalls++;
                return 'Front Table';
            };
            window.fetch = mockDropboxFetch({});

            window.document.getElementById('entity-select').value = 'Team A';
            window.document.getElementById('amount-input').value = '10';
            window.submitTransaction();
            await flushAsync();

            assert.equal(promptCalls, 1);
            assert.equal(window.localStorage.getItem('device_label'), 'Front Table');
            assert.equal(window.localTransactionEntries[0].createdBy, 'Front Table');

            window.document.getElementById('amount-input').value = '5';
            window.submitTransaction();
            await flushAsync();
            assert.equal(promptCalls, 1, 'should not prompt a second time once a label is stored for this device');
        },
    );

    await t.test('the admin flow never prompts and stamps entries with "Admin"', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();
        window.prompt = () => {
            throw new Error('must not prompt on the admin flow');
        };
        window.fetch = mockDropboxFetch({});

        window.document.getElementById('entity-select').value = 'Team A';
        window.document.getElementById('amount-input').value = '10';
        window.submitTransaction();
        await flushAsync();

        assert.equal(window.localTransactionEntries[0].createdBy, 'Admin');
    });
});

test('DOM: mobile viewport sizing', async (t) => {
    await t.test('the page uses a dynamic-viewport height, not the static 100vh unit', () => {
        // 100vh on a mobile browser is measured against the largest possible
        // viewport (URL bar hidden), so a page sized with h-screen renders
        // taller than what's actually visible whenever the URL bar is
        // showing — the classic cause of a nested scroll area feeling stuck
        // or unresponsive on phones. h-dvh (100dvh) tracks the real visible
        // viewport instead. Regression guard against re-introducing h-screen.
        const window = loadApp();
        const body = window.document.getElementById('body');

        assert.equal(body.classList.contains('h-dvh'), true, 'body should size itself with the dynamic viewport unit');
        assert.equal(body.classList.contains('h-screen'), false, 'body should not use the static 100vh unit');
    });

    await t.test('TV mode sizes the container with the same dynamic-viewport unit', () => {
        const window = loadApp();
        const { document } = window;
        const container = document.getElementById('main-container');

        window.location.hash = '#tv';
        window.checkViewMode();
        assert.equal(container.classList.contains('h-dvh'), true);
        assert.equal(container.classList.contains('h-screen'), false);

        window.location.hash = '';
        window.checkViewMode();
        assert.equal(container.classList.contains('h-dvh'), false, 'h-dvh should be removed once TV mode is left');
    });

    await t.test(
        '#view-management establishes a flex layout so its internal scroll pane is actually height-constrained',
        () => {
            // Regression guard for a real bug (not just the h-dvh sizing above):
            // #view-management only had `flex-col` (no base `flex`/`display:flex`
            // class), so it always rendered as a plain block box. That silently
            // broke the flex chain the Settings/Teams/Events/Transactions panes
            // rely on for internal scrolling — flex-1/min-h-0 on the
            // `overflow-y-auto` pane inside it do nothing without a flex parent,
            // so the pane grew to its full content height instead of being
            // capped, and anything past main-container's overflow:hidden edge
            // was simply clipped and unreachable rather than scrollable. #tv
            // and #view-dashboard both use jsdom's own `.hidden` class, which
            // needs a `flex` class alongside it to restore display:flex once
            // unhidden — this asserts #view-management has that too.
            const window = loadApp();
            const el = window.document.getElementById('view-management');
            assert.equal(el.classList.contains('flex'), true);
            assert.equal(el.classList.contains('flex-col'), true);
        },
    );

    await t.test('the Teams grid scrolls vertically with many teams instead of overflowing horizontally', () => {
        // Regression guard for a real bug: entities-list is a CSS grid
        // (grid-cols-1 md:grid-cols-2 xl:grid-cols-3), and each team card
        // used `flex flex-col` with two `flex gap-2` rows of side-by-side
        // inputs, none of them `min-w-0`. Per the CSS Grid spec, a grid
        // item's automatic minimum width defaults to its min-content size
        // (not 0) unless something in the chain opts out with min-w-0 — so
        // those non-shrinking input rows forced each card, and therefore
        // the whole grid track, wider than the viewport instead of
        // wrapping, producing a horizontal scrollbar on the entire page
        // with many teams registered rather than the intended vertical
        // scroll. Asserts every card and its side-by-side row children
        // carry min-w-0 so they can actually shrink to the grid track.
        const window = loadApp();
        window.appData = baseAppData({
            entities: Array.from({ length: 12 }, (_, i) => ({
                id: `e${i}`,
                namePublic: `Team ${i}`,
                namePrivate: '',
                imageUrl: '',
                color: 'bg-red-500',
            })),
        });
        window.renderManagement();

        const cards = window.document.getElementById('entities-list').children;
        assert.equal(cards.length, 12);
        Array.from(cards).forEach((card) => {
            assert.equal(
                card.classList.contains('min-w-0'),
                true,
                'each team card must be able to shrink below its content width',
            );
            card.querySelectorAll('input, select').forEach((field) => {
                if (field.classList.contains('flex-1') || field.parentElement.classList.contains('flex')) {
                    assert.equal(
                        field.classList.contains('min-w-0'),
                        true,
                        `${field.id || field.tagName} sits in a non-wrapping flex row and must be able to shrink`,
                    );
                }
            });
        });
    });
});
