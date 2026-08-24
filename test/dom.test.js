// DOM-level integration tests: load index.html into jsdom the same way a
// browser would (script tags executed manually, in order, since jsdom's
// runScripts:"outside-only" parses markup but never auto-runs a <script>),
// then exercise the real app functions against a real DOM. This complements
// logic.test.js (which only covers the DOM-free pure functions) by checking
// the wiring: that index.html actually calls them correctly, that escaping
// survives all the way to rendered markup, and that the new sub-tab / JSON
// editor UI behaves as expected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '../index.html');
const LOGIC_PATH = path.join(__dirname, '../js/logic.js');
const HTML_SOURCE = fs.readFileSync(HTML_PATH, 'utf8');
const LOGIC_SOURCE = fs.readFileSync(LOGIC_PATH, 'utf8');

const INLINE_SCRIPT = HTML_SOURCE.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];

function loadApp() {
    const dom = new JSDOM(HTML_SOURCE, { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    // logic.js is loaded first, exactly like the <script src="js/logic.js">
    // tag that precedes the inline script in index.html.
    window.eval(LOGIC_SOURCE);
    window.eval(INLINE_SCRIPT);
    return window;
}

function baseAppData(overrides) {
    return Object.assign({
        settings: { title: 'Test Event', logoUrl: '', themeColor: 'bg-blue-600' },
        events: [{ id: 'evt1', name: 'Main', goalAmount: null, startDate: '', endDate: '' }],
        activeEventId: 'evt1',
        entities: [],
        transactions: []
    }, overrides);
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

    await t.test('switchMgmtTab shows exactly one pane and marks exactly one button active', () => {
        const window = loadApp();
        const { document } = window;
        window.switchTab('management');
        window.switchMgmtTab('events');

        ['settings', 'entities', 'events', 'transactions', 'json'].forEach((tab) => {
            const pane = document.getElementById(`mgmt-view-${tab}`);
            const btn = document.getElementById(`mgmt-tab-${tab}`);
            assert.equal(pane.classList.contains('hidden'), tab !== 'events', `pane ${tab} hidden state`);
            assert.equal(btn.classList.contains('active'), tab === 'events', `button ${tab} active state`);
        });
    });

    await t.test('switching tabs never leaves more than one pane visible', () => {
        const window = loadApp();
        window.switchTab('management');
        ['settings', 'entities', 'events', 'transactions', 'json', 'settings'].forEach((tab) => {
            window.switchMgmtTab(tab);
            const visible = ['settings', 'entities', 'events', 'transactions', 'json']
                .filter((t) => !window.document.getElementById(`mgmt-view-${t}`).classList.contains('hidden'));
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
                { id: 'e2', namePublic: 'Team B', namePrivate: '', imageUrl: '', color: 'bg-blue-500' }
            ],
            transactions: [
                { id: 't1', entityId: 'e1', eventId: 'evt1', amount: 50, createDate: new Date().toISOString(), modifiedDate: new Date().toISOString() },
                { id: 't2', entityId: 'e1', eventId: 'evt1', amount: 25, createDate: new Date().toISOString(), modifiedDate: new Date().toISOString() }
            ]
        });

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.equal(board.children.length, 2);
        assert.match(board.innerHTML, /Team A/);
        assert.match(board.innerHTML, /\$75\.00/, 'Team A total should be 50 + 25');
    });

    await t.test('an empty roster shows the setup prompt instead of throwing', () => {
        const window = loadApp();
        window.appData = baseAppData({ events: [], entities: [] });
        assert.doesNotThrow(() => window.renderApp());
        assert.match(window.document.getElementById('leaderboard').innerHTML, /empty/i);
    });

    await t.test('regression: the Submit button recovers once setup is completed (was stuck on "Setup Required")', () => {
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
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }]
        });
        window.renderApp();

        assert.equal(submitBtn.disabled, false, 'button must recover once an event and team exist');
        assert.equal(submitBtn.innerText, 'Submit Vote');
        assert.equal(amtInput.disabled, false);
        assert.equal(submitBtn.classList.contains('opacity-50'), false);
        assert.equal(submitBtn.classList.contains('cursor-not-allowed'), false);
    });

    await t.test('an in-flight "Saving..." submission is not reset by a concurrent renderApp() call', () => {
        const window = loadApp();
        const submitBtn = window.document.getElementById('submit-btn');

        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }]
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
            entities: [{
                id: 'e1',
                namePublic: '<img src=x onerror="window.__pwned=true">',
                namePrivate: '',
                imageUrl: '',
                color: 'bg-red-500'
            }]
        });

        window.renderApp();

        const board = window.document.getElementById('leaderboard');
        assert.equal(board.querySelectorAll('img').length, 0, 'the payload must not become a real <img> element');
        assert.equal(window.__pwned, undefined, 'onerror must never execute');
        assert.match(board.textContent, /<img src=x onerror="window\.__pwned=true">/, 'the name should render as visible text, not markup');
    });
});

test('DOM: bulk JSON editor', async (t) => {
    await t.test('opening the Raw JSON tab populates the textarea from current appData', () => {
        const window = loadApp();
        window.appData = baseAppData({ settings: { title: 'Demo Title', logoUrl: '', themeColor: 'bg-blue-600' } });
        window.switchTab('management');
        window.switchMgmtTab('json');

        const parsed = JSON.parse(window.document.getElementById('json-editor').value);
        assert.equal(parsed.settings.title, 'Demo Title');
    });

    await t.test('re-entering the tab does not clobber an in-progress, unsaved draft', () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.switchTab('management');
        window.switchMgmtTab('json');

        const textarea = window.document.getElementById('json-editor');
        textarea.value = '{ "draft": true, unfinished editing...';

        window.switchMgmtTab('settings');
        window.switchMgmtTab('json');

        assert.equal(textarea.value, '{ "draft": true, unfinished editing...');
    });

    await t.test('invalid JSON is rejected with a clear message and appData is untouched', async () => {
        const window = loadApp();
        const original = baseAppData({ settings: { title: 'Untouched', logoUrl: '', themeColor: 'bg-blue-600' } });
        window.appData = original;
        window.switchTab('management');
        window.switchMgmtTab('json');
        window.document.getElementById('json-editor').value = '{ this is not valid json';

        await window.saveJsonEditor();

        const msg = window.document.getElementById('json-editor-message');
        assert.equal(msg.classList.contains('hidden'), false);
        assert.match(msg.textContent, /Invalid JSON/);
        assert.equal(window.appData, original, 'appData must be untouched on validation failure');
    });

    await t.test('wrong-shaped JSON (missing a required field) is rejected', async () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.switchTab('management');
        window.switchMgmtTab('json');
        window.document.getElementById('json-editor').value = JSON.stringify({ settings: {}, entities: [], transactions: [] });

        await window.saveJsonEditor();

        assert.match(window.document.getElementById('json-editor-message').textContent, /events/);
    });

    await t.test('valid JSON is saved through the real fetch/save pipeline', async () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.accessToken = 'fake-token';
        window.currentRev = 'rev1';
        window.confirm = () => true;

        const uploadedBodies = [];
        window.fetch = async (url, opts) => {
            if (String(url).includes('/download')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => JSON.stringify({ rev: 'rev2' }) },
                    json: async () => baseAppData()
                };
            }
            if (String(url).includes('/upload')) {
                uploadedBodies.push(JSON.parse(opts.body));
                return { ok: true, status: 200, json: async () => ({ rev: 'rev3' }) };
            }
            throw new Error('unexpected fetch URL: ' + url);
        };

        window.switchTab('management');
        window.switchMgmtTab('json');
        const newData = baseAppData({ settings: { title: 'New Title', logoUrl: '', themeColor: 'bg-blue-600' } });
        window.document.getElementById('json-editor').value = JSON.stringify(newData);

        await window.saveJsonEditor();

        assert.equal(uploadedBodies.length, 1, 'saveState should have uploaded exactly once');
        assert.equal(uploadedBodies[0].settings.title, 'New Title');
        assert.equal(window.document.getElementById('json-editor-message').textContent, 'Saved.');
    });
});

test('DOM: input validation', async (t) => {
    await t.test('submitTransaction rejects a non-positive amount without attempting to save', () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }]
        });
        window.fetch = async () => { throw new Error('fetch should not be called for an invalid submission'); };
        window.renderApp();

        window.document.getElementById('entity-select').value = 'e1';
        window.document.getElementById('amount-input').value = '-5';
        window.submitTransaction();

        const msg = window.document.getElementById('entry-message');
        assert.match(msg.textContent, /positive amount/);
        assert.equal(window.appData.transactions.length, 0, 'no transaction should be recorded locally');
    });

    await t.test('addEntity rejects a non-http(s) image URL and never attempts to save', () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.fetch = async () => { throw new Error('fetch should not be called for an invalid entity'); };
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
        window.fetch = async () => { throw new Error('fetch should not be called for invalid settings'); };
        window.alert = () => {};
        window.switchTab('management');
        window.switchMgmtTab('settings');

        window.document.getElementById('set-logo').value = 'data:text/html,<script>alert(1)</script>';
        window.saveSettings();

        assert.equal(window.appData.settings.logoUrl, '', 'settings must be untouched on rejection');
    });
});
