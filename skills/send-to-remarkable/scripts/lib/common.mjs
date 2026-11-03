// Shared helpers: errors, HTTP, image download, file-system and tool lookup.
import { existsSync, mkdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';

export const UA_BOT = 'send-to-remarkable/1.0 (personal reader; +https://github.com/mozilla/readability)';
export const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/** Print a three-part error (what failed, which input, how to fix) and exit. */
export function fail(what, fix, code = 1) {
  process.stderr.write(`Error: ${what}\n`);
  if (fix) process.stderr.write(`Fix: ${fix}\n`);
  process.exit(code);
}

export function warnLine(msg) {
  process.stderr.write(`Warning: ${msg}\n`);
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CSS string literal for use in `content: "..."`. */
export function cssString(s) {
  return '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
}

export function slugify(s, max = 60) {
  const slug = String(s || 'article')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'article';
}

export function expandHome(p) {
  return p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export async function fetchWithTimeout(url, { timeoutMs = 30000, headers = {}, ...rest } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers, ...rest });
  } finally {
    clearTimeout(t);
  }
}

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
};

/** Largest candidate from a srcset string, capped at maxW when widths are given. */
export function pickFromSrcset(srcset, maxW = 2000) {
  if (!srcset) return null;
  const items = srcset
    .split(/,\s+(?=\S)/)
    .map((part) => {
      const [u, d] = part.trim().split(/\s+/);
      const w = d && d.endsWith('w') ? parseInt(d, 10) : d && d.endsWith('x') ? parseFloat(d) * 1000 : 0;
      return { u, w: Number.isFinite(w) ? w : 0 };
    })
    .filter((x) => x.u);
  if (!items.length) return null;
  const capped = items.filter((x) => x.w <= maxW);
  const pool = capped.length ? capped : items;
  pool.sort((a, b) => b.w - a.w);
  return pool[0].u;
}

/**
 * Download an image (http/https/data URL or local path) into dir.
 * Returns { file, rel } on success or { error } on failure. Never throws.
 */
export async function saveImage(src, dir, baseName, { referer } = {}) {
  try {
    if (!src) return { error: 'empty src' };
    if (src.startsWith('data:')) {
      const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!m) return { error: 'bad data URL' };
      const type = (m[1] || 'image/png').toLowerCase();
      const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
      if (buf.length < 200 && type !== 'image/svg+xml') return { error: 'tiny inline image (placeholder)' };
      const file = join(dir, baseName + (EXT_BY_TYPE[type] || '.png'));
      writeFileSync(file, buf);
      return finishImage(file);
    }
    if (/^https?:\/\//i.test(src)) {
      const headers = { 'User-Agent': UA_BROWSER, Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' };
      if (referer) headers.Referer = referer;
      const res = await fetchWithTimeout(src, { timeoutMs: 30000, headers });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type && !type.startsWith('image/')) return { error: `not an image (${type})` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) return { error: 'image larger than 30 MB' };
      let ext = EXT_BY_TYPE[type] || extname(new URL(src).pathname).toLowerCase() || '.jpg';
      if (!/^\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)$/.test(ext)) ext = '.jpg';
      const file = join(dir, baseName + ext);
      writeFileSync(file, buf);
      return finishImage(file);
    }
    // Local file path (absolute or file:// URL)
    const p = src.startsWith('file://') ? decodeURIComponent(new URL(src).pathname) : src;
    if (!existsSync(p)) return { error: `file not found: ${p}` };
    const file = join(dir, baseName + (extname(p).toLowerCase() || '.png'));
    copyFileSync(p, file);
    return finishImage(file);
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out after 30 s' : e.message };
  }
}

/** Shrink oversized raster images with macOS `sips` so PDFs stay small. */
function finishImage(file) {
  const ext = extname(file).toLowerCase();
  if (/^\.(jpe?g|png)$/.test(ext) && process.platform === 'darwin') {
    try {
      const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
      const w = parseInt((out.match(/pixelWidth:\s*(\d+)/) || [])[1] || '0', 10);
      const h = parseInt((out.match(/pixelHeight:\s*(\d+)/) || [])[1] || '0', 10);
      if (Math.max(w, h) > 1800) execFileSync('sips', ['-Z', '1800', file], { stdio: 'ignore' });
    } catch {
      /* keep the original if sips fails */
    }
  }
  const size = statSync(file).size;
  return { file, rel: 'images/' + file.split('/').pop(), size };
}

export function which(cmd) {
  const r = spawnSync('/usr/bin/env', ['which', cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Locate a Chromium-family browser for headless printing. */
export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const p = which(c);
    if (p) return p;
  }
  return null;
}

export function wordCount(text) {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

export function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
