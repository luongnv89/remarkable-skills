// Turn an extracted article model into a print HTML file and a device-sized PDF.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cssString, ensureDir, escapeHtml, fail, findChrome, formatDate, saveImage, wordCount } from './common.mjs';
import { loadDeps, makeDom } from './web.mjs';

// Screen-exact page sizes: pixels / dpi * 25.4. The 3:4 panels show a page edge to edge.
export const DEVICES = {
  rm2: { label: 'reMarkable 2', w: 157.8, h: 210.4, margin: '13mm 12mm 14mm 12mm', font: '11pt' },
  rmpp: { label: 'reMarkable Paper Pro', w: 179.7, h: 239.6, margin: '15mm 14mm 16mm 14mm', font: '11.5pt' },
  move: { label: 'reMarkable Paper Pro Move', w: 91.8, h: 163.2, margin: '9mm 7mm 10mm 7mm', font: '9.5pt' },
};

const DROP = 'script, style, noscript, form, button, input, select, textarea, object, embed, link, meta, template, dialog';
// Classes this skill itself adds (the X converter and the iframe/video replacements); every other class is dropped.
const OWN_CLASSES = new Set(['embed-post', 'post-meta', 'post-link', 'embed-link', 'missing-image', 'markdown', 'lead']);
const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'type', 'datetime', 'lang', 'dir', 'id', 'width', 'height', 'viewbox', 'd', 'xmlns', 'fill', 'stroke', 'points', 'x', 'y', 'r', 'cx', 'cy', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'transform']);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Clean the body, download images, number the links. Returns { html, images, notes, words }. */
export async function prepareBody(model, workDir, { notes: wantNotes = true } = {}) {
  await loadDeps();
  const imgDir = ensureDir(join(workDir, 'images'));
  const baseUrl = model.sourceUrl && !model.sourceUrl.startsWith('file:') ? model.sourceUrl : model.sourceUrl || 'about:blank';
  const dom = makeDom(`<!doctype html><body><div id="root">${model.bodyHtml || ''}</div></body>`, baseUrl);
  const doc = dom.window.document;
  const root = doc.getElementById('root');

  // Task-list checkboxes would vanish with the other form controls: keep them as glyphs.
  for (const box of root.querySelectorAll('input[type="checkbox"]')) box.replaceWith(doc.createTextNode(box.hasAttribute('checked') ? '☑ ' : '☐ '));
  // Footnote back-links (↩) mean nothing on paper.
  for (const a of root.querySelectorAll('a[role="doc-backlink"], a.footnote-back, a.reversefootnote, a.footnote-backref')) a.remove();
  for (const el of root.querySelectorAll(DROP)) el.remove();
  // The masthead already prints the title: drop a leading heading that repeats it.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const firstBlock = root.querySelector('h1, h2, h3, p, figure, ul, ol, pre, blockquote, table');
  if (firstBlock && /^H[1-3]$/.test(firstBlock.tagName)) {
    const h = norm(firstBlock.textContent);
    const t = norm(model.title);
    if (h && t && (h === t || (t.startsWith(h) && h.length >= t.length * 0.6))) firstBlock.remove();
  }
  // Iframes (videos, embeds) cannot play on paper: keep a visible pointer.
  for (const f of root.querySelectorAll('iframe')) {
    const src = f.getAttribute('src') || f.getAttribute('data-src') || '';
    const p = doc.createElement('p');
    p.className = 'embed-link';
    p.textContent = src ? `Embedded content: ${new URL(src, baseUrl).href}` : 'Embedded content (not printable)';
    f.replaceWith(p);
  }
  for (const v of root.querySelectorAll('video, audio')) {
    const frag = doc.createElement('figure');
    const poster = v.getAttribute('poster');
    if (poster) {
      const img = doc.createElement('img');
      img.setAttribute('src', poster);
      frag.append(img);
    }
    const cap = doc.createElement('figcaption');
    const src = v.getAttribute('src') || v.querySelector('source')?.getAttribute('src') || '';
    cap.textContent = `${v.tagName === 'VIDEO' ? 'Video' : 'Audio'}${src ? ': ' + new URL(src, baseUrl).href : ''}`;
    frag.append(cap);
    v.replaceWith(frag);
  }
  for (const pic of root.querySelectorAll('picture')) {
    const img = pic.querySelector('img');
    if (img && !img.getAttribute('src')) {
      const s = pic.querySelector('source[srcset]')?.getAttribute('srcset');
      if (s) img.setAttribute('srcset', s);
    }
    for (const s of pic.querySelectorAll('source')) s.remove();
  }
  for (const el of root.querySelectorAll('*')) {
    const own = (el.getAttribute('class') || '').split(/\s+/).filter((c) => OWN_CLASSES.has(c));
    for (const a of [...el.attributes]) if (!KEEP_ATTRS.has(a.name.toLowerCase())) el.removeAttribute(a.name);
    if (own.length) el.setAttribute('class', own.join(' '));
    if (el.tagName === 'A' && /^\s*javascript:/i.test(el.getAttribute('href') || '')) el.removeAttribute('href');
  }

  // Images: download everything so the PDF is self-contained.
  const imgs = [...root.querySelectorAll('img')];
  const tasks = [];
  for (const img of imgs) {
    const w = parseInt(img.getAttribute('width') || '0', 10);
    const h = parseInt(img.getAttribute('height') || '0', 10);
    if ((w && w <= 3) || (h && h <= 3)) {
      img.remove(); // tracking pixel
      continue;
    }
    let src = img.getAttribute('src') || '';
    if (!src && img.getAttribute('srcset')) src = img.getAttribute('srcset').split(',')[0].trim().split(/\s+/)[0];
    if (!src) {
      img.remove();
      continue;
    }
    const abs = src.startsWith('data:') || src.startsWith('/') && model.kind === 'file' ? src : new URL(src, baseUrl).href;
    img.removeAttribute('srcset');
    img.removeAttribute('width');
    img.removeAttribute('height');
    tasks.push({ img, src: abs });
  }
  if (model.coverUrl) tasks.unshift({ img: null, src: model.coverUrl, cover: true });
  const results = await pool(tasks, 6, (t, k) => saveImage(t.src, imgDir, `img-${String(k).padStart(3, '0')}`, { referer: baseUrl.startsWith('http') ? baseUrl : undefined }));
  const failed = [];
  let coverRel = null;
  results.forEach((r, k) => {
    const t = tasks[k];
    if (r.error) {
      failed.push({ src: t.src.slice(0, 200), error: r.error });
      if (t.img) {
        const p = doc.createElement('p');
        p.className = 'missing-image';
        p.textContent = `[Image not available${t.img.getAttribute('alt') ? ': ' + t.img.getAttribute('alt') : ''}]`;
        t.img.replaceWith(p);
      }
      return;
    }
    if (t.cover) coverRel = r.rel;
    else t.img.setAttribute('src', r.rel);
  });

  // Wrap bare images in figures so they never split across pages.
  for (const img of root.querySelectorAll('img')) {
    if (img.closest('figure')) continue;
    const parent = img.parentElement;
    const onlyChild = parent && parent !== root && parent.children.length === 1 && !parent.textContent.trim();
    const fig = doc.createElement('figure');
    (onlyChild ? parent : img).replaceWith(fig);
    fig.append(img);
  }

  // Links become numbered notes, because nothing on paper is clickable.
  const notes = [];
  if (wantNotes) {
    const index = new Map();
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.href || a.getAttribute('href');
      if (!/^(https?:|mailto:)/i.test(href)) continue;
      if (a.querySelector('img') && !a.textContent.trim()) continue;
      const text = a.textContent.trim().replace(/\/$/, '');
      const bare = href.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
      if (!text || text === href || text.replace(/^https?:\/\/(www\.)?/i, '') === bare) continue;
      let n = index.get(href);
      if (!n) {
        n = notes.push(href);
        index.set(href, n);
      }
      const sup = doc.createElement('sup');
      sup.className = 'ref';
      sup.textContent = String(n);
      a.after(sup);
    }
  }

  // A drop cap on the first real paragraph.
  const lead = [...root.querySelectorAll('p')].find((p) => p.textContent.trim().length > 120 && !p.closest('aside, blockquote, li, figure'));
  if (lead) lead.className = 'lead';

  // Readability marks the article container with ids; drop wrapper ids that could collide.
  for (const el of root.querySelectorAll('[id^="readability"]')) el.removeAttribute('id');

  return {
    html: root.innerHTML,
    coverRel,
    images: { found: tasks.length, saved: tasks.length - failed.length, failed },
    notes,
    words: wordCount(root.textContent),
  };
}

export function buildHtml(model, body, device, css) {
  const d = DEVICES[device];
  const minutes = Math.max(1, Math.round(body.words / 230));
  const date = formatDate(model.published);
  const shortTitle = model.title.length > 60 ? model.title.slice(0, 57).trimEnd() + '…' : model.title;
  const kickerLeft = model.kind === 'x-article' ? 'X Article' : model.kind === 'x-thread' ? 'X Thread' : model.siteName || '';
  const byline = [model.byline ? `By ${escapeHtml(model.byline)}` : '', `${minutes} min read`].filter(Boolean).join(' · ');
  const notes = body.notes.length
    ? `<section class="endnotes"><h2>Links</h2><ol>${body.notes.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ol></section>`
    : '';
  const source = model.sourceUrl && !model.sourceUrl.startsWith('file:') ? model.sourceUrl : (model.sourceUrl || '').replace(/^file:\/\//, '');
  const page = `@page { size: ${d.w}mm ${d.h}mm; margin: ${d.margin};
  @bottom-left { content: ${cssString(shortTitle)}; }
  @bottom-right { content: counter(page) " / " counter(pages); } }
@page :first { @bottom-left { content: none; } }
html { font-size: ${d.font}; }`;
  return `<!doctype html>
<html lang="${escapeHtml(model.lang || 'en')}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(model.title)}</title>
<style>
${page}
${css}
</style>
</head>
<body>
<header class="masthead">
  <div class="kicker"><span>${escapeHtml(kickerLeft)}</span><span>${escapeHtml(date)}</span></div>
  <h1 class="title">${escapeHtml(model.title)}</h1>
  ${model.excerpt && model.kind !== 'x-article' && model.excerpt.length < 300 && !body.html.includes(model.excerpt.slice(0, 60)) ? `<p class="dek">${escapeHtml(model.excerpt)}</p>` : ''}
  <p class="byline">${byline}</p>
</header>
${body.coverRel ? `<figure class="cover"><img src="${escapeHtml(body.coverRel)}" alt=""></figure>` : ''}
<main class="content">
${body.html}
</main>
${notes}
<footer class="colophon">Source: ${escapeHtml(source)}<br>Saved ${escapeHtml(formatDate(new Date()))} for ${escapeHtml(d.label)}</footer>
</body>
</html>
`;
}

export function printPdf(htmlPath, pdfPath) {
  const chrome = findChrome();
  if (!chrome)
    fail('no Chrome, Chromium, Edge or Brave found for PDF printing.', 'Install Google Chrome, or set CHROME_PATH to a Chromium-family browser binary.', 1);
  const profile = mkdtempSync(join(tmpdir(), 'str-chrome-'));
  try {
    const r = spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        // No --blink-settings=scriptEnabled=false: it silently stops headless printing. Scripts are stripped from the HTML instead.
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        '--generate-pdf-document-outline',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=20000',
        `--print-to-pdf=${pdfPath}`,
        'file://' + htmlPath,
      ],
      { encoding: 'utf8', timeout: 180000 },
    );
    if (!existsSync(pdfPath) || statSync(pdfPath).size < 1000) {
      fail(
        `Chrome did not produce a PDF (exit ${r.status}${r.signal ? ', ' + r.signal : ''}).`,
        `Open ${htmlPath} in Chrome to see whether the page renders; stderr: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`,
        1,
      );
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Page count and first MediaBox (points), read straight from the PDF bytes. */
export function inspectPdf(pdfPath) {
  const buf = readFileSync(pdfPath).toString('latin1');
  const pages = (buf.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const mb = buf.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const mm = mb ? [((+mb[3] - +mb[1]) * 25.4) / 72, ((+mb[4] - +mb[2]) * 25.4) / 72].map((x) => Math.round(x * 10) / 10) : null;
  return { pages, pageSizeMm: mm, bytes: Buffer.byteLength(buf, 'latin1') };
}

/** First-page PNG via macOS sips; returns the path or null. */
export function previewPng(pdfPath, outPng) {
  if (process.platform !== 'darwin') return null;
  try {
    execFileSync('sips', ['-s', 'format', 'png', '--resampleWidth', '900', pdfPath, '--out', outPng], { stdio: 'ignore' });
    return existsSync(outPng) ? outPng : null;
  } catch {
    return null;
  }
}

/** All pages side by side (needs poppler's pdftoppm + ImageMagick); returns the PNG path or null. */
export function contactSheet(pdfPath, workDir) {
  const tools = ['pdftoppm', 'magick'].every((t) => spawnSync('/usr/bin/env', ['which', t]).status === 0);
  if (!tools) return null;
  const dir = ensureDir(join(workDir, 'pages'));
  const out = join(workDir, 'sheet.png');
  try {
    execFileSync('pdftoppm', ['-png', '-r', '40', '-l', '24', pdfPath, join(dir, 'p')], { stdio: 'ignore' });
    const font = ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => existsSync(f));
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f));
    execFileSync('magick', ['montage', ...files, ...(font ? ['-font', font] : []), '-label', '', '-tile', '6x', '-geometry', '+6+6', '-background', '#777777', out], { stdio: 'ignore' });
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

export function writeHtml(workDir, html) {
  const p = join(workDir, 'article.html');
  writeFileSync(p, html);
  return p;
}
