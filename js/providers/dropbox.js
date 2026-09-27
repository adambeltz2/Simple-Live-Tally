// Dropbox implementation of the storage-provider interface. Everything that
// knows Dropbox's specific endpoints, request shapes, and response formats
// (rev headers, 409-means-conflict-or-not-found, download_zip) lives here;
// js/app.js's fetch/save/retry orchestration (authFetch's 401-refresh
// wrapper, runUpdateWithRetry's conflict loop, the offline write queue)
// knows nothing about Dropbox at all — it only ever sees this module's
// generic { status: 'ok' | 'unauthorized' | 'not-found' | 'conflict' |
// 'error', ... } result shape. That boundary is what would let a second
// provider (e.g. Google Drive) be added later as a sibling module without
// touching the orchestration layer — see BACKLOG.md for the real gaps a
// Drive implementation would hit (no folder-to-zip endpoint, no atomic
// conditional write) before assuming that swap is as thin as this one.
//
// Every method that talks to an endpoint requiring the access token takes
// `authFetch` (the 401-refresh-and-retry wrapper — see js/app.js) and
// `getAccessToken` (a zero-arg function, not a plain token string) as its
// first two parameters, rather than fetching directly or taking a token
// snapshot. authFetch's options are built by a thunk it can re-invoke after
// a refresh; passing a live getter instead of a string means that retry
// picks up the *refreshed* token instead of replaying the stale one.
(function (root) {
    'use strict';

    // Requested for the #tv-viewer/#keyer display-only flow instead of the
    // admin flow's default (whatever scopes are enabled in the Dropbox App
    // Console) — a viewer device only ever reads data, so it never asks for
    // files.content.write.
    const VIEWER_SCOPE = 'account_info.read files.metadata.read files.content.read';

    // Builds the Dropbox /oauth2/authorize URL. `scope`, when given, narrows
    // the requested permissions to a space-delimited scope list (used for
    // the read-only viewer flow); omitted entirely for the normal admin/
    // keyer flow, which keeps requesting whatever scopes are enabled in the
    // Dropbox App Console rather than restricting them here.
    function getAuthUrl({ clientId, codeChallenge, redirectUri, scope }) {
        // token_access_type=offline requests a refresh_token alongside the
        // short-lived access token, so the app can renew silently instead
        // of forcing operators to re-authenticate mid-event.
        let url =
            `https://www.dropbox.com/oauth2/authorize?client_id=${clientId}&response_type=code` +
            `&code_challenge=${codeChallenge}&code_challenge_method=S256` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}&token_access_type=offline`;
        if (scope) url += `&scope=${encodeURIComponent(scope)}`;
        return url;
    }

    // Exchanges an OAuth authorization code for an access/refresh token
    // pair. Returns null if Dropbox didn't hand back an access_token (bad
    // code, expired PKCE verifier, etc.) rather than throwing, since the
    // caller's only real recovery is "stay on the login screen."
    async function exchangeCodeForToken({ clientId, code, redirectUri, codeVerifier }) {
        const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
            }),
        });
        const data = await response.json();
        if (!data.access_token) return null;
        return { accessToken: data.access_token, refreshToken: data.refresh_token || null };
    }

    // Exchanges a stored refresh_token for a new access_token. Returns null
    // on any failure (network error surfaces as a rejected promise, same as
    // before — the caller already wraps this in a try/catch).
    async function refreshAccessToken({ clientId, refreshToken }) {
        const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.access_token) return null;
        return { accessToken: data.access_token };
    }

    // Fetches the shared config file (settings/events/entities). A 409
    // means the file doesn't exist yet (a brand new App Folder) — Dropbox's
    // own "doesn't exist" convention for a conditional download, not a real
    // error — surfaced as 'not-found' rather than 'error' so the caller can
    // seed defaults instead of failing.
    async function fetchConfig(authFetch, getAccessToken, path) {
        const response = await authFetch('https://content.dropboxapi.com/2/files/download', () => ({
            method: 'POST',
            headers: { Authorization: `Bearer ${getAccessToken()}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
        }));
        if (response.status === 401) return { status: 'unauthorized' };
        if (response.status === 409) return { status: 'not-found' };
        if (!response.ok) return { status: 'error', error: new Error('Failed to fetch from Dropbox') };
        const rev = JSON.parse(response.headers.get('Dropbox-API-Result')).rev;
        const data = await response.json();
        return { status: 'ok', data, rev };
    }

    // Saves the shared config file. `rev` (the last rev this caller read,
    // or falsy for "never read one yet") drives Dropbox's own conditional-
    // write check: passing it as `mode: {'.tag':'update', update: rev}`
    // makes Dropbox reject the write with 409 if the file changed since,
    // surfaced as 'conflict' so the caller's retry loop (runUpdateWithRetry
    // in js/logic.js) can re-fetch and reapply. This single field is the
    // whole conflict-detection mechanism — see BACKLOG.md for why Google
    // Drive doesn't have an equivalent.
    async function saveConfig(authFetch, getAccessToken, path, data, rev) {
        const mode = rev ? { '.tag': 'update', update: rev } : 'add';
        const response = await authFetch('https://content.dropboxapi.com/2/files/upload', () => ({
            method: 'POST',
            headers: {
                Authorization: `Bearer ${getAccessToken()}`,
                'Content-Type': 'application/octet-stream',
                'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: true }),
            },
            body: JSON.stringify(data),
        }));
        if (response.status === 401) return { status: 'unauthorized' };
        if (response.status === 409) return { status: 'conflict' };
        if (!response.ok) return { status: 'error', error: new Error('Failed to save to Dropbox') };
        const result = await response.json();
        return { status: 'ok', rev: result.rev };
    }

    // Downloads every entry file under one event's transaction folder in a
    // single Dropbox API call (files/download_zip) instead of listing the
    // folder and downloading each small file individually — the read cost
    // then stays flat regardless of how many transactions the event has
    // accumulated, up to Dropbox's own download_zip ceiling (folders under
    // 20GB / 10,000 entries). A 409 means the folder doesn't exist yet (a
    // brand new event, nobody has added anything), surfaced as 'not-found'
    // the same way fetchConfig does.
    async function fetchLedger(authFetch, getAccessToken, folderPath) {
        const response = await authFetch('https://content.dropboxapi.com/2/files/download_zip', () => ({
            method: 'POST',
            headers: {
                Authorization: `Bearer ${getAccessToken()}`,
                'Dropbox-API-Arg': JSON.stringify({ path: folderPath }),
            },
        }));
        if (response.status === 401) return { status: 'unauthorized' };
        if (response.status === 409) return { status: 'not-found' };
        if (!response.ok) return { status: 'error', error: new Error('Failed to download transaction entries') };
        const blob = await response.blob();
        const zip = await JSZip.loadAsync(blob);
        const files = Object.values(zip.files).filter((f) => !f.dir && f.name.endsWith('.json'));
        const entries = await Promise.all(files.map(async (file) => JSON.parse(await file.async('string'))));
        return { status: 'ok', entries };
    }

    // Writes one immutable ledger entry file. Always mode: 'add' — nothing
    // ever overwrites an existing entry file, so unlike saveConfig there is
    // no conflict to detect here.
    async function writeLedgerEntry(authFetch, getAccessToken, path, entry) {
        const response = await authFetch('https://content.dropboxapi.com/2/files/upload', () => ({
            method: 'POST',
            headers: {
                Authorization: `Bearer ${getAccessToken()}`,
                'Content-Type': 'application/octet-stream',
                'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: false, mute: true }),
            },
            body: JSON.stringify(entry),
        }));
        if (response.status === 401) return { status: 'unauthorized' };
        if (!response.ok) return { status: 'error', error: new Error('Failed to write transaction entry') };
        return { status: 'ok' };
    }

    const DropboxProvider = {
        id: 'dropbox',
        label: 'Dropbox',
        viewerScope: VIEWER_SCOPE,
        getAuthUrl,
        exchangeCodeForToken,
        refreshAccessToken,
        fetchConfig,
        saveConfig,
        fetchLedger,
        writeLedgerEntry,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DropboxProvider;
    } else {
        root.DropboxProvider = DropboxProvider;
    }
})(typeof window !== 'undefined' ? window : globalThis);
