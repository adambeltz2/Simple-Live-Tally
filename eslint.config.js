const js = require('@eslint/js');
const html = require('eslint-plugin-html');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

// Names js/logic.js attaches to `window` (see the `api` object at the
// bottom of that file) when loaded as a plain <script> — index.html's
// inline script calls these as globals, not via require/import.
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
        files: ['test/**/*.js', 'eslint.config.js', 'tailwind.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['index.html'],
        plugins: { html },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...logicGlobals,
                JSZip: 'readonly',
            },
        },
        rules: {
            // Most top-level functions here are only ever called from an
            // onclick="..." attribute, which eslint-plugin-html can't see as
            // a usage (it only lints <script> contents, not attribute
            // strings) — so no-unused-vars would flag the entire public
            // surface of the app as dead code. Revisit once the
            // onclick -> addEventListener backlog item lands, since actual
            // callback references would make this rule meaningful again.
            'no-unused-vars': 'off',
        },
    },
];
