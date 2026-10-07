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
// The active storage backend. Every provider-specific detail (endpoints,
// request/response shapes, the meaning of a 409) lives behind this object's
// interface — see js/providers/dropbox.js for what it implements and why
// that boundary is drawn where it is. Hardcoded today since Dropbox is the
// only provider; a future settings-time picker would just assign a
// different provider object here instead of changing anything below.
const storageProvider = DropboxProvider;

// var (not let/const): keeps these as real `window` properties, so
// app state stays introspectable/settable from outside the script
// (devtools, tests) rather than living in a script-only lexical scope.
var accessToken = null;
// Set by updateConnectedAccountStatus() once fetchAccountInfo() resolves —
// null until then (and if the lookup ever fails, best-effort only). Reused
// in disconnectDropbox()'s confirmation so a deliberate disconnect names
// the account being disconnected, not just "Dropbox" in the abstract.
var connectedAccountEmail = null;
var currentRev = null;
var appData = null;
// The active event's transaction ledger as of the last successful poll —
// a flat list of create/edit/delete entries (see writeTransactionEntry).
// Summing every entry's amount for an entity gives its current total
// directly; no grouping needed for that. See collapseTransactionLedger()
// (js/logic.js) for the "one row per logical transaction" view the
// Transactions management pane needs instead.
var transactionEntries = [];
// Entries created by this device during this session that a poll hasn't
// confirmed yet (whether still in flight, queued for retry, or simply
// created after the last poll ran) — merged in by
// getVisibleTransactionEntries() so totals/the transactions list don't
// regress if a poll refresh lands while a write is still pending. Pruned
// automatically once a poll's fresh transactionEntries includes them.
var localTransactionEntries = [];
var refreshTimer = 60;
var countdownInterval = null;
var currentMgmtTab = 'settings';
var isSubmittingTransaction = false;
// The logicalId of the one entry *this device* most recently submitted via
// submitTransaction(), or null — drives the "Undo last entry" button, the
// only correction path reachable from a #keyer station (it never gets Data
// Management nav — see checkViewMode()). Replaced by a new submission,
// cleared once undone. In-memory only, like isSubmittingTransaction above:
// a reload loses it, same as the keyer losing track of what they just did.
var lastSubmittedLogicalId = null;
// Which page of the "field" grid the TV display is currently showing, once
// a roster is large enough to need one (see the spotlight+field tier in
// renderApp() and startTvFieldRotation() below). Clamped by modulo against
// the current page count on every render, so it self-corrects if the
// roster shrinks — no explicit reset needed.
var tvFieldPage = 0;
var tvFieldRotationInterval = null;
// Updates that failed to save because of a network/conflict problem (not an
// auth failure) wait here instead of being silently discarded — see
// updateDataWrapper's allowQueue option and flushPendingWrites below.
// Every item is a bare "attempt" closure — () => Promise<{status, ...}> —
// whether it's a config save (wraps runUpdateWithRetry) or a single
// transaction-entry upload, so flushPendingWrites can run any of them the
// same way. Mostly in-memory only — a page reload loses any *config* save
// still queued here — but a transaction-entry retry closure is additionally
// tagged with `.pendingEntry` (the plain, JSON-serializable entry it
// retries) so persistPendingTransactionQueue() can mirror just that subset
// to localStorage; see restorePendingTransactionQueue() below for the other
// half. Config saves aren't persisted the same way: unlike a transaction
// entry, an update is an arbitrary in-memory mutator function
// (updateDataWrapper's updateFn), not a serializable value.
var pendingQueue = [];
var isFlushingQueue = false;

// localStorage key for the persisted subset of pendingQueue described
// above — see persistPendingTransactionQueue()/restorePendingTransactionQueue().
const PENDING_TX_QUEUE_KEY = 'pending_tx_entries';

const defaultData = {
    settings: { title: 'Simple Live Tally', logoUrl: '', themeColor: 'bg-blue-600' },
    events: [{ id: 'evt_' + Date.now(), name: 'Inaugural Event', goalAmount: null, startDate: '', endDate: '' }],
    activeEventId: '',
    entities: [
        { id: 'ent_1', namePublic: 'Team Alpha', namePrivate: 'Internal Alpha', imageUrl: '', color: 'bg-red-500' },
        { id: 'ent_2', namePublic: 'Team Beta', namePrivate: 'Internal Beta', imageUrl: '', color: 'bg-blue-500' },
    ],
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

// Same palette offered by the Settings > Theme Color select (index.html),
// reused here to build each event's own theme-color <select> — see
// resolveThemeColor() in js/logic.js for how an event's choice (or leaving
// it on "Use App Default") is applied.
const THEME_COLOR_OPTIONS = [
    { value: 'bg-blue-600', label: 'Blue' },
    { value: 'bg-red-600', label: 'Red' },
    { value: 'bg-green-600', label: 'Green' },
    { value: 'bg-purple-600', label: 'Purple' },
    { value: 'bg-gray-900', label: 'Dark Gray' },
];

function themeColorOptionsHtml(selected) {
    const useDefault = `<option value="" ${!selected ? 'selected' : ''}>Use App Default</option>`;
    const opts = THEME_COLOR_OPTIONS.map(
        (c) => `<option value="${c.value}" ${selected === c.value ? 'selected' : ''}>${c.label}</option>`,
    ).join('');
    return useDefault + opts;
}

// index.html's CSP has no 'unsafe-inline' in style-src, which blocks
// HTML-parsed `style="..."` attributes — including ones built into an
// `innerHTML` string. The browser drops them silently (no thrown error,
// only a console warning), so a bar meant to render at e.g. 25% width
// instead renders at its element's plain natural/track width. CSP's
// style-src does NOT restrict a script-driven `.style.width = ...`
// assignment, though, so every dynamically-sized bar is rendered with
// `data-bar-pct="<value>"` instead of an inline style, and this applies
// the real width immediately after that markup is inserted.
function applyBarWidths(container) {
    container.querySelectorAll('[data-bar-pct]').forEach((el) => {
        el.style.width = `${el.dataset.barPct}%`;
    });
}

// A "viewer link" (see generateViewerLink() below) carries a read-only
// Dropbox access/refresh token pair in the URL hash so a second device can
// open it and be signed in immediately, without that device ever seeing
// Dropbox's own login screen. This pulls the tokens out, stores them as
// *this* device's own session, and scrubs them from the visible URL/
// history immediately — before initTheme() or anything else downstream
// reads window.location.hash, so every other hash check (isViewerHash,
// isTvMode, checkViewMode) sees a plain "#tv-viewer", exactly like a normal
// sign-in. Runs once, at script load, before any other top-level call.
function importViewerTokenFromUrl() {
    const imported = parseViewerLinkImport(window.location.hash);
    if (!imported) return;
    window.localStorage.setItem('dropbox_token', imported.accessToken);
    if (imported.refreshToken) window.localStorage.setItem('dropbox_refresh_token', imported.refreshToken);
    window.history.replaceState(null, '', window.location.pathname + window.location.search + VIEWER_HASH);
}
importViewerTokenFromUrl();

// --- DARK MODE LOGIC ---
// TV/viewer displays default to dark (legible on a projector or large screen
// from a distance) until this device's operator explicitly picks a theme
// with the toggle; every other view defaults to light. Once a preference is
// stored, it wins regardless of mode — the default only applies the first
// time a given browser opens the page.
function initTheme() {
    const stored = window.localStorage.getItem('darkMode');
    const isTvDisplay = window.location.hash === '#tv' || isViewerHash(window.location.hash);
    const isDark = stored === null ? isTvDisplay : stored === 'true';
    document.documentElement.classList.toggle('dark', isDark);
}
function toggleDarkMode() {
    document.documentElement.classList.toggle('dark');
    window.localStorage.setItem('darkMode', document.documentElement.classList.contains('dark'));
    if (appData) renderApp();
}
initTheme();

// --- VIEW MODE MANAGEMENT ---
// The active event, or undefined if none is set/found — a single lookup
// used everywhere branding (resolveThemeColor/resolveLogoUrl) or other
// per-event rendering needs "the event currently on screen."
function getActiveEvent() {
    if (!appData) return undefined;
    return appData.events.find((e) => e.id === appData.activeEventId);
}

function applyThemeColor() {
    if (!appData || !appData.settings) return;
    const theme = resolveThemeColor(appData.settings, getActiveEvent());

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
    // Data Management (team/event grids, transaction list) benefits from
    // using most of the viewport on a wide screen; the Live Dashboard stays
    // at the narrower reading width it was designed around. TV/viewer mode
    // (checkViewMode) always calls switchTab('dashboard') before applying
    // its own max-w-full override, so this never fights that.
    const container = document.getElementById('main-container');
    container.classList.toggle('max-w-5xl', tab !== 'management');
    container.classList.toggle('max-w-[1800px]', tab === 'management');
    applyThemeColor();
    if (tab === 'management') {
        renderManagement();
        switchMgmtTab(currentMgmtTab);
    }
}

const MGMT_TABS = ['settings', 'entities', 'events', 'transactions'];

function switchMgmtTab(tab) {
    currentMgmtTab = tab;
    MGMT_TABS.forEach((t) => {
        document.getElementById(`mgmt-view-${t}`).classList.toggle('hidden', t !== tab);
        document.getElementById(`mgmt-tab-${t}`).classList.toggle('active', t === tab);
    });
}

function checkViewMode() {
    const isViewer = isViewerHash(window.location.hash);
    const isTvMode = window.location.hash === '#tv' || isViewer;
    const isKeyer = isKeyerHash(window.location.hash);
    const loginText = document.getElementById('login-text');
    if (loginText) {
        loginText.innerText = isViewer
            ? 'Connect to Dropbox to display this event on this screen (view-only — no data can be added or changed here).'
            : isKeyer
              ? 'Connect to Dropbox to add donations from this station.'
              : 'Connect to Dropbox to start tallying votes.';
    }
    const container = document.getElementById('main-container');
    const header = document.getElementById('main-header');
    const nav = document.getElementById('app-nav');
    const adminControls = document.getElementById('admin-controls');
    const title = document.getElementById('leaderboard-title');
    const subtitle = document.getElementById('leaderboard-subtitle');
    const countdownDisplay = document.getElementById('event-countdown');
    const tvLogo = document.getElementById('tv-logo');
    const footer = document.getElementById('main-footer');
    const tvThemeToggle = document.getElementById('tv-theme-toggle');

    // The border/subtitle colors below are left to the leaderboard-header's
    // and subtitle's own `dark:` Tailwind classes in index.html rather than
    // forced here — TV mode used to hardcode the dark-theme color literally
    // (not as a dark: variant), which meant it could never actually go
    // light. initTheme() (called in both branches below) is what decides
    // light vs. dark now, same as every other view.
    if (isTvMode) {
        switchTab('dashboard');
        initTheme();
        tvThemeToggle.classList.remove('hidden');

        container.classList.replace('max-w-5xl', 'max-w-full');
        container.classList.replace('my-4', 'my-0');
        container.classList.replace('rounded-lg', 'rounded-none');
        container.classList.add('h-dvh', 'p-4', 'sm:p-6');

        header.classList.add('hidden');
        nav.classList.add('hidden');
        adminControls.classList.add('hidden');
        footer.classList.add('hidden');

        title.classList.replace('text-xl', 'text-4xl');
        subtitle.classList.add('text-xl', 'mt-1');

        countdownDisplay.classList.replace('text-sm', 'text-2xl');

        const tvLogoUrl = appData && appData.settings ? resolveLogoUrl(appData.settings, getActiveEvent()) : '';
        if (tvLogoUrl) {
            tvLogo.src = tvLogoUrl;
            tvLogo.classList.remove('hidden');
        }
    } else {
        initTheme();
        tvThemeToggle.classList.add('hidden');

        container.classList.replace('max-w-full', 'max-w-5xl');
        container.classList.replace('my-0', 'my-4');
        container.classList.replace('rounded-none', 'rounded-lg');
        container.classList.remove('h-dvh', 'p-4', 'sm:p-6');

        header.classList.remove('hidden');
        footer.classList.remove('hidden');

        title.classList.replace('text-4xl', 'text-xl');
        subtitle.classList.remove('text-xl', 'mt-1');

        countdownDisplay.classList.replace('text-2xl', 'text-sm');
        tvLogo.classList.add('hidden');
        adminControls.classList.remove('hidden');

        // A keyer station only ever adds donations — Data Management
        // (Settings/Teams/Events, and every destructive action inside it)
        // is never reachable from this UI, even though the underlying
        // Dropbox token is the exact same full read-write grant an admin
        // has (Dropbox has no way to scope a token to "write-only, and
        // only under /transactions/"). This is a mistake-prevention
        // boundary, not a security one — see storageProvider.viewerScope
        // above for the one role that *is* enforced by Dropbox itself.
        if (isKeyer) {
            switchTab('dashboard');
            nav.classList.add('hidden');
        } else {
            nav.classList.remove('hidden');
        }
    }

    if (appData) {
        applyThemeColor();
        renderApp();
    }
}

window.addEventListener('hashchange', checkViewMode);
window.addEventListener('online', flushPendingWrites);

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
    // Dropbox's redirect back from /oauth2/authorize lands on the plain
    // REDIRECT_URI with no fragment, so a #tv/#tv-viewer/#keyer hash the
    // operator was on gets dropped by that browser navigation. Stash it
    // here and restore it in handleAuthRedirect() so signing in from a
    // TV/viewer/keyer screen doesn't silently land back on the full admin
    // layout.
    window.localStorage.setItem('post_auth_hash', window.location.hash);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const scope = isViewerHash(window.location.hash) ? storageProvider.viewerScope : undefined;
    window.location.href = storageProvider.getAuthUrl({
        clientId: CLIENT_ID,
        codeChallenge,
        redirectUri: REDIRECT_URI,
        scope,
    });
}
async function handleAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
        const restoredHash = window.localStorage.getItem('post_auth_hash') || '';
        window.localStorage.removeItem('post_auth_hash');
        const newUrl = window.location.pathname + restoredHash;
        window.history.replaceState({}, document.title, newUrl);
        const result = await storageProvider.exchangeCodeForToken({
            clientId: CLIENT_ID,
            code,
            redirectUri: REDIRECT_URI,
            codeVerifier: window.localStorage.getItem('pkce_verifier'),
        });
        if (result) {
            window.localStorage.setItem('dropbox_token', result.accessToken);
            if (result.refreshToken) window.localStorage.setItem('dropbox_refresh_token', result.refreshToken);
            initApp();
        }
    }
}

// Starts the OAuth flow for a *second device's* viewer link — see
// buildViewerLinkUrl()/parseViewerLinkImport() in js/logic.js for the
// hand-off itself. This runs from the admin's own already-authenticated
// device, so it must not touch that device's own session: a separate PKCE
// verifier key keeps this grant distinguishable from a normal sign-in once
// Dropbox redirects back (see completeViewerLinkGeneration()), and nothing
// here ever writes to the plain "dropbox_token"/"dropbox_refresh_token"
// keys the admin's own session uses.
async function generateViewerLink() {
    const codeVerifier = generateRandomString(64);
    window.localStorage.setItem('viewer_link_pkce_verifier', codeVerifier);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    window.location.href = storageProvider.getAuthUrl({
        clientId: CLIENT_ID,
        codeChallenge,
        redirectUri: REDIRECT_URI,
        scope: storageProvider.viewerScope,
    });
}

// The other half of generateViewerLink(): exchanges the code Dropbox just
// redirected back with, then shows the resulting link instead of signing
// this device in as that viewer (this device already has its own admin
// session, untouched throughout). Called from initApp() before it looks at
// the admin's own accessToken, since a signed-in admin generating a link
// would otherwise just fall straight into their own dashboard.
async function completeViewerLinkGeneration(code, codeVerifier) {
    window.localStorage.removeItem('viewer_link_pkce_verifier');
    window.history.replaceState({}, document.title, window.location.pathname);
    const result = await storageProvider.exchangeCodeForToken({
        clientId: CLIENT_ID,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier,
    });
    if (result) {
        showGeneratedViewerLink(result.accessToken, result.refreshToken);
    } else {
        alert('Could not generate the viewer link. Please try again from Settings.');
        window.location.reload();
    }
}

// Renders `url` as a scannable QR code into #viewer-link-qr, so connecting
// the second device can be "point its camera at this" instead of typing or
// transferring a long URL with embedded tokens by hand. Uses the vendored
// js/vendor/qrcode.js (the `qrcode` global) rather than a CDN — see
// js/vendor/README.md for why. Fixed black-on-white regardless of the
// admin's own dark/light theme: QR scanners rely on that contrast, so this
// is the one piece of UI that deliberately ignores applyThemeColor().
function renderViewerLinkQr(url) {
    const container = document.getElementById('viewer-link-qr');
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    container.innerHTML = qr.createSvgTag({
        cellSize: 4,
        margin: 4,
        scalable: true,
        alt: 'QR code encoding the viewer link',
        title: 'Viewer link QR code',
    });
}

function showGeneratedViewerLink(accessToken, refreshToken) {
    const baseUrl = window.location.origin + window.location.pathname;
    const url = buildViewerLinkUrl(baseUrl, accessToken, refreshToken);
    document.getElementById('viewer-link-output').value = url;
    renderViewerLinkQr(url);
    document.getElementById('login-section').classList.replace('block', 'hidden');
    document.getElementById('viewer-link-result').classList.remove('hidden');
    // The admin's own session was never touched by generating this link —
    // reflect that here too, rather than leaving the header's default
    // "Not authenticated" text showing while they actually still are.
    document.getElementById('status').innerText = 'Connected';
}

async function copyViewerLink() {
    const input = document.getElementById('viewer-link-output');
    try {
        await navigator.clipboard.writeText(input.value);
    } catch {
        // Clipboard API can be unavailable (older browser, non-HTTPS,
        // permission denied) — fall back to the old select-and-hope
        // approach so the button still does something useful.
        input.select();
        document.execCommand('copy');
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
        const result = await storageProvider.refreshAccessToken({ clientId: CLIENT_ID, refreshToken });
        if (!result) return false;
        accessToken = result.accessToken;
        window.localStorage.setItem('dropbox_token', accessToken);
        return true;
    } catch (error) {
        console.error('Error refreshing Dropbox token:', error);
        return false;
    }
}

// Runs a storage-provider API request; on a 401 it attempts one silent
// token refresh and retries once before giving up. buildOptions is a
// function (not a plain object) so the retry picks up the refreshed
// accessToken rather than replaying the stale Authorization header.
async function authFetch(url, buildOptions) {
    let response = await fetch(url, buildOptions());
    if (response.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) response = await fetch(url, buildOptions());
    }
    return response;
}

// Shows which Dropbox account this device is actually connected as
// ("Connected as you@example.com" instead of just "Connected"), so a
// device accidentally authenticated against the wrong account is obvious
// immediately instead of silently showing an empty/unrelated event. Every
// role requests account_info.read (even the read-only viewer), so this
// works the same everywhere. Fire-and-forget and best-effort: a failed
// lookup just leaves the generic "Connected" text already shown, never
// blocks or fails the rest of startup.
async function updateConnectedAccountStatus() {
    const result = await storageProvider.fetchAccountInfo(authFetch, () => accessToken);
    if (result.status !== 'ok') return;
    connectedAccountEmail = result.email;
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.innerText = `Connected as ${result.email}`;
}

// A plain wrapper around window.location.reload(), used everywhere the app
// needs to reload the page. jsdom's Location object doesn't allow
// window.location.reload to be reassigned (it silently no-ops rather than
// throwing), so tests can't stub the real thing directly — they stub this
// instead.
function reloadPage() {
    window.location.reload();
}

function handleAuthFailure() {
    window.localStorage.removeItem('dropbox_token');
    window.localStorage.removeItem('dropbox_refresh_token');
    accessToken = null;
    if (countdownInterval) clearInterval(countdownInterval);
    alert('Your Dropbox session has expired or the token is invalid. Please sign in again.');
    reloadPage();
}

// A deliberate, operator-initiated disconnect — distinct from
// handleAuthFailure(), which fires on an unexpected 401 and alerts the
// user their session expired. This is the "force a full refresh, or sign
// in as someone else" escape hatch: there was previously no way to drop
// the cached Dropbox token short of clearing browser storage by hand.
function disconnectDropbox() {
    const accountLine = connectedAccountEmail ? ` (currently connected as ${connectedAccountEmail})` : '';
    if (
        !confirm(
            `Disconnect from Dropbox${accountLine}? You will need to sign in again to view or edit this event. Nothing stored in Dropbox is affected.`,
        )
    ) {
        return;
    }
    window.localStorage.removeItem('dropbox_token');
    window.localStorage.removeItem('dropbox_refresh_token');
    reloadPage();
}

// --- CONFIG STORAGE (settings/events/entities — still one shared file
// multiple devices could legitimately edit at the same instant, so this
// keeps the fetch -> mutate -> conditional-save -> retry-on-409 cycle). ---

// Fetches via the active storage provider and throws on any failure
// (including a 401, after triggering the re-auth flow). Callers that must
// not proceed on stale/missing data (e.g. updateDataWrapper) should call
// this directly inside their own try/catch instead of fetchAll(), which
// swallows errors for the background polling use case.
async function fetchStateInternal() {
    const result = await storageProvider.fetchConfig(authFetch, () => accessToken, FILE_PATH);

    if (result.status === 'unauthorized') {
        handleAuthFailure();
        throw new Error('Unauthorized');
    }
    if (result.status === 'not-found') {
        appData = defaultData;
        if (!appData.activeEventId) appData.activeEventId = appData.events[0].id;
        await saveState();
        return;
    }
    if (result.status === 'error') throw result.error;

    currentRev = result.rev;
    appData = result.data;

    if (!appData.events) appData.events = defaultData.events;
    if (!appData.settings) appData.settings = defaultData.settings;
    if (!appData.activeEventId && appData.events.length > 0) appData.activeEventId = appData.events[0].id;
}

async function saveState() {
    const result = await storageProvider.saveConfig(authFetch, () => accessToken, FILE_PATH, appData, currentRev);
    if (result.status === 'unauthorized') {
        handleAuthFailure();
        throw new Error('Unauthorized');
    }
    if (result.status === 'conflict') return false;
    if (result.status === 'error') throw result.error;

    currentRev = result.rev;
    return true;
}

// --- TRANSACTION LEDGER STORAGE (one file per create/edit/delete entry,
// under /transactions/<eventId>/<entryId>.json — nothing ever overwrites
// or deletes another device's entry, so unlike config there is no
// fetch-before-save/conflict-retry needed for a single entry write). ---

function makeEntryId() {
    return window.crypto.randomUUID();
}

// Downloads every entry for one event's ledger via the active storage
// provider — for Dropbox, that's a single files/download_zip call on the
// event's folder instead of listing it and downloading each small file
// individually, so the read cost stays flat regardless of how many
// transactions the event has accumulated. See js/providers/dropbox.js for
// the ceiling that holds at (and BACKLOG.md for why a different provider
// might not be able to make the same one-call guarantee).
async function downloadTransactionEntries(eventId) {
    if (!eventId) return [];
    const result = await storageProvider.fetchLedger(authFetch, () => accessToken, `/transactions/${eventId}`);
    if (result.status === 'unauthorized') {
        handleAuthFailure();
        throw new Error('Unauthorized');
    }
    if (result.status === 'not-found') {
        // No transactions folder yet for this event (e.g. brand new event,
        // nobody has added anything yet) — not a real error.
        return [];
    }
    if (result.status === 'error') throw result.error;
    return result.entries;
}

async function fetchTransactionEntriesInternal() {
    transactionEntries = await downloadTransactionEntries(appData.activeEventId);
    // Anything this device wrote that's now reflected in the fresh poll no
    // longer needs to be merged in separately.
    const confirmedIds = new Set(transactionEntries.map((e) => e.id));
    localTransactionEntries = localTransactionEntries.filter((e) => !confirmedIds.has(e.id));
}

// The full picture for computing totals / rendering the transactions list:
// the last poll's confirmed entries, plus anything this device created
// locally that the last poll hasn't confirmed yet (still in flight, queued
// for retry, or simply written after that poll ran).
function getVisibleTransactionEntries() {
    if (localTransactionEntries.length === 0) return transactionEntries;
    const confirmedIds = new Set(transactionEntries.map((e) => e.id));
    return transactionEntries.concat(localTransactionEntries.filter((e) => !confirmedIds.has(e.id)));
}

async function writeTransactionEntry(entry) {
    const path = `/transactions/${entry.eventId}/${entry.id}.json`;
    const result = await storageProvider.writeLedgerEntry(authFetch, () => accessToken, path, entry);
    if (result.status === 'unauthorized') {
        handleAuthFailure();
        throw new Error('Unauthorized');
    }
    if (result.status === 'error') throw result.error;
}

// A single, non-queueing attempt to save one entry — used both for the
// very first try and for every retry from flushPendingWrites. Never
// re-queues on failure itself; the caller (saveTransactionEntry below, or
// flushPendingQueue's own "leave it in `remaining`" behavior) owns that.
async function attemptTransactionEntrySave(entry) {
    try {
        await writeTransactionEntry(entry);
        return { status: 'success' };
    } catch (error) {
        return { status: 'fetch-failed', error };
    }
}

// Called once, at the moment a transaction/edit/delete entry is created.
// Tries immediately; on failure, queues a bare retry attempt for
// flushPendingWrites. The entry was already pushed onto
// localTransactionEntries by the caller before this runs, so it stays
// visible in totals/the transactions list either way until a poll confirms
// it — no separate success/failure bookkeeping needed here for that.
async function saveTransactionEntry(entry) {
    const result = await attemptTransactionEntrySave(entry);
    if (result.status !== 'success') {
        console.error('Error writing transaction entry, queueing for retry:', result.error);
        const attempt = () => attemptTransactionEntrySave(entry);
        attempt.pendingEntry = entry;
        pendingQueue.push(attempt);
        renderPendingIndicator();
        persistPendingTransactionQueue();
    }
    return result;
}

// Mirrors the transaction-entry retries currently in pendingQueue (tagged
// with .pendingEntry — see the var pendingQueue comment above) to
// localStorage, so a reload or crash mid-outage doesn't silently drop a
// donation that was entered but never made it to Dropbox. Called after
// every pendingQueue mutation that could add or remove one of these:
// saveTransactionEntry() queueing a new failure, and flushPendingWrites()
// clearing out whatever just succeeded.
function persistPendingTransactionQueue() {
    const entries = pendingQueue.filter((fn) => fn.pendingEntry).map((fn) => fn.pendingEntry);
    if (entries.length === 0) {
        window.localStorage.removeItem(PENDING_TX_QUEUE_KEY);
    } else {
        window.localStorage.setItem(PENDING_TX_QUEUE_KEY, JSON.stringify(entries));
    }
}

// The other half of persistPendingTransactionQueue() — called once from
// initApp(), before the first fetchAll(), so anything still queued from a
// prior session reappears in the totals/transactions list immediately
// instead of only after its retry eventually succeeds. Malformed storage
// (a hand-edited value, a future format) is treated as empty rather than
// thrown on, since this is best-effort recovery, not a source of truth —
// the real source of truth is always Dropbox.
function restorePendingTransactionQueue() {
    const raw = window.localStorage.getItem(PENDING_TX_QUEUE_KEY);
    if (!raw) return;
    let entries;
    try {
        entries = JSON.parse(raw);
        if (!Array.isArray(entries)) throw new Error('not an array');
    } catch {
        window.localStorage.removeItem(PENDING_TX_QUEUE_KEY);
        return;
    }
    entries.forEach((entry) => {
        localTransactionEntries.push(entry);
        const attempt = () => attemptTransactionEntrySave(entry);
        attempt.pendingEntry = entry;
        pendingQueue.push(attempt);
    });
    if (entries.length > 0) renderPendingIndicator();
}

// Loads the config file and the active event's transaction ledger together
// (the two reads the dashboard needs), swallowing errors for the
// background polling use case — see fetchStateInternal/
// fetchTransactionEntriesInternal for the throwing versions callers that
// must not proceed on stale data use instead.
async function fetchAll() {
    try {
        await fetchStateInternal();
        await fetchTransactionEntriesInternal();
        applyThemeColor();
        renderApp();
        if (!document.getElementById('view-management').classList.contains('hidden')) renderManagement();
    } catch (error) {
        console.error('Error fetching state:', error);
    }
}

// --- DATA MANAGEMENT & EXPORT LOGIC ---

// Bundles the config file, every raw transaction-entry file across every
// event (the complete, unmodified ledger — full audit trail, including
// entries for events since removed from the dashboard), and a computed
// summary.json (current totals + collapsed transaction list per event) for
// convenience, so an operator doesn't have to hand-sum the raw ledger to
// see where things stood at export time.
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

    const summary = { generatedAt: now.toISOString(), events: {} };
    for (const event of appData.events) {
        let entries;
        try {
            entries = await downloadTransactionEntries(event.id);
        } catch (error) {
            console.error(`Error exporting transactions for event ${event.id}:`, error);
            entries = [];
        }
        entries.forEach((entry) => {
            zip.file(`transactions/${event.id}/${entry.id}.json`, JSON.stringify(entry, null, 2));
        });
        summary.events[event.id] = {
            name: event.name,
            totals: computeTotals(appData.entities, entries, event.id),
            eventTotal: computeEventTotal(entries, event.id),
            transactions: collapseTransactionLedger(entries),
        };
    }
    zip.file('summary.json', JSON.stringify(summary, null, 2));

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

// Drives a config change (Settings/Teams/Events) through the fetch ->
// mutate -> save -> retry cycle. options.allowQueue (default true): when a
// save fails because of the network or a save conflict (not an auth
// failure), queue a fresh attempt for automatic retry instead of
// discarding the change.
async function updateDataWrapper(updateFn, options) {
    const allowQueue = !options || options.allowQueue !== false;
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
    } else if (result.status === 'save-failed') {
        // handleAuthFailure() (called from saveState()) already alerted
        // and is reloading the page — nothing else to do here.
        console.error('Error saving:', result.error);
    } else if (allowQueue) {
        console.error('Error saving, queueing for retry:', result.error || result.status);
        pendingQueue.push(() =>
            runUpdateWithRetry({
                fetchState: fetchStateInternal,
                updateFn,
                saveState,
                maxAttempts: MAX_SAVE_ATTEMPTS,
            }),
        );
        renderPendingIndicator();
    } else if (result.status === 'fetch-failed') {
        console.error('Error refreshing state during update:', result.error);
        alert(
            "Couldn't reach Dropbox to sync the latest data. Your change was not saved — please check your connection and try again.",
        );
    } else {
        alert("Couldn't save your change after several attempts due to a data conflict. Please try again.");
    }

    return result;
}

function renderPendingIndicator() {
    const el = document.getElementById('pending-writes-indicator');
    if (!el) return;
    if (pendingQueue.length === 0) {
        el.classList.add('hidden');
        return;
    }
    el.textContent = `⏳ ${pendingQueue.length} pending — click to retry`;
    el.classList.remove('hidden');
}

// Retries queued attempts (config saves and transaction-entry writes
// alike — every queue item is already a bare, fully-formed attempt
// function) in order, stopping at the first one that still doesn't
// succeed rather than dropping it or anything queued behind it. Safe to
// call opportunistically (online event, periodic refresh tick, manual
// click) since it's a no-op while already running or when the queue is
// empty.
async function flushPendingWrites() {
    if (isFlushingQueue || pendingQueue.length === 0) return;
    isFlushingQueue = true;
    try {
        const { succeeded, remaining } = await flushPendingQueue(pendingQueue, (attemptFn) => attemptFn());
        pendingQueue = remaining;
        if (succeeded.length > 0) {
            applyThemeColor();
            renderApp();
            renderManagement();
        }
    } finally {
        isFlushingQueue = false;
        renderPendingIndicator();
        persistPendingTransactionQueue();
    }
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
            'WARNING: FACTORY RESET.\n\nThis will remove ALL Events and ALL Teams from the dashboard. Previously recorded transactions remain in the permanent audit ledger (visible via Export) — they are never deleted, just no longer shown. Only your theme settings will remain.\n\nAre you absolutely sure you want to start fresh?',
        )
    ) {
        updateDataWrapper(() => {
            appData.events = [];
            appData.entities = [];
            appData.activeEventId = '';
        }).then(() => {
            transactionEntries = [];
            localTransactionEntries = [];
            renderApp();
            renderManagement();
        });
    }
}

// Events
function addEvent() {
    const name = document.getElementById('new-event-name').value;
    const startDate = document.getElementById('new-event-start').value;
    const endDate = document.getElementById('new-event-end').value;
    const goalAmount = parseFloat(document.getElementById('new-event-goal').value) || null;
    const logoUrl = document.getElementById('new-event-logo').value;
    const themeColor = document.getElementById('new-event-color').value;
    if (!name) return alert('Event Name required.');
    if (!isAllowedMediaUrl(logoUrl)) return alert('Logo URL must be a valid http:// or https:// link.');
    updateDataWrapper(() => {
        const newId = 'evt_' + Date.now();
        appData.events.push({ id: newId, name, goalAmount, startDate, endDate, logoUrl, themeColor });
        appData.activeEventId = newId;
    }).then(async (result) => {
        if (result.status === 'success') {
            await fetchTransactionEntriesInternal();
            renderApp();
            renderManagement();
        }
    });
    document.getElementById('new-event-name').value = '';
    document.getElementById('new-event-goal').value = '';
    document.getElementById('new-event-start').value = '';
    document.getElementById('new-event-end').value = '';
    document.getElementById('new-event-logo').value = '';
    document.getElementById('new-event-color').value = '';
}

function editEvent(id) {
    const newName = document.getElementById(`ev-name-${id}`).value;
    const newGoal = parseFloat(document.getElementById(`ev-goal-${id}`).value) || null;
    const newStart = document.getElementById(`ev-start-${id}`).value;
    const newEnd = document.getElementById(`ev-end-${id}`).value;
    const newLogo = document.getElementById(`ev-logo-${id}`).value;
    const newColor = document.getElementById(`ev-color-${id}`).value;
    if (!isAllowedMediaUrl(newLogo)) return alert('Logo URL must be a valid http:// or https:// link.');
    updateDataWrapper(() => {
        const ev = appData.events.find((e) => e.id === id);
        if (ev) {
            ev.name = newName;
            ev.goalAmount = newGoal;
            ev.startDate = newStart;
            ev.endDate = newEnd;
            ev.logoUrl = newLogo;
            ev.themeColor = newColor;
        }
    });
}

async function purgeEvent(id) {
    if (confirm('Would you like to export a ZIP backup before removing this event?')) {
        await exportDataZip();
    }
    if (
        confirm(
            'Are you sure? This removes the event from the dashboard. Its recorded transactions remain in the permanent audit ledger (visible via Export) — they are never deleted.',
        )
    ) {
        updateDataWrapper(() => {
            appData.events = appData.events.filter((e) => e.id !== id);
            if (appData.activeEventId === id) {
                appData.activeEventId = appData.events.length > 0 ? appData.events[0].id : '';
            }
        }).then(async (result) => {
            if (result.status === 'success') {
                await fetchTransactionEntriesInternal();
                renderApp();
                renderManagement();
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
            'Remove this Team from the dashboard? Transactions already recorded for it remain in the permanent audit ledger (visible via Export) but will no longer count toward live totals.',
        )
    ) {
        updateDataWrapper(() => {
            appData.entities = appData.entities.filter((e) => e.id !== id);
        });
    }
}

// --- OPTIMISTIC UI TRANSACTION LOGIC ---
async function changeActiveEvent() {
    const select = document.getElementById('active-event-select');
    if (!select) return;
    const newActiveId = select.value;
    const result = await updateDataWrapper(() => {
        appData.activeEventId = newActiveId;
    });
    if (result.status === 'success') {
        await fetchTransactionEntriesInternal();
        renderApp();
        renderManagement();
    }
}

// Names this device once (persisted in localStorage) so every ledger entry
// it writes can be attributed to a station — most valuable for #keyer
// devices, where several volunteers may be entering donations from
// different tables at once and it's worth being able to tell whose entry
// is whose in the exported audit trail. Only prompts on a keyer device;
// the admin flow is assumed to be one known operator and doesn't need one.
function ensureDeviceLabel() {
    if (!isKeyerHash(window.location.hash)) return 'Admin';
    let label = window.localStorage.getItem('device_label');
    if (!label) {
        label = window.prompt('Name this station (e.g. "Front Table"):', '') || 'Keyer';
        window.localStorage.setItem('device_label', label);
    }
    return label;
}

function submitTransaction() {
    const btn = document.getElementById('submit-btn');
    const msg = document.getElementById('entry-message');
    const entityId = resolveEntitySelection(appData.entities, document.getElementById('entity-select').value);
    const amount = parseFloat(document.getElementById('amount-input').value);

    if (!entityId || !isValidTransactionAmount(amount)) {
        msg.textContent = 'Select a team and enter a positive amount.';
        msg.className = 'text-sm text-red-600 block';
        return;
    }
    isSubmittingTransaction = true;
    btn.disabled = true;
    btn.innerText = 'Saving...';

    const entryId = makeEntryId();
    const newEntry = {
        id: entryId,
        logicalId: entryId,
        kind: 'create',
        entityId,
        eventId: appData.activeEventId,
        amount,
        createDate: new Date().toISOString(),
        createdBy: ensureDeviceLabel(),
    };

    localTransactionEntries.push(newEntry);
    renderApp();

    saveTransactionEntry(newEntry).then((result) => {
        isSubmittingTransaction = false;
        btn.disabled = false;
        btn.innerText = 'Submit Vote';

        if (result.status === 'success') {
            msg.textContent = 'Transaction saved.';
            msg.className = 'text-sm text-green-600 block';
            document.getElementById('amount-input').value = '';
            setTimeout(() => {
                msg.className = 'hidden';
            }, 3000);
            refreshTimer = 60;
        } else {
            // Queued rather than alerted — the entry itself isn't lost
            // (already visible via localTransactionEntries), just delayed.
            msg.textContent = "Couldn't save right now — queued, will retry automatically.";
            msg.className = 'text-sm text-yellow-600 block';
        }

        lastSubmittedLogicalId = entryId;
        updateUndoButtonVisibility();
    });
}

function updateUndoButtonVisibility() {
    const btn = document.getElementById('undo-last-entry-btn');
    if (btn) btn.classList.toggle('hidden', !lastSubmittedLogicalId);
}

// Deletes (via a negation entry, same as deleteTransaction() below — nothing
// in this ledger is ever edited/removed in place) whichever single entry
// this device most recently submitted through submitTransaction(). The only
// correction path reachable from a #keyer station, which never gets Data
// Management nav; see the lastSubmittedLogicalId comment above for why it's
// scoped to just "the last one" rather than a general undo stack.
function undoLastEntry() {
    if (!lastSubmittedLogicalId) return;

    const currentEntries = getVisibleTransactionEntries().filter((e) => e.logicalId === lastSubmittedLogicalId);
    if (currentEntries.length === 0) {
        lastSubmittedLogicalId = null;
        updateUndoButtonVisibility();
        return;
    }
    const currentNet = currentEntries.reduce((sum, e) => sum + e.amount, 0);
    const entity = appData.entities.find((e) => e.id === currentEntries[0].entityId);
    const entityLabel = isGeneralFundEntry(currentEntries[0].entityId)
        ? GENERAL_FUND_LABEL
        : entity
          ? entity.namePublic
          : 'that team';
    if (!confirm(`Undo the last entry — $${currentNet.toFixed(2)} to ${entityLabel}?`)) return;

    const newEntry = {
        id: makeEntryId(),
        logicalId: lastSubmittedLogicalId,
        kind: 'delete',
        entityId: currentEntries[0].entityId,
        eventId: currentEntries[0].eventId,
        amount: computeDeleteAmount(currentNet),
        createDate: new Date().toISOString(),
        createdBy: ensureDeviceLabel(),
    };

    lastSubmittedLogicalId = null;
    updateUndoButtonVisibility();
    localTransactionEntries.push(newEntry);
    renderApp();
    renderManagement();

    const msg = document.getElementById('entry-message');
    saveTransactionEntry(newEntry).then((result) => {
        if (result.status === 'success') {
            msg.textContent = 'Last entry undone.';
            msg.className = 'text-sm text-green-600 block';
            setTimeout(() => {
                msg.className = 'hidden';
            }, 3000);
        } else {
            msg.textContent = "Couldn't undo right now — queued, will retry automatically.";
            msg.className = 'text-sm text-yellow-600 block';
        }
    });
}

function editTransactionAmount(id) {
    const newAmt = parseFloat(document.getElementById(`tx-amt-${id}`).value);
    if (!isValidTransactionAmount(newAmt)) return alert('Enter a positive amount.');

    const currentEntries = getVisibleTransactionEntries().filter((e) => e.logicalId === id);
    if (currentEntries.length === 0) return;
    const currentNet = currentEntries.reduce((sum, e) => sum + e.amount, 0);

    const newEntry = {
        id: makeEntryId(),
        logicalId: id,
        kind: 'edit',
        entityId: currentEntries[0].entityId,
        eventId: currentEntries[0].eventId,
        amount: computeEditDelta(currentNet, newAmt),
        createDate: new Date().toISOString(),
        createdBy: ensureDeviceLabel(),
    };

    localTransactionEntries.push(newEntry);
    renderApp();
    renderManagement();
    saveTransactionEntry(newEntry);
}

function deleteTransaction(id) {
    if (!confirm('Delete this transaction permanently?')) return;

    const currentEntries = getVisibleTransactionEntries().filter((e) => e.logicalId === id);
    if (currentEntries.length === 0) return;
    const currentNet = currentEntries.reduce((sum, e) => sum + e.amount, 0);

    const newEntry = {
        id: makeEntryId(),
        logicalId: id,
        kind: 'delete',
        entityId: currentEntries[0].entityId,
        eventId: currentEntries[0].eventId,
        amount: computeDeleteAmount(currentNet),
        createDate: new Date().toISOString(),
        createdBy: ensureDeviceLabel(),
    };

    localTransactionEntries.push(newEntry);
    renderApp();
    renderManagement();
    saveTransactionEntry(newEntry);
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
                <div class="min-w-0 bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 shadow-sm">
                    <input type="text" id="ev-name-${ev.id}" value="${escapeHtml(ev.name)}" class="w-full p-2 border border-gray-400 dark:border-gray-600 rounded text-sm mb-3 font-semibold shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500">
                    <div class="flex flex-wrap gap-2 mb-3">
                        <div class="flex-1 min-w-[100px]"><label class="text-xs text-gray-500">Goal ($)</label><input type="number" id="ev-goal-${ev.id}" value="${ev.goalAmount || ''}" class="w-full p-1.5 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700"></div>
                        <div class="flex-1 min-w-[160px]"><label class="text-xs text-gray-500">Start</label><input type="datetime-local" id="ev-start-${ev.id}" value="${ev.startDate || ''}" class="w-full p-1.5 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700"></div>
                        <div class="flex-1 min-w-[160px]"><label class="text-xs text-gray-500">End</label><input type="datetime-local" id="ev-end-${ev.id}" value="${ev.endDate || ''}" class="w-full p-1.5 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700"></div>
                    </div>
                    <div class="flex gap-2 mb-3">
                        <input type="url" id="ev-logo-${ev.id}" value="${escapeHtml(ev.logoUrl)}" class="min-w-0 flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Event Logo URL (Optional)">
                        <select id="ev-color-${ev.id}" class="min-w-0 flex-shrink-0 p-2 border border-gray-400 dark:border-gray-600 rounded text-xs shadow-inner bg-white dark:bg-gray-700 outline-none" title="Event Theme Color">${themeColorOptionsHtml(ev.themeColor)}</select>
                    </div>
                    <div class="flex justify-between items-center mt-2 border-t dark:border-gray-700 pt-3">
                        <button data-action="edit-event" data-id="${ev.id}" class="text-xs bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 font-semibold py-1.5 px-4 rounded transition-colors">Save Changes</button>
                        <button data-action="purge-event" data-id="${ev.id}" class="text-xs bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 font-semibold py-1.5 px-3 rounded transition-colors" title="Remove event from the dashboard (transactions stay in the audit ledger)">Remove Event</button>
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
                <div class="min-w-0 bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col gap-3">
                    <div class="flex gap-2">
                        <input type="text" id="ent-pub-${ent.id}" value="${escapeHtml(ent.namePublic)}" class="min-w-0 flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm font-semibold shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Public Name">
                        <input type="text" id="ent-priv-${ent.id}" value="${escapeHtml(ent.namePrivate)}" class="min-w-0 flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Private Name">
                    </div>
                    <div class="flex gap-2">
                        <input type="url" id="ent-img-${ent.id}" value="${escapeHtml(ent.imageUrl)}" class="min-w-0 flex-1 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm shadow-inner bg-white dark:bg-gray-700 outline-none focus:ring-2 focus:ring-blue-500" placeholder="Image URL">
                        <select id="ent-col-${ent.id}" class="min-w-0 flex-shrink-0 p-2 border border-gray-400 dark:border-gray-600 rounded text-sm ${ent.color} text-white font-semibold shadow-inner outline-none">${colorOptions}</select>
                    </div>
                    <div class="flex justify-between items-center mt-1 border-t dark:border-gray-700 pt-3">
                        <button data-action="edit-entity" data-id="${ent.id}" class="text-xs bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 font-semibold py-1.5 px-4 rounded transition-colors">Save Changes</button>
                        <button data-action="purge-entity" data-id="${ent.id}" class="text-xs bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 font-semibold py-1.5 px-3 rounded transition-colors" title="Remove team from the dashboard (transactions stay in the audit ledger)">Remove Team</button>
                    </div>
                </div>`;
        });
    }

    const txList = document.getElementById('transactions-list');
    txList.innerHTML = '';
    if (appData.events.length === 0) {
        txList.innerHTML = '<p class="text-sm text-gray-500 p-2 italic">No active event available.</p>';
    } else {
        const activeTx = collapseTransactionLedger(getVisibleTransactionEntries()).filter(
            (t) => t.eventId === appData.activeEventId,
        );
        if (activeTx.length === 0) {
            txList.innerHTML = '<p class="text-sm text-gray-500 p-2 italic">No transactions for this event yet.</p>';
        } else {
            activeTx.forEach((tx) => {
                const ent = appData.entities.find((e) => e.id === tx.entityId);
                const entName = isGeneralFundEntry(tx.entityId)
                    ? '💝 Donation (General Fund)'
                    : ent
                      ? ent.namePublic
                      : 'Unknown';
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
                            <span class="text-xs text-gray-500">${dt}${tx.createdBy ? ` · ${escapeHtml(tx.createdBy)}` : ''}</span>
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
    const resolvedLogoUrl = resolveLogoUrl(appData.settings, getActiveEvent());
    if (resolvedLogoUrl && !isTvMode) {
        headLogo.src = resolvedLogoUrl;
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
    document.getElementById('leaderboard-subtitle').innerText = activeEvent ? activeEvent.name : '';

    // #entity-select is a plain text <input> backed by the #entity-options
    // <datalist> below (type-to-search — far faster than scrolling a
    // <select> once there are more than a handful of teams). Its typed
    // value is never touched here, only the list of suggestions, so an
    // operator's in-progress search survives a re-render (e.g. the 60s
    // poll) instead of being reset like the old <select>'s selection was.
    const entityDatalist = document.getElementById('entity-options');
    entityDatalist.innerHTML = '';
    appData.entities.forEach((ent) => {
        const opt = document.createElement('option');
        opt.value = ent.namePublic;
        entityDatalist.appendChild(opt);
    });
    const generalFundOpt = document.createElement('option');
    generalFundOpt.value = GENERAL_FUND_LABEL;
    entityDatalist.appendChild(generalFundOpt);

    const totals = computeTotals(appData.entities, getVisibleTransactionEntries(), appData.activeEventId);
    const sortedEntities = sortEntitiesByTotal(appData.entities, totals);

    // --- Render Scrolling Top Ticker (Top 25 Leaders) ---
    const tickerWrapper = document.getElementById('ticker-wrapper');
    const tickerContent = document.getElementById('ticker-content');
    const topNCount = 25;
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
        // The CSS animation scrolls exactly one copy of the (duplicated)
        // content per cycle, so its duration has to scale with the leader
        // count or a full board of 25 would fly by at 5x the speed a 5-item
        // board did. 5s/entry matches the original fixed 25s-for-5-entries
        // pace. Set via .style (script-driven, not an HTML attribute) since
        // the CSP's style-src has no 'unsafe-inline' — see applyBarWidths().
        tickerContent.style.animationDuration = `${topLeaders.length * 5}s`;
        tickerWrapper.classList.remove('hidden');
    } else {
        tickerWrapper.classList.add('hidden');
    }

    // --- Render Goal Gauge ---
    const gaugeContainer = document.getElementById('goal-gauge-container');
    // Uses every transaction for the event (team-tied and General Fund
    // alike), not just Object.values(totals) — a General Fund donation
    // must still count toward the overall total/goal even though it's
    // excluded from computeTotals()'s per-entity (ranking) totals.
    const totalRaised = computeEventTotal(getVisibleTransactionEntries(), appData.activeEventId);

    if (activeEvent) {
        const textSize = isTvMode ? 'text-2xl' : 'text-base';
        // isTvMode only controls size here — color follows the actual
        // light/dark theme (see initTheme()), not the display mode, so a
        // TV display switched to light mode renders with light-mode colors.
        const isDark = document.documentElement.classList.contains('dark');
        const valColor = isDark ? 'text-white' : 'text-gray-900';
        const labelColor = isDark ? 'text-gray-400' : 'text-gray-500';
        const formattedTotal = totalRaised.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });

        if (activeEvent.goalAmount && activeEvent.goalAmount > 0) {
            const goalAmount = parseFloat(activeEvent.goalAmount);
            const { percentage } = computeGaugeGeometry(totalRaised, goalAmount);
            const trackColor = isDark ? 'bg-gray-800' : 'bg-gray-200';
            const resolvedTheme = resolveThemeColor(appData.settings, activeEvent);
            const fillColor = resolvedTheme.includes('red')
                ? 'bg-red-500'
                : resolvedTheme.includes('green')
                  ? 'bg-green-500'
                  : resolvedTheme.includes('purple')
                    ? 'bg-purple-500'
                    : 'bg-blue-500';

            gaugeContainer.innerHTML = `
                <div class="w-full">
                    <div class="${textSize} font-bold ${valColor} mb-1.5">
                        $${formattedTotal}
                        <span class="${labelColor}">of $${goalAmount.toLocaleString()} · ${Math.round(percentage)}% to goal</span>
                    </div>
                    <div class="w-full h-1.5 rounded-full ${trackColor} overflow-hidden">
                        <div class="h-full rounded-full ${fillColor} transition-all duration-1000 ease-out" data-bar-pct="${percentage}"></div>
                    </div>
                </div>
            `;
            applyBarWidths(gaugeContainer);
        } else {
            // No goal set for this event — nothing to show progress
            // against, so just the running total, no track/fill bar.
            gaugeContainer.innerHTML = `
                <div class="w-full">
                    <div class="${textSize} font-bold ${valColor}">
                        $${formattedTotal} <span class="${labelColor}">raised</span>
                    </div>
                </div>
            `;
        }
        gaugeContainer.classList.remove('hidden');
    } else {
        gaugeContainer.innerHTML = '';
        gaugeContainer.classList.add('hidden');
    }

    // --- Render Leaderboard (Minimal Ticker) ---
    // Three density tiers keep every team visible and legible instead of
    // ever hiding one behind a "+N more" note (see TICKER_HERO_MAX/
    // TICKER_TWIN_MAX/TICKER_SPOTLIGHT_SIZE in js/logic.js): a short roster
    // gets one column of full-size rows, a medium one splits into two
    // columns, and a large one keeps only the top TICKER_SPOTLIGHT_SIZE at
    // full size with everyone else in a dense field grid below. On the TV
    // display that field grid also pages through TICKER_TV_FIELD_PAGE_SIZE
    // entries at a time (see startTvFieldRotation()) so it never shrinks
    // past legible or needs to scroll; the dashboard just lets it grow.
    const board = document.getElementById('leaderboard');
    board.classList.toggle('overflow-y-auto', !isTvMode);
    board.classList.toggle('overflow-hidden', isTvMode);

    const rankSize = isTvMode ? 'text-3xl w-10' : 'text-lg w-8';
    const nameSize = isTvMode ? 'text-base' : 'text-xs';
    const amountSize = isTvMode ? 'text-4xl' : 'text-2xl';
    const avatarSize = isTvMode ? 'w-9 h-9' : 'w-7 h-7';

    function formatAmount(amount) {
        return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // sortedEntities is already highest-total-first, so its first entry
    // (if any) holds the leader's amount every other row's bar scales
    // against — see computeRelativeBarPercent() in js/logic.js.
    const leaderAmount = sortedEntities.length > 0 ? totals[sortedEntities[0].id] || 0 : 0;

    function heroRowHtml(ent, rank) {
        const avatar = ent.imageUrl
            ? `<img src="${escapeHtml(ent.imageUrl)}" class="${avatarSize} rounded-full object-cover border border-gray-300 dark:border-gray-700 flex-shrink-0">`
            : '';
        const barPct = computeRelativeBarPercent(totals[ent.id], leaderAmount);
        return `
            <div class="flex items-baseline gap-3 py-2.5 border-b border-gray-200 dark:border-gray-800 last:border-b-0 break-inside-avoid">
                <span class="font-extrabold tabular-nums text-gray-400 dark:text-gray-500 ${rankSize} flex-shrink-0">${rank}</span>
                ${avatar}
                <div class="flex-1 min-w-0 flex flex-col gap-1">
                    <span class="font-bold uppercase tracking-wide truncate ${nameSize} text-gray-900 dark:text-white">${escapeHtml(ent.namePublic)}</span>
                    <div class="h-[3px] w-24 max-w-full rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
                        <div class="h-full rounded-full ${ent.color || 'bg-blue-500'} transition-all duration-700 ease-out" data-bar-pct="${barPct}"></div>
                    </div>
                </div>
                <span class="font-extrabold tabular-nums flex-shrink-0 ${amountSize} text-gray-900 dark:text-white">$${formatAmount(totals[ent.id])}</span>
            </div>`;
    }

    function fieldRowHtml(ent, rank) {
        const barPct = computeRelativeBarPercent(totals[ent.id], leaderAmount);
        return `
            <div class="flex items-baseline gap-2 py-1">
                <span class="font-extrabold tabular-nums text-gray-400 dark:text-gray-500 text-xs w-6 flex-shrink-0">${rank}</span>
                <div class="flex items-center gap-1.5 flex-1 min-w-0">
                    <div class="w-6 h-[3px] rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden flex-shrink-0">
                        <div class="h-full rounded-full ${ent.color || 'bg-blue-500'}" data-bar-pct="${barPct}"></div>
                    </div>
                    <span class="font-bold uppercase text-[10px] tracking-wide truncate text-gray-700 dark:text-gray-300">${escapeHtml(ent.namePublic)}</span>
                </div>
                <span class="font-extrabold tabular-nums flex-shrink-0 text-sm text-gray-900 dark:text-white">$${formatAmount(totals[ent.id])}</span>
            </div>`;
    }

    const tier = pickTickerTier(sortedEntities.length);

    if (tier === 'hero') {
        board.innerHTML = sortedEntities.map((ent, i) => heroRowHtml(ent, i + 1)).join('');
    } else if (tier === 'twin') {
        board.innerHTML = `<div class="columns-2 gap-6">${sortedEntities.map((ent, i) => heroRowHtml(ent, i + 1)).join('')}</div>`;
    } else {
        const spotlight = sortedEntities.slice(0, TICKER_SPOTLIGHT_SIZE);
        const field = sortedEntities.slice(TICKER_SPOTLIGHT_SIZE).map((ent, i) => ({
            ent,
            rank: i + 1 + TICKER_SPOTLIGHT_SIZE,
        }));
        const spotlightHtml = spotlight.map((ent, i) => heroRowHtml(ent, i + 1)).join('');

        let fieldSection = '';
        if (field.length > 0) {
            let pageItems = field;
            let pageIndicator = '';
            if (isTvMode) {
                const pages = paginate(field, TICKER_TV_FIELD_PAGE_SIZE);
                const pageIndex = pages.length > 0 ? tvFieldPage % pages.length : 0;
                pageItems = pages[pageIndex] || [];
                if (pages.length > 1) {
                    pageIndicator = `<div class="flex justify-center gap-1.5 mt-3">${pages
                        .map(
                            (_, i) =>
                                `<span class="w-1.5 h-1.5 rounded-full ${i === pageIndex ? 'bg-gray-400' : 'bg-gray-700'}"></span>`,
                        )
                        .join('')}</div>`;
                }
            }
            const fieldRowsHtml = pageItems.map((item) => fieldRowHtml(item.ent, item.rank)).join('');
            // A plain divider, not a labeled "Also competing — N more"
            // callout — the field grid immediately below it already makes
            // the additional participants visible; it doesn't need a
            // heading to announce that they exist.
            fieldSection = `
                <div class="border-t border-gray-200 dark:border-gray-800 pt-3 mt-1"></div>
                <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-1">${fieldRowsHtml}</div>
                ${pageIndicator}`;
        }
        board.innerHTML = spotlightHtml + fieldSection;
    }
    applyBarWidths(board);

    runCountdown();
}

// Advances the TV display's field-grid page every few seconds, once a
// roster is large enough that the spotlight+field tier needed more than
// one page (see renderApp()'s "Also competing" section). A no-op off the
// TV display (checked on every tick, since the operator can navigate away
// from #tv without a page reload) and while there's nothing to page
// through. Started once from initApp() and left running for the rest of
// the session, same pattern as countdownInterval below.
function startTvFieldRotation() {
    if (tvFieldRotationInterval) return;
    tvFieldRotationInterval = setInterval(() => {
        const isTv = window.location.hash === '#tv' || isViewerHash(window.location.hash);
        if (!isTv || !appData) return;
        tvFieldPage++;
        renderApp();
    }, 6000);
}

function initApp() {
    checkViewMode();

    // A signed-in admin generating a viewer link (see generateViewerLink())
    // still has their own dropbox_token set, so this has to be checked
    // *before* the accessToken branch below — otherwise returning from that
    // redirect would just fall straight into the admin's own dashboard
    // instead of showing the generated link.
    const viewerLinkVerifier = window.localStorage.getItem('viewer_link_pkce_verifier');
    const code = new URLSearchParams(window.location.search).get('code');
    if (code && viewerLinkVerifier) {
        completeViewerLinkGeneration(code, viewerLinkVerifier);
        return;
    }

    accessToken = window.localStorage.getItem('dropbox_token');
    if (accessToken) {
        document.getElementById('login-section').classList.replace('block', 'hidden');
        document.getElementById('app-section').classList.replace('hidden', 'flex');
        document.getElementById('status').innerText = 'Connected';
        document.getElementById('disconnect-btn').classList.remove('hidden');
        document.getElementById('footer-disconnect-sep').classList.remove('hidden');
        document.getElementById('footer-disconnect-link').classList.remove('hidden');
        updateConnectedAccountStatus();

        // Before the first fetchAll(), so anything left over from a prior
        // session's unconfirmed writes (reload/crash mid-outage) is already
        // in localTransactionEntries/pendingQueue when that first render
        // happens, instead of silently missing until its retry succeeds.
        restorePendingTransactionQueue();
        flushPendingWrites();

        fetchAll();

        setInterval(() => {
            refreshTimer--;
            document.getElementById('countdown').innerText = `Refreshing in ${refreshTimer}s...`;
            if (refreshTimer <= 0) {
                document.getElementById('countdown').innerText = 'Refreshing now...';
                fetchAll();
                flushPendingWrites();
                refreshTimer = 60;
            }
        }, 1000);

        if (!countdownInterval) countdownInterval = setInterval(runCountdown, 1000);
        startTvFieldRotation();
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
    document.getElementById('tv-theme-toggle').addEventListener('click', toggleDarkMode);
    document.getElementById('login-btn').addEventListener('click', startAuthFlow);
    document.getElementById('disconnect-btn').addEventListener('click', disconnectDropbox);
    document.getElementById('generate-viewer-link-btn').addEventListener('click', generateViewerLink);
    document.getElementById('viewer-link-copy-btn').addEventListener('click', copyViewerLink);
    document.getElementById('viewer-link-done-btn').addEventListener('click', () => window.location.reload());
    document.getElementById('tab-dashboard').addEventListener('click', () => switchTab('dashboard'));
    document.getElementById('tab-management').addEventListener('click', () => switchTab('management'));
    document.getElementById('submit-btn').addEventListener('click', submitTransaction);
    document.getElementById('undo-last-entry-btn').addEventListener('click', undoLastEntry);
    document.getElementById('active-event-select').addEventListener('change', changeActiveEvent);
    document.getElementById('export-zip-btn').addEventListener('click', exportDataZip);
    document.getElementById('pending-writes-indicator').addEventListener('click', flushPendingWrites);

    MGMT_TABS.forEach((tab) => {
        document.getElementById(`mgmt-tab-${tab}`).addEventListener('click', () => switchMgmtTab(tab));
    });

    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
    document.getElementById('factory-reset-btn').addEventListener('click', factoryReset);
    document.getElementById('add-entity-btn').addEventListener('click', addEntity);
    document.getElementById('add-event-btn').addEventListener('click', addEvent);

    document.getElementById('admin-view-link').addEventListener('click', (event) => {
        event.preventDefault();
        window.open(window.location.pathname, '_blank');
    });

    document.getElementById('footer-disconnect-link').addEventListener('click', (event) => {
        event.preventDefault();
        disconnectDropbox();
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
