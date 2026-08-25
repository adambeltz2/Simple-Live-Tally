// Simple Live Tally application logic. Loaded via <script src="js/app.js">
// (after js/logic.js) rather than inline, so a strict script-src CSP
// (index.html's <meta http-equiv="Content-Security-Policy">) can allow it
// without 'unsafe-inline'. All DOM event wiring here goes through
// addEventListener/event delegation (see bindStaticEventListeners at the
// bottom) rather than onclick="..." attributes, for the same reason.

// --- CONFIGURATION ---
const CLIENT_ID = 'p6ejl1ht6k9gni2';
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const REDIRECT_URI = isLocalhost
    ? window.location.origin + window.location.pathname
    : 'https://adambeltz2.github.io/Simple-Live-Tally/';
const FILE_PATH = '/data.json';

// var (not let/const): keeps these as real `window` properties, so
// app state stays introspectable/settable from outside the script
// (devtools, tests) rather than living in a script-only lexical scope.
var accessToken = null;
var currentRev = null;
var appData = null;
var refreshTimer = 60;
var countdownInterval = null;
var currentMgmtTab = 'settings';
var isSubmittingTransaction = false;

const defaultData = {
    settings: { title: 'Simple Live Tally', logoUrl: '', themeColor: 'bg-blue-600' },
    events: [{ id: 'evt_' + Date.now(), name: 'Inaugural Event', goalAmount: null, startDate: '', endDate: '' }],
    activeEventId: '',
    entities: [
        { id: 'ent_1', namePublic: 'Team Alpha', namePrivate: 'Internal Alpha', imageUrl: '', color: 'bg-red-500' },
        { id: 'ent_2', namePublic: 'Team Beta', namePrivate: 'Internal Beta', imageUrl: '', color: 'bg-blue-500' },
    ],
    transactions: [],
};

const colors = [
    'bg-red-500',
    'bg-blue-500',
    'bg-green-500',
    'bg-yellow-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-indigo-500',
    'bg-teal-500',
    'bg-orange-500',
];

// --- DARK MODE LOGIC ---
function initTheme() {
    if (window.location.hash === '#tv') return;
    const isDark = window.localStorage.getItem('darkMode') === 'true';
    if (isDark) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}
function toggleDarkMode() {
    document.documentElement.classList.toggle('dark');
    window.localStorage.setItem('darkMode', document.documentElement.classList.contains('dark'));
}
initTheme();

// --- VIEW MODE MANAGEMENT ---
function applyThemeColor() {
    if (!appData || !appData.settings) return;
    const theme = appData.settings.themeColor || 'bg-blue-600';

    const header = document.getElementById('main-header');
    header.className = header.className.replace(/bg-(blue|red|green|purple|gray)-\d+/, theme);

    const btn = document.getElementById('login-btn');
    if (btn) btn.className = btn.className.replace(/bg-(blue|red|green|purple|gray)-\d+/, theme);

    const activeTab = document.getElementById('view-dashboard').classList.contains('hidden')
        ? 'tab-management'
        : 'tab-dashboard';
    const dashBtn = document.getElementById('tab-dashboard');
    const mgmtBtn = document.getElementById('tab-management');

    dashBtn.className =
        activeTab === 'tab-dashboard'
            ? `px-4 py-2 rounded font-semibold text-sm transition-colors shadow-sm text-white ${theme}`
            : 'px-4 py-2 rounded font-semibold text-sm transition-colors shadow-sm bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-700';
    mgmtBtn.className =
        activeTab === 'tab-management'
            ? `px-4 py-2 rounded font-semibold text-sm transition-colors shadow-sm text-white ${theme}`
            : 'px-4 py-2 rounded font-semibold text-sm transition-colors shadow-sm bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-700';
}

function switchTab(tab) {
    document.getElementById('view-dashboard').classList.toggle('hidden', tab !== 'dashboard');
    document.getElementById('view-management').classList.toggle('hidden', tab !== 'management');
    applyThemeColor();
    if (tab === 'management') {
        renderManagement();
        switchMgmtTab(currentMgmtTab);
    }
}

const MGMT_TABS = ['settings', 'entities', 'events', 'transactions', 'json'];

function switchMgmtTab(tab) {
    currentMgmtTab = tab;
    MGMT_TABS.forEach((t) => {
        document.getElementById(`mgmt-view-${t}`).classList.toggle('hidden', t !== tab);
        document.getElementById(`mgmt-tab-${t}`).classList.toggle('active', t === tab);
    });
    // Populate the editor lazily, and only if it's untouched — never
    // clobber a draft the operator is mid-edit on just by tab-switching.
    if (tab === 'json' && !document.getElementById('json-editor').value.trim()) {
        loadJsonEditor();
    }
}

function checkViewMode() {
    const isTvMode = window.location.hash === '#tv';
    const container = document.getElementById('main-container');
    const header = document.getElementById('main-header');
    const nav = document.getElementById('app-nav');
    const adminControls = document.getElementById('admin-controls');
    const title = document.getElementById('leaderboard-title');
    const subtitle = document.getElementById('leaderboard-subtitle');
    const leaderboardHeader = document.getElementById('leaderboard-header');
    const countdownDisplay = document.getElementById('event-countdown');
    const tvLogo = document.getElementById('tv-logo');
    const footer = document.getElementById('main-footer');

    if (isTvMode) {
        switchTab('dashboard');
        document.documentElement.classList.add('dark');

        container.classList.replace('max-w-5xl', 'max-w-full');
        container.classList.replace('my-4', 'my-0');
        container.classList.replace('rounded-lg', 'rounded-none');
        container.classList.add('h-screen', 'p-4', 'sm:p-6');

        header.classList.add('hidden');
        nav.classList.add('hidden');
        adminControls.classList.add('hidden');
        footer.classList.add('hidden');
        leaderboardHeader.classList.replace('border-gray-200', 'border-gray-800');

        title.classList.replace('text-xl', 'text-4xl');
        subtitle.classList.replace('text-gray-500', 'text-gray-400');
        subtitle.classList.add('text-xl', 'mt-1');

        countdownDisplay.classList.replace('text-sm', 'text-2xl');

        if (appData && appData.settings && appData.settings.logoUrl) {
            tvLogo.src = appData.settings.logoUrl;
            tvLogo.classList.remove('hidden');
        }
    } else {
        initTheme();

        container.classList.replace('max-w-full', 'max-w-5xl');
        container.classList.replace('my-0', 'my-4');
        container.classList.replace('rounded-none', 'rounded-lg');
        container.classList.remove('h-screen', 'p-4', 'sm:p-6');

        header.classList.remove('hidden');
        nav.classList.remove('hidden');
        adminControls.classList.remove('hidden');
        footer.classList.remove('hidden');
        leaderboardHeader.classList.replace('border-gray-800', 'border-gray-200');

        title.classList.replace('text-4xl', 'text-xl');
        subtitle.classList.replace('text-gray-400', 'text-gray-500');
        subtitle.classList.remove('text-xl', 'mt-1');

        countdownDisplay.classList.replace('text-2xl', 'text-sm');
        tvLogo.classList.add('hidden');
    }

    if (appData) {
        applyThemeColor();
        renderApp();
    }
}

window.addEventListener('hashchange', checkViewMode);

// --- AUTHENTICATION & DROPBOX ---
function generateRandomString(length) {
    const array = new Uint32Array(length / 2);
    window.crypto.getRandomValues(array);
    return Array.from(array, (dec) => ('0' + dec.toString(16)).substr(-2)).join('');
}
async function generateCodeChallenge(codeVerifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
async function startAuthFlow() {
    const codeVerifier = generateRandomString(64);
    window.localStorage.setItem('pkce_verifier', codeVerifier);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    // token_access_type=offline requests a refresh_token alongside the
    // short-lived access token, so the app can renew silently instead
    // of forcing operators to re-authenticate mid-event.
    window.location.href = `https://www.dropbox.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&code_challenge=${codeChallenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&token_access_type=offline`;
}
async function handleAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
        const newUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, newUrl);
        const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                code_verifier: window.localStorage.getItem('pkce_verifier'),
            }),
        });
        const data = await response.json();
        if (data.access_token) {
            window.localStorage.setItem('dropbox_token', data.access_token);
            if (data.refresh_token) window.localStorage.setItem('dropbox_refresh_token', data.refresh_token);
            initApp();
        }
    }
}

// Exchanges the stored refresh_token for a new access_token. Returns
// true on success (accessToken and localStorage are updated in
// place) so callers can transparently retry the request that hit a
// 401, instead of every expiry forcing a full re-login.
async function refreshAccessToken() {
    const refreshToken = window.localStorage.getItem('dropbox_refresh_token');
    if (!refreshToken) return false;
    try {
        const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        });
        if (!response.ok) return false;
        const data = await response.json();
        if (!data.access_token) return false;
        accessToken = data.access_token;
        window.localStorage.setItem('dropbox_token', accessToken);
        return true;
    } catch (error) {
        console.error('Error refreshing Dropbox token:', error);
        return false;
    }
}

// Runs a Dropbox API request; on a 401 it attempts one silent token
// refresh and retries once before giving up. buildOptions is a
// function (not a plain object) so the retry picks up the refreshed
// accessToken rather than replaying the stale Authorization header.
async function dropboxFetch(url, buildOptions) {
    let response = await fetch(url, buildOptions());
    if (response.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) response = await fetch(url, buildOptions());
    }
    return response;
}

function handleAuthFailure() {
    window.localStorage.removeItem('dropbox_token');
    window.localStorage.removeItem('dropbox_refresh_token');
    accessToken = null;
    if (countdownInterval) clearInterval(countdownInterval);
    alert('Your Dropbox session has expired or the token is invalid. Please sign in again.');
    window.location.reload();
}

// Does the actual Dropbox fetch and throws on any failure (including
// a 401, after triggering the re-auth flow). Callers that must not
// proceed on stale/missing data (e.g. updateDataWrapper) should call
// this directly inside their own try/catch instead of fetchState(),
// which swallows errors for the background polling use case.
async function fetchStateInternal() {
    const response = await dropboxFetch('https://content.dropboxapi.com/2/files/download', () => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path: FILE_PATH }) },
    }));

    if (response.status === 401) {
        handleAuthFailure();
        throw new Error('Unauthorized');
    }
    if (response.status === 409) {
        appData = defaultData;
        if (!appData.activeEventId) appData.activeEventId = appData.events[0].id;
        await saveState();
        return;
    }
    if (!response.ok) throw new Error('Failed to fetch from Dropbox');

    currentRev = JSON.parse(response.headers.get('Dropbox-API-Result')).rev;
    appData = await response.json();

    if (!appData.events) appData.events = defaultData.events;
    if (!appData.settings) appData.settings = defaultData.settings;
    if (!appData.activeEventId && appData.events.length > 0) appData.activeEventId = appData.events[0].id;
}

async function fetchState() {
    try {
        await fetchStateInternal();
        applyThemeColor();
        renderApp();
        if (!document.getElementById('view-management').classList.contains('hidden')) renderManagement();
    } catch (error) {
        console.error('Error fetching state:', error);
    }
}

async function saveState() {
    const mode = currentRev ? { '.tag': 'update', update: currentRev } : 'add';
    const response = await dropboxFetch('https://content.dropboxapi.com/2/files/upload', () => ({
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path: FILE_PATH, mode: mode, autorename: false, mute: true }),
        },
        body: JSON.stringify(appData),
    }));
    if (response.status === 401) {
        handleAuthFailure();
        throw new Error('Unauthorized');
    }
    if (response.status === 409) {
        return false;
    }

    currentRev = (await response.json()).rev;
    return true;
}

// --- DATA MANAGEMENT & EXPORT LOGIC ---

async function exportDataZip() {
    if (!appData) return alert('No data available to export.');
    const now = new Date();
    const dateStr =
        now.getFullYear() +
        '-' +
        String(now.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(now.getDate()).padStart(2, '0') +
        '_' +
        String(now.getHours()).padStart(2, '0') +
        '-' +
        String(now.getMinutes()).padStart(2, '0') +
        '-' +
        String(now.getSeconds()).padStart(2, '0');
    const zip = new JSZip();
    zip.file('data.json', JSON.stringify(appData, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SimpleLiveTally_Export_${dateStr}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

const MAX_SAVE_ATTEMPTS = 5;

async function updateDataWrapper(updateFn) {
    const result = await runUpdateWithRetry({
        fetchState: fetchStateInternal,
        updateFn,
        saveState,
        maxAttempts: MAX_SAVE_ATTEMPTS,
    });

    if (result.status === 'success') {
        applyThemeColor();
        renderApp();
        renderManagement();
    } else if (result.status === 'fetch-failed') {
        console.error('Error refreshing state during update:', result.error);
        alert(
            "Couldn't reach Dropbox to sync the latest data. Your change was not saved — please check your connection and try again.",
        );
    } else if (result.status === 'conflict-exhausted') {
        alert("Couldn't save your change after several attempts due to a data conflict. Please try again.");
    } else if (result.status === 'save-failed') {
        // handleAuthFailure() (called from saveState()) already alerted
        // and is reloading the page — nothing else to do here.
        console.error('Error saving:', result.error);
    }

    return result;
}

// Settings & Factory Reset
function saveSettings() {
    const t = document.getElementById('set-title').value;
    const l = document.getElementById('set-logo').value;
    const c = document.getElementById('set-color').value;

    if (!isAllowedMediaUrl(l)) return alert('Logo URL must be a valid http:// or https:// link.');

    updateDataWrapper(() => {
        appData.settings.title = t;
        appData.settings.logoUrl = l;
        appData.settings.themeColor = c;
    });
}

async function factoryReset() {
    if (confirm('Would you like to export a ZIP backup before resetting all data?')) {
        await exportDataZip();
    }
    if (
        confirm(
            'WARNING: FACTORY RESET.\n\nThis will permanently delete ALL Events, ALL Teams, and ALL Transactions. Only your theme settings will remain.\n\nAre you absolutely sure you want to start fresh?',
        )
    ) {
        updateDataWrapper(() => {
            appData.events = [];
            appData.entities = [];
            appData.transactions = [];
            appData.activeEventId = '';
        });
    }
}

// Raw JSON bulk editor
function loadJsonEditor() {
    document.getElementById('json-editor').value = JSON.stringify(appData, null, 2);
    document.getElementById('json-editor-message').classList.add('hidden');
}

function showJsonEditorMessage(text, isSuccess) {
    const msg = document.getElementById('json-editor-message');
    msg.textContent = text;
    msg.className = `text-xs font-medium mb-2 flex-shrink-0 ${isSuccess ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`;
    msg.classList.remove('hidden');
}

async function reloadJsonEditor() {
    if (!confirm('Reload from the server? Any unsaved edits in this editor will be lost.')) return;
    await fetchState();
    loadJsonEditor();
}

async function saveJsonEditor() {
    const textarea = document.getElementById('json-editor');
    const result = parseAppDataJson(textarea.value);

    if (!result.valid) {
        showJsonEditorMessage(result.error, false);
        return;
    }

    if (!confirm('This will overwrite the entire saved dataset with the JSON below. Continue?')) return;

    const saveBtn = document.getElementById('json-editor-save-btn');
    saveBtn.disabled = true;
    saveBtn.innerText = 'Saving...';

    const updateResult = await updateDataWrapper(() => {
        appData = result.data;
        if (!appData.activeEventId && appData.events.length > 0) appData.activeEventId = appData.events[0].id;
    });

    saveBtn.disabled = false;
    saveBtn.innerText = 'Save Changes';

    if (updateResult.status === 'success') {
        // Reflects the post-save, normalized data; the failure paths
        // leave the textarea untouched so the operator's draft isn't lost.
        showJsonEditorMessage('Saved.', true);
        loadJsonEditor();
    } else {
        showJsonEditorMessage('Save failed — see the alert for details. Your edits above are unchanged.', false);
    }
}

// Events
function addEvent() {
    const name = document.getElementById('new-event-name').value;
    const startDate = document.getElementById('new-event-start').value;
    const endDate = document.getElementById('new-event-end').value;
    const goalAmount = parseFloat(document.getElementById('new-event-goal').value) || null;
    if (!name) return alert('Event Name required.');
    updateDataWrapper(() => {
        const newId = 'evt_' + Date.now();
        appData.events.push({ id: newId, name, goalAmount, startDate, endDate });
        appData.activeEventId = newId;
    });
    document.getElementById('new-event-name').value = '';
    document.getElementById('new-event-goal').value = '';
    document.getElementById('new-event-start').value = '';
    document.getElementById('new-event-end').value = '';
}

function editEvent(id) {
    const newName = document.getElementById(`ev-name-${id}`).value;
    const newGoal = parseFloat(document.getElementById(`ev-goal-${id}`).value) || null;
    const newStart = document.getElementById(`ev-start-${id}`).value;
    const newEnd = document.getElementById(`ev-end-${id}`).value;
    updateDataWrapper(() => {
        const ev = appData.events.find((e) => e.id === id);
        if (ev) {
            ev.name = newName;
            ev.goalAmount = newGoal;
            ev.startDate = newStart;
            ev.endDate = newEnd;
        }
    });
}

async function purgeEvent(id) {
    if (confirm('Would you like to export a ZIP backup before purging this event and its transactions?')) {
        await exportDataZip();
    }
    if (
        confirm(
            'Are you ABSOLUTELY SURE? This will permanently delete the event and ALL associated transactions. This action cannot be undone.',
        )
    ) {
        updateDataWrapper(() => {
            appData.events = appData.events.filter((e) => e.id !== id);
            appData.transactions = appData.transactions.filter((t) => t.eventId !== id);
            if (appData.activeEventId === id) {
                appData.activeEventId = appData.events.length > 0 ? appData.events[0].id : '';
            }
        });
    }
}

// Entities
function addEntity() {
    const namePublic = document.getElementById('new-ent-public').value.trim();
    const namePrivate = document.getElementById('new-ent-private').value;
    const imageUrl = document.getElementById('new-ent-img').value;
    if (!namePublic) return alert('Public Name required.');

    const exists = isDuplicateName(appData.entities, namePublic);
    if (exists) return alert('An entity with this public name already exists. Please choose a unique name.');

    if (!isAllowedMediaUrl(imageUrl)) return alert('Image URL must be a valid http:// or https:// link.');

    updateDataWrapper(() => {
        appData.entities.push({
            id: 'ent_' + Date.now(),
            namePublic,
            namePrivate,
            imageUrl,
            color: colors[Math.floor(Math.random() * colors.length)],
        });
    });
    document.getElementById('new-ent-public').value = '';
    document.getElementById('new-ent-private').value = '';
    document.getElementById('new-ent-img').value = '';
}

function editEntity(id) {
    const newPub = document.getElementById(`ent-pub-${id}`).value.trim();
    const newPriv = document.getElementById(`ent-priv-${id}`).value;
    const newImg = document.getElementById(`ent-img-${id}`).value;
    const newCol = document.getElementById(`ent-col-${id}`).value;

    if (!newPub) return alert('Public Name required.');

    const exists = isDuplicateName(appData.entities, newPub, id);
    if (exists) return alert('Another entity with this public name already exists.');

    if (!isAllowedMediaUrl(newImg)) return alert('Image URL must be a valid http:// or https:// link.');

    updateDataWrapper(() => {
        const ent = appData.entities.find((e) => e.id === id);
        if (ent) {
            ent.namePublic = newPub;
            ent.namePrivate = newPriv;
            ent.imageUrl = newImg;
            ent.color = newCol;
        }
    });
}

function purgeEntity(id) {
    if (
        confirm(
            'Are you sure you want to delete this Team? All transactions for this team will also be permanently deleted.',
        )
    ) {
        updateDataWrapper(() => {
            appData.entities = appData.entities.filter((e) => e.id !== id);
            appData.transactions = appData.transactions.filter((t) => t.entityId !== id);
        });
    }
}

// --- OPTIMISTIC UI TRANSACTION LOGIC ---
async function changeActiveEvent() {
    const select = document.getElementById('active-event-select');
    if (!select) return;
    const newActiveId = select.value;
    updateDataWrapper(() => {
        appData.activeEventId = newActiveId;
    });
}

function submitTransaction() {
    const btn = document.getElementById('submit-btn');
    const msg = document.getElementById('entry-message');
    const entityId = document.getElementById('entity-select').value;
    const amount = parseFloat(document.getElementById('amount-input').value);

    if (!entityId || !isValidTransactionAmount(amount)) {
        msg.textContent = 'Select a team and enter a positive amount.';
        msg.className = 'text-sm mt-2 text-red-600 block';
        return;
    }
    isSubmittingTransaction = true;
    btn.disabled = true;
    btn.innerText = 'Saving...';

    const newTx = {
        id: 'txn_' + Date.now(),
        createDate: new Date().toISOString(),
        modifiedDate: new Date().toISOString(),
        entityId: entityId,
        eventId: appData.activeEventId,
        amount: amount,
    };

    appData.transactions.push(newTx);
    renderApp();

    updateDataWrapper(() => {
        appData.transactions.push(newTx);
    }).then((result) => {
        isSubmittingTransaction = false;
        btn.disabled = false;
        btn.innerText = 'Submit Vote';

        if (result.status === 'success') {
            msg.textContent = 'Transaction saved.';
            msg.className = 'text-sm mt-2 text-green-600 block';
            document.getElementById('amount-input').value = '';
            setTimeout(() => {
                msg.className = 'hidden';
            }, 3000);
            refreshTimer = 60;
        } else {
            // updateDataWrapper already alerted with the specific reason.
            msg.textContent = 'Transaction not saved — see the alert above for details.';
            msg.className = 'text-sm mt-2 text-red-600 block';
        }
    });
}

function editTransactionAmount(id) {
    const newAmt = parseFloat(document.getElementById(`tx-amt-${id}`).value);
    if (!isValidTransactionAmount(newAmt)) return alert('Enter a positive amount.');
    updateDataWrapper(() => {
        const tx = appData.transactions.find((t) => t.id === id);
        if (tx) {
            tx.amount = newAmt;
            tx.modifiedDate = new Date().toISOString();
        }
    });
}
function deleteTransaction(id) {
    if (confirm('Delete this transaction permanently?')) {
        updateDataWrapper(() => {
            appData.transactions = appData.transactions.filter((t) => t.id !== id);
        });
    }
}

// --- RENDER LOGIC ---
function runCountdown() {
    if (!appData || !appData.activeEventId) return;
    const activeEvent = appData.events.find((e) => e.id === appData.activeEventId);
    const cd = document.getElementById('event-countdown');

    if (activeEvent && activeEvent.endDate) {
        const diff = new Date(activeEvent.endDate).getTime() - new Date().getTime();
        if (diff > 0) {
            const d = Math.floor(diff / (1000 * 60 * 60 * 24));
            const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            cd.innerText = `🏁 Ends in: ${d}d ${h}h ${m}m ${s}s`;
            cd.classList.remove('hidden');
        } else {
            cd.innerText = `🏁 Event Ended`;
            cd.classList.remove('hidden');
        }
    } else {
        cd.classList.add('hidden');
    }
}

function renderManagement() {
    if (!appData) return;

    document.getElementById('set-title').value = appData.settings.title || 'Simple Live Tally';
    document.getElementById('set-logo').value = appData.settings.logoUrl || '';
    document.getElementById('set-color').value = appData.settings.themeColor || 'bg-blue-600';

    const evList = document.getElementById('events-list');
    evList.innerHTML = '';
    if (appData.events.length === 0) {
        evList.innerHTML = '<p class="text-sm text-gray-500 italic">No events configured.</p>';
    } else {
        appData.events.forEach((ev) => {
            evList.innerHTML += `
                <div class="bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 shadow-sm">
                    <input type="text" id="ev-name-${ev.id}" value="${escapeHtml(ev.name)}" class="w-full p-2 border border-gray-400 dark:border-gray-600 rounded text-sm mb-3 font-semibold shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500">
                    <div class="flex flex-wrap gap-2 mb-3">
                        <div class="flex-1 min-w-[100px]"><label class="text-xs text-gray-500">Goal ($)</label><input type="number" id="ev-goal-${ev.id}" value="${ev.goalAmount || ''}" class="w-full p-1.5 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700"></div>
                        <div class="flex-1 min-w-[160px]"><label class="text-xs text-gray-500">Start</label><input type="datetime-local" id="ev-start-${ev.id}" value="${ev.startDate || ''}" class="w-full p-1.5 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700"></div>
                        <div class="flex-1 min-w-[160px]"><label class="text-xs text-gray-500">End</label><input type="datetime-local" id="ev-end-${ev.id}" value="${ev.endDate || ''}" class="w-full p-1.5 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700"></div>
                    </div>
                    <div class="flex justify-between items-center mt-2 border-t dark:border-gray-700 pt-3">
                        <button data-action="edit-event" data-id="${ev.id}" class="text-xs bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 font-semibold py-1.5 px-4 rounded transition-colors">Save Changes</button>
                        <button data-action="purge-event" data-id="${ev.id}" class="text-xs bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 font-semibold py-1.5 px-3 rounded transition-colors" title="Delete event and all its transactions">Purge Event</button>
                    </div>
                </div>`;
        });
    }

    const entList = document.getElementById('entities-list');
    entList.innerHTML = '';
    if (appData.entities.length === 0) {
        entList.innerHTML = '<p class="text-sm text-gray-500 italic">No teams registered.</p>';
    } else {
        appData.entities.forEach((ent) => {
            const colorOptions = colors
                .map(
                    (c) =>
                        `<option value="${c}" ${ent.color === c ? 'selected' : ''}>${c.replace('bg-', '').replace('-500', '')}</option>`,
                )
                .join('');
            entList.innerHTML += `
                <div class="bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col gap-3">
                    <div class="flex gap-2">
                        <input type="text" id="ent-pub-${ent.id}" value="${escapeHtml(ent.namePublic)}" class="flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm font-semibold shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Public Name">
                        <input type="text" id="ent-priv-${ent.id}" value="${escapeHtml(ent.namePrivate)}" class="flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Private Name">
                    </div>
                    <div class="flex gap-2">
                        <input type="url" id="ent-img-${ent.id}" value="${escapeHtml(ent.imageUrl)}" class="flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Image URL">
                        <select id="ent-col-${ent.id}" class="p-2 border border-gray-400 dark:border-gray-600 rounded text-sm ${ent.color} text-white font-semibold shadow-inner outline-none">${colorOptions}</select>
                    </div>
                    <div class="flex justify-between items-center mt-1 border-t dark:border-gray-700 pt-3">
                        <button data-action="edit-entity" data-id="${ent.id}" class="text-xs bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 font-semibold py-1.5 px-4 rounded transition-colors">Save Changes</button>
                        <button data-action="purge-entity" data-id="${ent.id}" class="text-xs bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 font-semibold py-1.5 px-3 rounded transition-colors" title="Delete team and its transactions">Delete Team</button>
                    </div>
                </div>`;
        });
    }

    const txList = document.getElementById('transactions-list');
    txList.innerHTML = '';
    if (appData.events.length === 0) {
        txList.innerHTML = '<p class="text-sm text-gray-500 p-2 italic">No active event available.</p>';
    } else {
        const activeTx = appData.transactions
            .filter((t) => t.eventId === appData.activeEventId)
            .sort((a, b) => new Date(b.createDate) - new Date(a.createDate));
        if (activeTx.length === 0) {
            txList.innerHTML = '<p class="text-sm text-gray-500 p-2 italic">No transactions for this event yet.</p>';
        } else {
            activeTx.forEach((tx) => {
                const ent = appData.entities.find((e) => e.id === tx.entityId);
                const entName = ent ? ent.namePublic : 'Unknown';
                const dt = new Date(tx.createDate).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                });

                txList.innerHTML += `
                    <div class="flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors border-b dark:border-gray-700 last:border-0">
                        <div class="flex flex-col">
                            <span class="text-sm font-semibold">${escapeHtml(entName)}</span>
                            <span class="text-xs text-gray-500">${dt}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-sm font-medium opacity-50">$</span>
                            <input type="number" id="tx-amt-${tx.id}" value="${tx.amount}" step="0.01" class="w-20 p-1 border border-gray-300 dark:border-gray-500 rounded text-sm text-right bg-white dark:bg-gray-800 shadow-inner">
                            <button data-action="edit-transaction" data-id="${tx.id}" class="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-1.5 rounded hover:bg-blue-200" title="Update Amount">Update</button>
                            <button data-action="delete-transaction" data-id="${tx.id}" class="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-2 py-1.5 rounded hover:bg-red-200" title="Delete">X</button>
                        </div>
                    </div>`;
            });
        }
    }
}

function renderApp() {
    if (!appData) return;
    const isTvMode = window.location.hash === '#tv';

    document.getElementById('header-title').innerText = appData.settings.title || 'Simple Live Tally';
    document.getElementById('leaderboard-title').innerText = appData.settings.title || 'Live Leaderboard';

    const headLogo = document.getElementById('header-logo');
    if (appData.settings.logoUrl && !isTvMode) {
        headLogo.src = appData.settings.logoUrl;
        headLogo.classList.remove('hidden');
    } else {
        headLogo.classList.add('hidden');
    }

    const submitBtn = document.getElementById('submit-btn');
    const amtInput = document.getElementById('amount-input');

    if (appData.events.length === 0 || appData.entities.length === 0) {
        document.getElementById('leaderboard-subtitle').innerText = 'System requires setup (Add an Event & Team)';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = 'Setup Required';
            submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
            amtInput.disabled = true;
        }
        document.getElementById('leaderboard').innerHTML =
            '<div class="text-center text-gray-500 mt-10 italic">Leaderboard is empty.</div>';
        document.getElementById('goal-gauge-container').innerHTML = '';
        document.getElementById('ticker-wrapper').classList.add('hidden');
        return;
    } else {
        // Guarded by isSubmittingTransaction (not submitBtn.disabled) so this
        // can always recover the button from a prior "Setup Required" state
        // once an event/team exists, while still leaving an in-flight
        // "Saving..." submission alone.
        if (submitBtn && !isSubmittingTransaction) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Submit Vote';
            submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            amtInput.disabled = false;
        }
    }

    const eventSelect = document.getElementById('active-event-select');
    eventSelect.innerHTML = '';
    let activeEvent = null;
    appData.events.forEach((evt) => {
        const opt = document.createElement('option');
        opt.value = evt.id;
        opt.text = evt.name;
        if (evt.id === appData.activeEventId) {
            opt.selected = true;
            activeEvent = evt;
        }
        eventSelect.appendChild(opt);
    });
    document.getElementById('leaderboard-subtitle').innerText =
        `Active Event: ${activeEvent ? activeEvent.name : 'Unknown'}`;

    const entitySelect = document.getElementById('entity-select');
    const currentSelectedEntityId = entitySelect.value;
    entitySelect.innerHTML = '';
    appData.entities.forEach((ent) => {
        const opt = document.createElement('option');
        opt.value = ent.id;
        opt.text = ent.namePublic;
        if (ent.id === currentSelectedEntityId) {
            opt.selected = true;
        }
        entitySelect.appendChild(opt);
    });

    const totals = computeTotals(appData.entities, appData.transactions, appData.activeEventId);
    const sortedEntities = sortEntitiesByTotal(appData.entities, totals);
    const maxTotal = Math.max(...Object.values(totals), 10);

    // --- Render Scrolling Top Ticker (Top 5 Leaders) ---
    const tickerWrapper = document.getElementById('ticker-wrapper');
    const tickerContent = document.getElementById('ticker-content');
    const topNCount = 5;
    const topLeaders = sortedEntities.slice(0, topNCount);

    if (topLeaders.length > 0) {
        let tickerHtml = '';
        for (let i = 0; i < 2; i++) {
            topLeaders.forEach((ent, idx) => {
                const rank = idx + 1;
                const amt = totals[ent.id];
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
                tickerHtml += `<div class="flex items-center gap-2 px-4"><span class="text-yellow-400 font-bold">${medal}</span> <span>${escapeHtml(ent.namePublic)}:</span> <span class="text-green-400 font-bold">$${amt.toFixed(2)}</span></div>`;
            });
        }
        tickerContent.innerHTML = tickerHtml;
        tickerWrapper.classList.remove('hidden');
    } else {
        tickerWrapper.classList.add('hidden');
    }

    // --- Render Goal Gauge ---
    const gaugeContainer = document.getElementById('goal-gauge-container');
    const totalRaised = Object.values(totals).reduce((sum, val) => sum + val, 0);

    if (activeEvent && activeEvent.goalAmount && activeEvent.goalAmount > 0) {
        const goalAmount = parseFloat(activeEvent.goalAmount);
        const dashArray = 125.66;
        const { dashOffset } = computeGaugeGeometry(totalRaised, goalAmount, dashArray);

        const gaugeSize = isTvMode ? 'w-56 h-28' : 'w-48 h-24';
        const textSize = isTvMode ? 'text-3xl' : 'text-xl';
        const labelSize = isTvMode ? 'text-sm text-gray-400' : 'text-xs text-gray-500';

        const valColor =
            isTvMode || document.documentElement.classList.contains('dark') ? 'text-white' : 'text-gray-900';
        const bgStroke = isTvMode || document.documentElement.classList.contains('dark') ? '#374151' : '#e5e7eb';
        const fgStroke =
            appData.settings.themeColor && appData.settings.themeColor.includes('red')
                ? '#ef4444'
                : appData.settings.themeColor && appData.settings.themeColor.includes('green')
                  ? '#22c55e'
                  : appData.settings.themeColor && appData.settings.themeColor.includes('purple')
                    ? '#a855f7'
                    : '#3b82f6';

        gaugeContainer.innerHTML = `
            <div class="relative ${gaugeSize}">
                <svg viewBox="0 0 100 50" class="overflow-visible w-full h-full">
                    <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="${bgStroke}" stroke-width="10" stroke-linecap="round"></path>
                    <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="${fgStroke}" stroke-width="10" stroke-linecap="round" 
                          stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}" class="transition-all duration-1000 ease-out"></path>
                </svg>
                <div class="absolute bottom-0 left-0 right-0 text-center flex flex-col translate-y-2">
                    <span class="font-bold ${textSize} ${valColor}">$${totalRaised.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    <span class="uppercase font-semibold tracking-wide ${labelSize}">of $${goalAmount.toLocaleString()}</span>
                </div>
            </div>
        `;
        gaugeContainer.classList.remove('hidden');
    } else {
        gaugeContainer.innerHTML = '';
        gaugeContainer.classList.add('hidden');
    }

    // --- Render Leaderboard Bars ---
    const board = document.getElementById('leaderboard');
    const overflowNote = document.getElementById('leaderboard-overflow');

    const tagPadding = isTvMode ? 'py-0.5 px-4 text-lg' : 'py-1 px-3 text-sm';
    const barHeight = isTvMode ? 'h-8 mb-3' : 'h-8 mb-4';
    const badgeBg = isTvMode
        ? 'bg-gray-800 text-gray-200 border border-gray-700'
        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-700';
    const trackBg = isTvMode ? 'bg-gray-800' : 'bg-gray-200 dark:bg-gray-800';

    function buildRowHtml(ent) {
        const amount = totals[ent.id];
        const percentage = computeBarPercentage(amount, maxTotal);
        const imgHtml = ent.imageUrl
            ? `<img src="${escapeHtml(ent.imageUrl)}" class="w-6 h-6 rounded-full mr-2 inline-block object-cover border border-gray-300 dark:border-gray-600">`
            : '';

        const amountInsideBar =
            amount > 0
                ? `<div class="absolute inset-y-0 left-0 flex items-center ${isTvMode ? 'pl-4' : 'pl-3'} pointer-events-none">
                   <span class="text-white font-bold ${isTvMode ? 'text-lg' : 'text-sm'} drop-shadow-md">$${amount.toFixed(2)}</span>
               </div>`
                : '';

        return `
            <div class="relative pt-1">
                <div class="flex mb-1 items-center justify-between">
                    <div class="flex items-center">
                        ${isTvMode && ent.imageUrl ? `<img src="${escapeHtml(ent.imageUrl)}" class="w-8 h-8 rounded-full mr-3 inline-block object-cover border-2 border-gray-600">` : imgHtml}
                        <span class="font-semibold inline-block uppercase rounded-full shadow-sm ${badgeBg} ${tagPadding}">${escapeHtml(ent.namePublic)}</span>
                    </div>
                </div>
                <div class="relative overflow-hidden flex rounded-full ${trackBg} ${barHeight} shadow-inner">
                    <div data-bar-fill="${percentage}" class="h-full ${ent.color || 'bg-blue-500'} transition-all duration-1000 ease-out"></div>
                    ${amountInsideBar}
                </div>
            </div>`;
    }

    function renderRows(list) {
        board.innerHTML = list.map(buildRowHtml).join('');
        // Bar widths are set via the CSSOM property setter (not a
        // style="..." attribute in the markup above) so they work under a
        // strict style-src CSP without 'unsafe-inline'.
        board.querySelectorAll('[data-bar-fill]').forEach((el) => {
            el.style.width = `${el.dataset.barFill}%`;
        });
    }

    const tvDisplayEntities = sortedEntities.slice(0, 10);
    renderRows(isTvMode ? tvDisplayEntities : sortedEntities);

    if (!isTvMode && sortedEntities.length > 0) {
        // Rows are already laid out (even though overflow is clipped), so
        // measure the real rendered row height and trim to whatever
        // actually fits instead of letting the board scroll.
        const rowGap = parseFloat(getComputedStyle(board).rowGap) || 0;
        const rowHeight = board.firstElementChild ? board.firstElementChild.getBoundingClientRect().height : 0;
        const available = board.clientHeight;
        const maxVisible = computeMaxVisibleRows(available, rowHeight, rowGap);

        if (maxVisible < sortedEntities.length) {
            renderRows(sortedEntities.slice(0, maxVisible));
            const hiddenCount = sortedEntities.length - maxVisible;
            overflowNote.textContent = `+ ${hiddenCount} more not shown — resize or maximize the window to see the full board`;
            overflowNote.classList.remove('hidden');
        } else {
            overflowNote.classList.add('hidden');
        }
    } else {
        overflowNote.classList.add('hidden');
    }

    runCountdown();
}

function initApp() {
    checkViewMode();
    accessToken = window.localStorage.getItem('dropbox_token');
    if (accessToken) {
        document.getElementById('login-section').classList.replace('block', 'hidden');
        document.getElementById('app-section').classList.replace('hidden', 'flex');
        document.getElementById('status').innerText = 'Connected';

        fetchState();

        setInterval(() => {
            refreshTimer--;
            document.getElementById('countdown').innerText = `Refreshing in ${refreshTimer}s...`;
            if (refreshTimer <= 0) {
                document.getElementById('countdown').innerText = 'Refreshing now...';
                fetchState();
                refreshTimer = 60;
            }
        }, 1000);

        if (!countdownInterval) countdownInterval = setInterval(runCountdown, 1000);
    } else {
        handleAuthRedirect();
    }
}

// Wires every interactive element to its handler via addEventListener
// instead of onclick="..."/onchange="..." attributes in the markup, so a
// strict script-src CSP (no 'unsafe-inline') can be enforced. Called once;
// dynamically-rendered lists (events/entities/transactions) use a single
// delegated listener per container since their buttons are recreated on
// every render.
function bindStaticEventListeners() {
    document.getElementById('dark-mode-toggle').addEventListener('click', toggleDarkMode);
    document.getElementById('login-btn').addEventListener('click', startAuthFlow);
    document.getElementById('tab-dashboard').addEventListener('click', () => switchTab('dashboard'));
    document.getElementById('tab-management').addEventListener('click', () => switchTab('management'));
    document.getElementById('submit-btn').addEventListener('click', submitTransaction);
    document.getElementById('active-event-select').addEventListener('change', changeActiveEvent);
    document.getElementById('export-zip-btn').addEventListener('click', exportDataZip);

    MGMT_TABS.forEach((tab) => {
        document.getElementById(`mgmt-tab-${tab}`).addEventListener('click', () => switchMgmtTab(tab));
    });

    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
    document.getElementById('factory-reset-btn').addEventListener('click', factoryReset);
    document.getElementById('add-entity-btn').addEventListener('click', addEntity);
    document.getElementById('add-event-btn').addEventListener('click', addEvent);
    document.getElementById('json-reload-btn').addEventListener('click', reloadJsonEditor);
    document.getElementById('json-editor-save-btn').addEventListener('click', saveJsonEditor);

    document.getElementById('admin-view-link').addEventListener('click', (event) => {
        event.preventDefault();
        window.open(window.location.pathname, '_blank');
    });

    const listActions = {
        'edit-event': editEvent,
        'purge-event': purgeEvent,
        'edit-entity': editEntity,
        'purge-entity': purgeEntity,
        'edit-transaction': editTransactionAmount,
        'delete-transaction': deleteTransaction,
    };
    ['events-list', 'entities-list', 'transactions-list'].forEach((containerId) => {
        document.getElementById(containerId).addEventListener('click', (event) => {
            const btn = event.target.closest('button[data-action]');
            if (!btn) return;
            const action = listActions[btn.dataset.action];
            if (action) action(btn.dataset.id);
        });
    });
}

bindStaticEventListeners();
window.onload = initApp;
