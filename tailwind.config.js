/** @type {import('tailwindcss').Config} */
module.exports = {
    // index.html for static markup, js/*.js for classes only ever referenced
    // inside JS template strings (badge colors, status-message classes, etc.)
    content: ['./index.html', './js/*.js'],
    darkMode: 'class',
    theme: { extend: {} },
};
