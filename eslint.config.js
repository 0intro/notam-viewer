import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['*.test.js'] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				L: 'readonly',
				html2canvas: 'readonly',
				jsPDF: 'readonly'
			}
		},
		rules: {
			'indent': ['error', 'tab'],
			'linebreak-style': ['error', 'unix'],
			'quotes': ['error', 'single', { avoidEscape: true }],
			'semi': ['error', 'always'],
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
			'no-console': 'off'
		}
	}
];
