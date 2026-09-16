// DOM-level integration tests: load index.html into jsdom the same way a
// browser would (script tags executed manually, in order, since jsdom's
// runScripts:"outside-only" parses markup but never auto-runs a <script>),
// then exercise the real app functions against a real DOM. This complements
// logic.test.js (which only covers the DOM-free pure functions) by checking
// the wiring: that index.html/js/app.js actually call them correctly, that
// escaping survives all the way to rendered markup, and that the sub-tab /
// JSON editor UI behaves as expected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');

const HTML_SOURCE = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const LOGIC_SOURCE = fs.readFileSync(path.join(__dirname, '../js/logic.js'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

function loadApp(url) {
    const dom = new JSDOM(HTML_SOURCE, { runScripts: 'outside-only', url: url || 'http://localhost/' });
    const { window } = dom;
    // jsdom implements window.crypto.getRandomValues but not .subtle — needed
    // by generateCodeChallenge() (the PKCE flow) — so borrow Node's real
    // WebCrypto implementation for it.
    window.crypto.subtle = webcrypto.subtle;
    // Same order as index.html's <script> tags: js/logic.js, then js/app.js.
    // app.js wires all its event listeners (bindStaticEventListeners) as a
    // top-level statement, so evaluating it here reproduces real page load.
    window.eval(LOGIC_SOURCE);
    window.eval(APP_SOURCE);
    return window;
}

function baseAppData(overrides) {
    return Object.assign(
        {
            settings: { title: 'Test Event', logoUrl: '', themeColor: 'bg-blue-600' },
            events: [{ id: 'evt1', name: 'Main', goalAmount: null, startDate: '', endDate: '' }],
            activeEventId: 'evt1',
            entities: [],
            transactions: [],
        },
        overrides,
    );
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
            const visible = ['settings', 'entities', 'events', 'transactions', 'json'].filter(
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
            transactions: [
                {
                    id: 't1',
                    entityId: 'e1',
                    eventId: 'evt1',
                    amount: 50,
                    createDate: new Date().toISOString(),
                    modifiedDate: new Date().toISOString(),
                },
                {
                    id: 't2',
                    entityId: 'e1',
                    eventId: 'evt1',
                    amount: 25,
                    createDate: new Date().toISOString(),
                    modifiedDate: new Date().toISOString(),
                },
            ],
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
        window.document.getElementById('json-editor').value = JSON.stringify({
            settings: {},
            entities: [],
            transactions: [],
        });

        await window.saveJsonEditor();

        assert.match(window.document.getElementById('json-editor-message').textContent, /events/);
    });

    await t.test(
        'record-level problems (duplicate name, bad URL, bad amount) are rejected without ever attempting to save',
        async () => {
            const window = loadApp();
            const original = baseAppData();
            window.appData = original;
            window.fetch = async () => {
                throw new Error('fetch should not be called when record-level validation fails');
            };
            window.switchTab('management');
            window.switchMgmtTab('json');
            window.document.getElementById('json-editor').value = JSON.stringify({
                settings: {},
                events: [],
                entities: [
                    { id: 'e1', namePublic: 'Team A', imageUrl: '' },
                    { id: 'e2', namePublic: 'Team A', imageUrl: '' },
                ],
                transactions: [],
            });

            await window.saveJsonEditor();

            assert.match(window.document.getElementById('json-editor-message').textContent, /Duplicate entity name/);
            assert.equal(window.appData, original, 'appData must be untouched on validation failure');
        },
    );

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
                    json: async () => baseAppData(),
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
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.fetch = async () => {
            throw new Error('fetch should not be called for an invalid submission');
        };
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
        window.document.getElementById('entity-select').value = 'e1';
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

// Lets the app's own async chains (updateDataWrapper -> runUpdateWithRetry
// -> the mocked fetch) settle before assertions, since submitTransaction()
// fires updateDataWrapper without the caller awaiting it.
function flushAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

test('DOM: offline/queued writes', async (t) => {
    await t.test('a network failure queues the change instead of alerting', async () => {
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

        window.document.getElementById('entity-select').value = 'e1';
        window.document.getElementById('amount-input').value = '10';
        window.submitTransaction();
        await flushAsync();

        assert.equal(alertCalled, false, 'a queueable failure must not alert');
        assert.equal(window.pendingQueue.length, 1);
        assert.match(window.document.getElementById('entry-message').textContent, /queued/);

        const indicator = window.document.getElementById('pending-writes-indicator');
        assert.equal(indicator.classList.contains('hidden'), false);
        assert.match(indicator.textContent, /1 pending/);
    });

    await t.test('flushPendingWrites drains the queue once saves succeed again', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();
        window.fetch = async () => ({ ok: false, status: 500 });

        window.document.getElementById('entity-select').value = 'e1';
        window.document.getElementById('amount-input').value = '10';
        window.submitTransaction();
        await flushAsync();
        assert.equal(window.pendingQueue.length, 1, 'sanity check: the write should be queued first');

        window.fetch = async (url) => {
            if (String(url).includes('/download')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => JSON.stringify({ rev: 'rev2' }) },
                    json: async () => baseAppData(),
                };
            }
            return { ok: true, status: 200, json: async () => ({ rev: 'rev3' }) };
        };

        await window.flushPendingWrites();

        assert.equal(window.pendingQueue.length, 0, 'the queue should drain once saves succeed');
        assert.equal(
            window.document.getElementById('pending-writes-indicator').classList.contains('hidden'),
            true,
            'the indicator should hide once the queue is empty',
        );
    });

    await t.test('clicking the pending-writes indicator triggers a flush', async () => {
        const window = loadApp();
        window.appData = baseAppData({
            entities: [{ id: 'e1', namePublic: 'Team A', namePrivate: '', imageUrl: '', color: 'bg-red-500' }],
        });
        window.accessToken = 'fake-token';
        window.renderApp();
        window.fetch = async () => ({ ok: false, status: 500 });
        window.document.getElementById('entity-select').value = 'e1';
        window.document.getElementById('amount-input').value = '10';
        window.submitTransaction();
        await flushAsync();
        assert.equal(window.pendingQueue.length, 1);

        window.fetch = async (url) => {
            if (String(url).includes('/download')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => JSON.stringify({ rev: 'rev2' }) },
                    json: async () => baseAppData(),
                };
            }
            return { ok: true, status: 200, json: async () => ({ rev: 'rev3' }) };
        };

        window.document.getElementById('pending-writes-indicator').click();
        await flushAsync();

        assert.equal(window.pendingQueue.length, 0, 'the click should have drained the queue');
    });

    await t.test('the bulk JSON editor opts out of queueing and keeps the immediate-alert behavior', async () => {
        const window = loadApp();
        window.appData = baseAppData();
        window.accessToken = 'fake-token';
        window.confirm = () => true;
        let alertCalled = false;
        window.alert = () => {
            alertCalled = true;
        };
        window.fetch = async () => ({ ok: false, status: 500 });

        window.switchTab('management');
        window.switchMgmtTab('json');
        window.document.getElementById('json-editor').value = JSON.stringify(baseAppData());

        await window.saveJsonEditor();

        assert.equal(window.pendingQueue.length, 0, 'the JSON editor must never queue a stale full-file snapshot');
        assert.equal(alertCalled, true, 'a fetch failure on the JSON editor must still alert immediately');
        assert.match(
            window.document.getElementById('json-editor-message').textContent,
            /Save failed/,
            'the editor message should reflect the immediate failure, not a queued one',
        );
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
    });

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
