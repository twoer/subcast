/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'server/**/__tests__/**/*.test.ts',
      'desktop/**/__tests__/**/*.test.ts',
    ],
  },
});
