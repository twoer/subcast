#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Idempotently prepend SPDX license headers to first-party source files.
 *
 * - .ts / .mjs / .js → block comment header
 * - .vue            → HTML comment header (before any <template>/<script>)
 *
 * Skipped:
 * - node_modules, .nuxt, .output, dist*, .git
 * - app/components/ui/** + app/lib/utils.ts (shadcn-generated, upstream MIT)
 *
 * Re-running is safe: files already containing "SPDX-License-Identifier"
 * are left untouched.
 */

import { glob, readFile, writeFile } from 'node:fs/promises';

const TS_HEADER = '/* SPDX-License-Identifier: Apache-2.0 */';
const VUE_HEADER = '<!-- SPDX-License-Identifier: Apache-2.0 -->';

const INCLUDE = [
  'app/**/*.ts',
  'app/**/*.vue',
  'server/**/*.ts',
  'desktop/**/*.ts',
  'scripts/**/*.mjs',
];

const SKIP_PREFIXES = [
  'node_modules/',
  '.nuxt/',
  '.output/',
  'dist',          // dist, dist-electron, ...
  '.git/',
  'app/components/ui/',
  'app/lib/utils.ts',
  '.subcast/',
];

function shouldSkip(path) {
  return SKIP_PREFIXES.some((p) => path.startsWith(p) || path.includes('/' + p));
}

async function processFile(path) {
  if (shouldSkip(path)) return 'skipped';
  const content = await readFile(path, 'utf-8');
  if (content.includes('SPDX-License-Identifier')) return 'already';
  const isVue = path.endsWith('.vue');
  const header = isVue ? VUE_HEADER : TS_HEADER;
  await writeFile(path, header + '\n' + content);
  return 'added';
}

async function main() {
  const counts = { added: 0, already: 0, skipped: 0 };
  for (const pattern of INCLUDE) {
    for await (const path of glob(pattern)) {
      const result = await processFile(path);
      counts[result]++;
      if (result === 'added') console.log('+', path);
    }
  }
  console.log(
    `\nDone — added: ${counts.added}, already had: ${counts.already}, skipped: ${counts.skipped}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
