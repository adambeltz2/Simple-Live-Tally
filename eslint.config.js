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
    computeBarPercentage: 'readonly',
    computeGaugeGeometry: 'readonly',
    isDuplicateName: 'readonly',
    isValidTransactionAmount: 'readonly',
    isAllowedMediaUrl: 'readonly',
    computeRetryDelay: 'readonly',
    runUpdateWithRetry: 'readonly',
    computeMaxVisibleRows: 'readonly',
    validateAppDataShape: 'readonly',
    parseAppDataJson: 'readonly',
};

module.exports = [
    js.configs.recommended,
    prettierConfig,
    {
        ignores: ['node_modules/**', 'css/tailwind.css'],
    },
    {
        // js/logic.js: runs in both the browser (plain <script>) and Node
        // (require()'d by the test suite) — see the module.exports guard
        // at the bottom of the file.
        files: ['js/logic.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
    },
    {
        // js/app.js: browser-only, loaded via <script src="js/app.js"> after
        // js/logic.js. Not require()'d anywhere, so no Node globals needed.
        files: ['js/app.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...logicGlobals,
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
