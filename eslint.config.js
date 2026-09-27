const js = require('@eslint/js');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

// Names js/logic.js attaches to `window` (see the `api` object at the
// bottom of that file) when loaded as a plain <script> — js/app.js calls
// these as globals, not via require/import.
const logicGlobals = {
    escapeHtml: 'readonly',
    computeTotals: 'readonly',
    sortEntitiesByTotal: 'readonly',
    GENERAL_FUND_ID: 'readonly',
    isGeneralFundEntry: 'readonly',
    computeEventTotal: 'readonly',
    GENERAL_FUND_LABEL: 'readonly',
    resolveEntitySelection: 'readonly',
    resolveThemeColor: 'readonly',
    resolveLogoUrl: 'readonly',
    computeGaugeGeometry: 'readonly',
    isDuplicateName: 'readonly',
    isValidTransactionAmount: 'readonly',
    isAllowedMediaUrl: 'readonly',
    VIEWER_HASH: 'readonly',
    isViewerHash: 'readonly',
    KEYER_HASH: 'readonly',
    isKeyerHash: 'readonly',
    computeRetryDelay: 'readonly',
    runUpdateWithRetry: 'readonly',
    flushPendingQueue: 'readonly',
    collapseTransactionLedger: 'readonly',
    computeEditDelta: 'readonly',
    computeDeleteAmount: 'readonly',
    TICKER_HERO_MAX: 'readonly',
    TICKER_TWIN_MAX: 'readonly',
    TICKER_SPOTLIGHT_SIZE: 'readonly',
    TICKER_TV_FIELD_PAGE_SIZE: 'readonly',
    pickTickerTier: 'readonly',
    paginate: 'readonly',
};

// Names js/providers/dropbox.js attaches to `window` (its DropboxProvider
// object) — js/app.js references this as a global the same way it does
// logic.js's exports. A future second provider module would get its own
// entry here alongside this one.
const providerGlobals = {
    DropboxProvider: 'readonly',
};

module.exports = [
    js.configs.recommended,
    prettierConfig,
    {
        ignores: ['node_modules/**', 'css/tailwind.css'],
    },
    {
        // js/logic.js and js/providers/*.js: run in both the browser (plain
        // <script>) and Node (require()'d by the test suite) — see the
        // module.exports guard at the bottom of each file.
        files: ['js/logic.js', 'js/providers/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...globals.node,
                JSZip: 'readonly',
            },
        },
    },
    {
        // js/app.js: browser-only, loaded via <script src="js/app.js"> after
        // js/logic.js and the provider modules. Not require()'d anywhere,
        // so no Node globals needed.
        files: ['js/app.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...logicGlobals,
                ...providerGlobals,
                JSZip: 'readonly',
            },
        },
    },
    {
        files: ['test/**/*.js', 'eslint.config.js', 'tailwind.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
    },
];
