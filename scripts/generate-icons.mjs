/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Generates assets/icon.icns (macOS) + assets/icon.ico (Windows) from
 * public/favicon.svg. Output is consumed by electron-builder via
 * electron-builder.config.json5.
 *
 * Pipeline: SVG → 1024×1024 PNG (sharp) → .icns / .ico (png2icons).
 * png2icons is pure JS — no native build step.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import png2icons from 'png2icons';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SVG_IN = join(root, 'public', 'favicon.svg');
const OUT_DIR = join(root, 'assets');
const PNG_OUT = join(OUT_DIR, 'icon.png');
const ICNS_OUT = join(OUT_DIR, 'icon.icns');
const ICO_OUT = join(OUT_DIR, 'icon.ico');
const TRAY_DIR = join(OUT_DIR, 'tray');
const TRAY_SVG_TEMPLATE = join(TRAY_DIR, 'trayTemplate.svg'); // silhouette for macOS template render
const TRAY_1X = join(TRAY_DIR, 'trayTemplate.png');     // 22×22 — macOS @1x
const TRAY_2X = join(TRAY_DIR, 'trayTemplate@2x.png'); // 44×44 — macOS @2x
const TRAY_WIN = join(TRAY_DIR, 'tray-win.png');        // 32×32 — Windows

await mkdir(OUT_DIR, { recursive: true });
await mkdir(TRAY_DIR, { recursive: true });

const svg = await readFile(SVG_IN);
const pngBuffer = await sharp(svg, { density: 384 })
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
await writeFile(PNG_OUT, pngBuffer);

const icns = png2icons.createICNS(pngBuffer, png2icons.BILINEAR, 0);
if (!icns) throw new Error('createICNS returned null');
await writeFile(ICNS_OUT, icns);

const ico = png2icons.createICO(pngBuffer, png2icons.BILINEAR, 0, false);
if (!ico) throw new Error('createICO returned null');
await writeFile(ICO_OUT, ico);

// macOS tray PNGs render in template mode (filename ends in
// "Template") — only the alpha channel matters, RGB is discarded and
// auto-tinted by the system. favicon.svg has a fully-opaque gradient
// background, so reusing it produced a solid tinted rectangle in the
// menu bar. We now source the macOS variants from a dedicated
// transparent-background silhouette SVG; Windows keeps the colorful
// favicon since it doesn't apply template tinting.
const traySvg = await readFile(TRAY_SVG_TEMPLATE);
const tray1x = await sharp(traySvg, { density: 96 })
  .resize(22, 22, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
const tray2x = await sharp(traySvg, { density: 192 })
  .resize(44, 44, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
const trayWin = await sharp(svg, { density: 128 })
  .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
await writeFile(TRAY_1X, tray1x);
await writeFile(TRAY_2X, tray2x);
await writeFile(TRAY_WIN, trayWin);

console.log('wrote:');
console.log(' ', PNG_OUT, `(${pngBuffer.length} bytes)`);
console.log(' ', ICNS_OUT, `(${icns.length} bytes)`);
console.log(' ', ICO_OUT, `(${ico.length} bytes)`);
console.log(' ', TRAY_1X, `(${tray1x.length} bytes)`);
console.log(' ', TRAY_2X, `(${tray2x.length} bytes)`);
console.log(' ', TRAY_WIN, `(${trayWin.length} bytes)`);
