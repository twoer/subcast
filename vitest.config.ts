/* SPDX-License-Identifier: Apache-2.0 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the Nuxt `#shared/*` alias so server-side modules under
      // test that import from `#shared/...` resolve under vitest too.
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'server/**/__tests__/**/*.test.ts',
      'desktop/**/__tests__/**/*.test.ts',
      'app/**/__tests__/**/*.test.ts',
    ],
  },
});
