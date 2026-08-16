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
export default withNuxt(
  {
    // 文档站（website/）是独立 VitePress 工程：dev 依赖预构建缓存与构建
    // 产物里的第三方压缩 JS 不属于本仓库 lint 范围，不忽略会报出几百
    // 个与源码无关的错误。
    ignores: [
      'website/.vitepress/cache/**',
      'website/.vitepress/dist/**',
      'website/node_modules/**',
    ],
  },
  {
    files: ['desktop/**/*.ts', 'server/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
);
