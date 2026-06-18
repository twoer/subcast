#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fetch ggml-base.bin into binaries/models/ so electron-builder can
 * bundle it via extraResources (decision: ship a default model in the
 * DMG so first launch is offline-usable).
 *
 * Idempotent: if a file with a plausible size already exists at the
 * destination, the script exits 0 without touching the network. Force
 * a re-download with `--force` or by deleting the file first.
 *
 * Mirror selection (priority order):
 *   1. CLI flag:  --mirror=hf-mirror|huggingface|modelscope
 *   2. Env var:   SUBCAST_GGML_MIRROR=<same>
 *   3. Default:   hf-mirror   (国内可达，免代理；上游内容与 HF 同步)
 *
 * Available mirrors:
 *   - hf-mirror   https://hf-mirror.com           — 国内推荐，HF 镜像
 *   - huggingface https://huggingface.co          — 上游原始
 *   - modelscope  https://modelscope.cn (Alibaba) — 国内自建，需独立账号路径
 *
 * On failure the script tries the next mirror in the chain
 * [chosen, ...others except chosen] so a temporary mirror outage
 * doesn't block the build.
 *
 * This is a build-host helper, not a release-time fetch — CI should
 * cache the file outside of the repo. The blob is ~148 MB.
 */

import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';

const REPO = process.cwd();
const DEST = join(REPO, 'binaries', 'models', 'ggml-base.bin');

// Size range from desktop/modelManager/whisperScan.ts MODEL_META.base.
const MIN_BYTES = 130 * 1024 * 1024;
const MAX_BYTES = 170 * 1024 * 1024;

/**
 * ModelScope hosts ggml whisper models under a different owner namespace
 * than HF (they're community-uploaded, not mirrored 1:1). We hit the
 * pengzhendong upload which has been kept current with ggerganov's
 * releases — if it ever falls behind, swap the owner to whoever is
 * actively syncing. ModelScope's path format uses `resolve/master/`.
 */
const MIRRORS = {
  'hf-mirror':   'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'huggingface': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'modelscope':  'https://www.modelscope.cn/models/pengzhendong/whisper.cpp/resolve/master/ggml-base.bin',
};

function parseMirrorArg() {
  const flag = process.argv.find((a) => a.startsWith('--mirror='));
  if (flag) return flag.slice('--mirror='.length);
  if (process.env.SUBCAST_GGML_MIRROR) return process.env.SUBCAST_GGML_MIRROR;
  // Back-compat: the legacy SUBCAST_HF_MIRROR=hf-mirror toggle still works.
  if (process.env.SUBCAST_HF_MIRROR === 'hf-mirror') return 'hf-mirror';
  return 'hf-mirror';
}

const PRIMARY = parseMirrorArg();
if (!(PRIMARY in MIRRORS)) {
  console.error(
    `[fetch-ggml-base] unknown mirror '${PRIMARY}'. Choose one of: ${Object.keys(MIRRORS).join(', ')}`,
  );
  process.exit(1);
}

// Fallback chain: chosen first, then the rest in declaration order.
const URLS = [
  MIRRORS[PRIMARY],
  ...Object.entries(MIRRORS)
    .filter(([k]) => k !== PRIMARY)
    .map(([, v]) => v),
];

const FORCE = process.argv.includes('--force');

function hasPlausibleFile(path) {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  return size >= MIN_BYTES && size <= MAX_BYTES;
}

if (!FORCE && hasPlausibleFile(DEST)) {
  const size = statSync(DEST).size;
  console.log(
    `[fetch-ggml-base] already present (${(size / 1024 / 1024).toFixed(1)} MB) at ${DEST} — skipping. Pass --force to re-download.`,
  );
  process.exit(0);
}

await mkdir(dirname(DEST), { recursive: true });

const tmp = `${DEST}.partial`;

async function tryDownload(url) {
  await rm(tmp, { force: true });
  console.log(`[fetch-ggml-base] downloading from ${url}`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, reason: `fetch error: ${err.message}` };
  }
  if (!res.ok || !res.body) {
    return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
  }

  const total = Number(res.headers.get('content-length') ?? 0);
  let downloaded = 0;
  let lastLog = 0;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastLog > 1_000) {
      lastLog = now;
      const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?';
      process.stdout.write(
        `\r[fetch-ggml-base] ${(downloaded / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)` : ''}`,
      );
    }
  });

  try {
    await pipeline(body, createWriteStream(tmp));
  } catch (err) {
    process.stdout.write('\n');
    await rm(tmp, { force: true });
    return { ok: false, reason: `stream error: ${err.message}` };
  }
  process.stdout.write('\n');

  if (!hasPlausibleFile(tmp)) {
    const size = existsSync(tmp) ? statSync(tmp).size : 0;
    await rm(tmp, { force: true });
    return {
      ok: false,
      reason: `size ${size}B outside expected [${MIN_BYTES}, ${MAX_BYTES}] — likely an HTML error page or partial`,
    };
  }
  return { ok: true };
}

let success = false;
for (const url of URLS) {
  const result = await tryDownload(url);
  if (result.ok) {
    success = true;
    break;
  }
  console.warn(`[fetch-ggml-base] ${url} failed: ${result.reason}`);
}

if (!success) {
  console.error(
    `[fetch-ggml-base] all mirrors failed. Try setting a proxy (HTTPS_PROXY) or pick one explicitly with --mirror=<name>.`,
  );
  process.exit(1);
}

await rename(tmp, DEST);
console.log(`[fetch-ggml-base] saved to ${DEST}`);
