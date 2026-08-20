import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The bans below are not style preferences — they are the mechanical half of
 * CONVE-13 ("domain stays pure"). Time and randomness must arrive through the
 * Clock and Random ports, or behaviour becomes untestable and time-dependent.
 */
const PURE_LAYERS = ['src/modules/*/domain/**/*.ts', 'src/modules/*/use-cases/**/*.ts']

export default tseslint.config(
  { ignores: ['node_modules/**', '.wrangler/**', 'dist/**', 'coverage/**', 'worker-configuration.d.ts'] },
  // Tooling config files run in Node, not in workerd.
  {
    files: ['*.cjs', '*.config.js', '*.config.ts'],
    languageOptions: { globals: { module: 'writable', require: 'readonly', __dirname: 'readonly', process: 'readonly' } },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Stray console.log in production code is noise. The ONE legitimate
      // writer to stdout is the console notifier, which disables this rule
      // inline at the exact line — so the exemption is visible, not blanket.
      'no-console': 'error',
    },
  },
  {
    files: PURE_LAYERS,
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Take a Clock port. Domain code cannot read the wall clock (CONVE-13).' },
        { name: 'crypto', message: 'Take a Random or CodeHasher port (CONVE-13).' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Take a Random port (CONVE-13).' },
        { object: 'Date', property: 'now', message: 'Take a Clock port (CONVE-13).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['hono', 'hono/*'], message: 'Domain and use-cases are framework-free (CONVE-13).' },
            { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Persistence belongs in adapters (CONVE-13).' },
            { group: ['better-auth', 'better-auth/*'], message: 'better-auth is confined to modules/identity adapters (CONVE-15).' },
            { group: ['cloudflare:*'], message: 'Cloudflare primitives live behind ports (CONVE-15).' },
            { group: ['@/platform/*'], message: 'Only adapters may reach platform.' },
          ],
        },
      ],
    },
  },
)
