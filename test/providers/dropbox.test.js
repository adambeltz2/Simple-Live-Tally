const test = require('node:test');
const assert = require('node:assert/strict');
const JSZipNode = require('jszip');
const DropboxProvider = require('../../js/providers/dropbox.js');

// fetchConfig/saveConfig/fetchLedger/writeLedgerEntry take authFetch as a
// parameter rather than calling the global fetch directly (see
// js/providers/dropbox.js), so these tests hand each one a stub authFetch
// instead of mocking global fetch — a direct benefit of that boundary.
function stubAuthFetch(response) {
    return async (url, buildOptions) => {
        stubAuthFetch.lastUrl = url;
        stubAuthFetch.lastOptions = buildOptions();
        return response;
    };
}

test('DropboxProvider.getAuthUrl', async (t) => {
    await t.test('builds the base authorize URL with PKCE params and no scope by default', () => {
        const url = DropboxProvider.getAuthUrl({
            clientId: 'client123',
            codeChallenge: 'challenge456',
            redirectUri: 'https://example.github.io/app/',
        });
        assert.match(url, /^https:\/\/www\.dropbox\.com\/oauth2\/authorize\?/);
        assert.match(url, /client_id=client123/);
        assert.match(url, /response_type=code/);
        assert.match(url, /code_challenge=challenge456/);
        assert.match(url, /code_challenge_method=S256/);
        assert.match(url, /redirect_uri=https%3A%2F%2Fexample.github.io%2Fapp%2F/);
        assert.match(url, /token_access_type=offline/);
        assert.doesNotMatch(url, /[?&]scope=/);
    });

    await t.test('appends an encoded scope parameter when one is given', () => {
        const url = DropboxProvider.getAuthUrl({
            clientId: 'client123',
            codeChallenge: 'challenge456',
            redirectUri: 'https://example.github.io/app/',
            scope: DropboxProvider.viewerScope,
        });
        assert.match(
            url,
            /scope=account_info\.read%20files\.metadata\.read%20files\.content\.read/,
            'the scope list should be present and space-encoded',
        );
    });
});

test('DropboxProvider.exchangeCodeForToken', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => {
        global.fetch = originalFetch;
    });

    await t.test('posts the authorization code and returns the token pair', async () => {
        let capturedUrl, capturedBody;
        global.fetch = async (url, options) => {
            capturedUrl = url;
            capturedBody = options.body;
            return { json: async () => ({ access_token: 'tok', refresh_token: 'rtok' }) };
        };

        const result = await DropboxProvider.exchangeCodeForToken({
            clientId: 'client123',
            code: 'authcode',
            redirectUri: 'https://example.github.io/app/',
            codeVerifier: 'verifier',
        });

        assert.equal(capturedUrl, 'https://api.dropboxapi.com/oauth2/token');
        assert.match(capturedBody.toString(), /grant_type=authorization_code/);
        assert.match(capturedBody.toString(), /code=authcode/);
        assert.deepEqual(result, { accessToken: 'tok', refreshToken: 'rtok' });
    });

    await t.test('returns null when Dropbox does not hand back an access_token', async () => {
        global.fetch = async () => ({ json: async () => ({ error: 'invalid_grant' }) });
        const result = await DropboxProvider.exchangeCodeForToken({
            clientId: 'client123',
            code: 'bad',
            redirectUri: 'https://example.github.io/app/',
            codeVerifier: 'verifier',
        });
        assert.equal(result, null);
    });

    await t.test('a refresh_token-less response still returns the access token', async () => {
        global.fetch = async () => ({ json: async () => ({ access_token: 'tok' }) });
        const result = await DropboxProvider.exchangeCodeForToken({
            clientId: 'client123',
            code: 'authcode',
            redirectUri: 'https://example.github.io/app/',
            codeVerifier: 'verifier',
        });
        assert.deepEqual(result, { accessToken: 'tok', refreshToken: null });
    });
});

test('DropboxProvider.refreshAccessToken', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => {
        global.fetch = originalFetch;
    });

    await t.test('exchanges the refresh token for a fresh access token', async () => {
        let capturedBody;
        global.fetch = async (url, options) => {
            capturedBody = options.body;
            return { ok: true, json: async () => ({ access_token: 'newtok' }) };
        };
        const result = await DropboxProvider.refreshAccessToken({ clientId: 'client123', refreshToken: 'rtok' });
        assert.match(capturedBody.toString(), /grant_type=refresh_token/);
        assert.match(capturedBody.toString(), /refresh_token=rtok/);
        assert.deepEqual(result, { accessToken: 'newtok' });
    });

    await t.test('returns null on a non-ok response', async () => {
        global.fetch = async () => ({ ok: false });
        const result = await DropboxProvider.refreshAccessToken({ clientId: 'client123', refreshToken: 'rtok' });
        assert.equal(result, null);
    });
});

test('DropboxProvider.fetchAccountInfo', async (t) => {
    await t.test('maps a successful lookup to { status: "ok", email }', async () => {
        const authFetch = stubAuthFetch({
            status: 200,
            ok: true,
            json: async () => ({ account_id: 'abc', email: 'organizer@example.com' }),
        });
        const result = await DropboxProvider.fetchAccountInfo(authFetch, () => 'tok');
        assert.deepEqual(result, { status: 'ok', email: 'organizer@example.com' });
        assert.equal(stubAuthFetch.lastUrl, 'https://api.dropboxapi.com/2/users/get_current_account');
        assert.equal(stubAuthFetch.lastOptions.headers.Authorization, 'Bearer tok');
    });

    await t.test('maps a 401 to unauthorized and any other failure to a generic error', async () => {
        const unauthorized = await DropboxProvider.fetchAccountInfo(stubAuthFetch({ status: 401 }), () => 'tok');
        assert.deepEqual(unauthorized, { status: 'unauthorized' });

        const result = await DropboxProvider.fetchAccountInfo(stubAuthFetch({ status: 500, ok: false }), () => 'tok');
        assert.equal(result.status, 'error');
        assert.ok(result.error instanceof Error);
    });
});

test('DropboxProvider.fetchConfig', async (t) => {
    await t.test('maps a successful download to { status: "ok", data, rev }', async () => {
        const authFetch = stubAuthFetch({
            status: 200,
            ok: true,
            headers: { get: () => JSON.stringify({ rev: 'rev1' }) },
            json: async () => ({ settings: {} }),
        });
        const result = await DropboxProvider.fetchConfig(authFetch, () => 'tok', '/data.json');
        assert.deepEqual(result, { status: 'ok', data: { settings: {} }, rev: 'rev1' });
    });

    await t.test('maps a 401 to unauthorized and a 409 to not-found', async () => {
        const unauthorized = await DropboxProvider.fetchConfig(
            stubAuthFetch({ status: 401 }),
            () => 'tok',
            '/data.json',
        );
        assert.deepEqual(unauthorized, { status: 'unauthorized' });

        const notFound = await DropboxProvider.fetchConfig(stubAuthFetch({ status: 409 }), () => 'tok', '/data.json');
        assert.deepEqual(notFound, { status: 'not-found' });
    });

    await t.test('maps any other non-ok status to a generic error', async () => {
        const result = await DropboxProvider.fetchConfig(
            stubAuthFetch({ status: 500, ok: false }),
            () => 'tok',
            '/data.json',
        );
        assert.equal(result.status, 'error');
        assert.ok(result.error instanceof Error);
    });

    await t.test('reads the current access token fresh via the getter, not a snapshot', async () => {
        let seenToken;
        const authFetch = async (url, buildOptions) => {
            seenToken = buildOptions().headers.Authorization;
            return {
                status: 200,
                ok: true,
                headers: { get: () => JSON.stringify({ rev: 'r' }) },
                json: async () => ({}),
            };
        };
        let token = 'first';
        await DropboxProvider.fetchConfig(authFetch, () => token, '/data.json');
        assert.equal(seenToken, 'Bearer first');

        token = 'refreshed';
        await DropboxProvider.fetchConfig(authFetch, () => token, '/data.json');
        assert.equal(seenToken, 'Bearer refreshed');
    });
});

test('DropboxProvider.saveConfig', async (t) => {
    await t.test('uses mode "add" with no rev and returns the new rev on success', async () => {
        const authFetch = stubAuthFetch({ status: 200, ok: true, json: async () => ({ rev: 'rev2' }) });
        const result = await DropboxProvider.saveConfig(authFetch, () => 'tok', '/data.json', { a: 1 }, null);
        const arg = JSON.parse(stubAuthFetch.lastOptions.headers['Dropbox-API-Arg']);
        assert.equal(arg.mode, 'add');
        assert.deepEqual(result, { status: 'ok', rev: 'rev2' });
    });

    await t.test('uses a conditional update mode with an existing rev', async () => {
        const authFetch = stubAuthFetch({ status: 200, ok: true, json: async () => ({ rev: 'rev3' }) });
        await DropboxProvider.saveConfig(authFetch, () => 'tok', '/data.json', { a: 1 }, 'rev2');
        const arg = JSON.parse(stubAuthFetch.lastOptions.headers['Dropbox-API-Arg']);
        assert.deepEqual(arg.mode, { '.tag': 'update', update: 'rev2' });
    });

    await t.test('maps a 409 to conflict (not an error) and a 401 to unauthorized', async () => {
        const conflict = await DropboxProvider.saveConfig(
            stubAuthFetch({ status: 409 }),
            () => 'tok',
            '/data.json',
            {},
            'rev1',
        );
        assert.deepEqual(conflict, { status: 'conflict' });

        const unauthorized = await DropboxProvider.saveConfig(
            stubAuthFetch({ status: 401 }),
            () => 'tok',
            '/data.json',
            {},
            'rev1',
        );
        assert.deepEqual(unauthorized, { status: 'unauthorized' });
    });
});

test('DropboxProvider.fetchLedger', async (t) => {
    const originalJSZip = global.JSZip;
    t.after(() => {
        global.JSZip = originalJSZip;
    });
    global.JSZip = JSZipNode;

    await t.test('unzips every .json entry file into the ledger entry list', async () => {
        const zip = new JSZipNode();
        zip.file('t1.json', JSON.stringify({ id: 't1', amount: 10 }));
        zip.file('t2.json', JSON.stringify({ id: 't2', amount: 20 }));
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });

        const authFetch = stubAuthFetch({ status: 200, ok: true, blob: async () => buffer });
        const result = await DropboxProvider.fetchLedger(authFetch, () => 'tok', '/transactions/evt1');

        assert.equal(result.status, 'ok');
        assert.equal(result.entries.length, 2);
        assert.deepEqual(result.entries.map((e) => e.id).sort(), ['t1', 't2']);
    });

    await t.test('maps a 409 (no folder yet) to not-found rather than an error', async () => {
        const result = await DropboxProvider.fetchLedger(
            stubAuthFetch({ status: 409 }),
            () => 'tok',
            '/transactions/evt1',
        );
        assert.deepEqual(result, { status: 'not-found' });
    });
});

test('DropboxProvider.writeLedgerEntry', async (t) => {
    await t.test('writes the entry and returns ok', async () => {
        const authFetch = stubAuthFetch({ status: 200, ok: true });
        const entry = { id: 't1', eventId: 'evt1', amount: 5 };
        const result = await DropboxProvider.writeLedgerEntry(
            authFetch,
            () => 'tok',
            '/transactions/evt1/t1.json',
            entry,
        );
        assert.deepEqual(result, { status: 'ok' });
        const arg = JSON.parse(stubAuthFetch.lastOptions.headers['Dropbox-API-Arg']);
        assert.equal(arg.path, '/transactions/evt1/t1.json');
        assert.equal(arg.mode, 'add');
        assert.equal(stubAuthFetch.lastOptions.body, JSON.stringify(entry));
    });

    await t.test('maps a 401 to unauthorized and any other failure to a generic error', async () => {
        const unauthorized = await DropboxProvider.writeLedgerEntry(
            stubAuthFetch({ status: 401 }),
            () => 'tok',
            '/transactions/evt1/t1.json',
            {},
        );
        assert.deepEqual(unauthorized, { status: 'unauthorized' });

        const errored = await DropboxProvider.writeLedgerEntry(
            stubAuthFetch({ status: 500, ok: false }),
            () => 'tok',
            '/transactions/evt1/t1.json',
            {},
        );
        assert.equal(errored.status, 'error');
        assert.ok(errored.error instanceof Error);
    });
});
