import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../../utils/db';

interface CacheEntry {
  sha256: string;
  originalName: string;
  displayName: string | null;
  ext: string;
  videoBytes: number;
  cacheBytes: number;
  langs: string[];
  createdAt: number;
  lastOpenedAt: number;
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile()) total += st.size;
      else if (st.isDirectory()) total += dirSize(p);
    } catch {
      /* ignore */
    }
  }
  return total;
}

export default defineEventHandler(() => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT sha256, original_name, display_name, ext, size_bytes, created_at, last_opened_at
       FROM videos ORDER BY last_opened_at DESC`,
    )
    .all() as Array<{
      sha256: string;
      original_name: string;
      display_name: string | null;
      ext: string;
      size_bytes: number;
      created_at: number;
      last_opened_at: number;
    }>;

  const subRows = db
    .prepare(
      `SELECT video_sha, GROUP_CONCAT(lang, ',') AS langs
       FROM subtitles GROUP BY video_sha`,
    )
    .all() as Array<{ video_sha: string; langs: string }>;
  const langsBySha = new Map(subRows.map((r) => [r.video_sha, r.langs.split(',')]));

  const items: CacheEntry[] = [];
  let totalBytes = 0;
  let totalVideoBytes = 0;
  for (const r of rows) {
    const videoPath = join(SUBCAST_PATHS.videos, `${r.sha256}${r.ext}`);
    const cacheDir = join(SUBCAST_PATHS.cache, r.sha256);
    const videoBytes = existsSync(videoPath) ? statSync(videoPath).size : 0;
    const cacheBytes = dirSize(cacheDir);
    const langs = langsBySha.get(r.sha256) ?? [];
    items.push({
      sha256: r.sha256,
      originalName: r.original_name,
      displayName: r.display_name,
      ext: r.ext,
      videoBytes,
      cacheBytes,
      langs,
      createdAt: r.created_at,
      lastOpenedAt: r.last_opened_at,
    });
    totalBytes += videoBytes + cacheBytes;
    totalVideoBytes += videoBytes;
  }
  return {
    items,
    totals: {
      bytes: totalBytes,
      videoBytes: totalVideoBytes,
      cacheBytes: totalBytes - totalVideoBytes,
      count: items.length,
    },
  };
});
