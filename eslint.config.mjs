import withNuxt from './.nuxt/eslint.config.mjs';

// Block naked `require()` in shipped code. The project is "type": "module",
// so desktop/server .js outputs run as ESM at runtime and `require` is not
// defined — but @types/node still types it as a global, so tsc happily
// compiles and the call only blows up after the app boots (see the
// stripQuarantine bootstrap crash that motivated this rule).
//
// For the rare legitimate CJS interop case, use `createRequire(import.meta.url)`
// — see desktop/diagnostics.ts for the canonical pattern.
//
// Tests are exempt because vi.hoisted() runs before ES module imports and
// can only use require() at that point; vitest provides require() in its
// CJS-style test harness regardless of "type": "module".
export default withNuxt({
  files: ['desktop/**/*.ts', 'server/**/*.ts'],
  ignores: ['**/__tests__/**', '**/*.test.ts'],
  rules: {
    '@typescript-eslint/no-require-imports': 'error',
  },
});
