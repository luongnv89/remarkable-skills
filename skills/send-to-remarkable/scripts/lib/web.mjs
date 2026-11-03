// Web source: fetch a page, extract the article with Mozilla Readability, clean it for print.
// JS-heavy pages are re-read from headless Chrome's rendered DOM (--dump-dom).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, fetchWithTimeout, findChrome, pickFromSrcset, UA_BROWSER, wordCount } from './common.mjs';

let JSDOM, Readability;
export async function loadDeps() {
  if (JSDOM) return;
  try {
    ({ JSDOM } = await import('jsdom'));
    ({ Readability } = await import('@mozilla/readability'));
  } catch {
    fail(
      'the Node packages jsdom and @mozilla/readability are not installed.',
      `Run: cd "${new URL('..', import.meta.url).pathname}" && npm ci`,
      1,
    );
  }
}

export function makeDom(html, url) {
  return new JSDOM(html, { url });
}

function dumpDom(url) {
  const chrome = findChrome();
  if (!chrome) return null;
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
        `--user-data-dir=${profile}`,
        `--user-agent=${UA_BROWSER}`,
        '--virtual-time-budget=15000',
        '--dump-dom',
        url,
      ],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
    );
    return r.status === 0 && r.stdout ? r.stdout : null;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

function meta(doc, ...names) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute('content');
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/** Run Readability on a DOM; returns null when nothing article-like was found. */
export function extract(dom) {
  const doc = dom.window.document;
  const pageMeta = {
    ogImage: meta(doc, 'og:image', 'twitter:image', 'twitter:image:src'),
    published: meta(doc, 'article:published_time', 'datePublished', 'pubdate', 'date', 'dc.date'),
    canonical: doc.querySelector('link[rel="canonical"]')?.href || '',
    lang: doc.documentElement.getAttribute('lang') || '',
  };
  // Readability mutates its input, so work on a clone.
  const clone = doc.cloneNode(true);
  // Lazy-loaded images often keep their real URL in data-* attributes.
  for (const img of clone.querySelectorAll('img')) {
    const real =
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original') ||
      pickFromSrcset(img.getAttribute('data-srcset')) ||
      pickFromSrcset(img.getAttribute('srcset'));
    if (real && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) img.setAttribute('src', real);
  }
  const art = new Readability(clone, { charThreshold: 300, keepClasses: false }).parse();
  if (!art || !art.content) return null;
  return { art, pageMeta, words: wordCount(art.textContent) };
}

export async function fromWeb(url, { render = false } = {}) {
  await loadDeps();
  const warnings = [];
  let html = null;
  let finalUrl = url;
  let contentType = '';
  if (!render) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        timeoutMs: 30000,
        headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' },
      });
    } catch (e) {
      fail(`could not download ${url} (${e.name === 'AbortError' ? 'timed out after 30 s' : e.message}).`, 'Check the URL and the network, or retry with --render to load it in headless Chrome.', 1);
    }
    finalUrl = res.url || url;
    contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/pdf')) {
      return { kind: 'pdf', pdfBytes: Buffer.from(await res.arrayBuffer()), sourceUrl: finalUrl, warnings };
    }
    if (!res.ok && res.status !== 403 && res.status !== 401) {
      fail(`${url} answered HTTP ${res.status}.`, 'Check the link in a browser. If it opens there, retry with --render.', 1);
    }
    if (res.ok) html = await res.text();
    else warnings.push(`plain download was refused (HTTP ${res.status}); used headless Chrome instead`);
  }

  let result = html ? extract(makeDom(html, finalUrl)) : null;
  let method = 'download';
  if (!result || result.words < 150) {
    const rendered = dumpDom(finalUrl);
    if (rendered) {
      const second = extract(makeDom(rendered, finalUrl));
      if (second && (!result || second.words > result.words)) {
        result = second;
        method = 'headless Chrome';
      }
    } else if (!findChrome()) {
      warnings.push('Chrome not found, so the page could not be rendered with JavaScript');
    }
  }
  if (!result) {
    fail(
      `no article text found at ${finalUrl}.`,
      'The page may need a login, block automated readers, or not be an article. Save it from your browser as .html and pass that file instead.',
      1,
    );
  }
  const { art, pageMeta, words } = result;
  if (words < 150) warnings.push(`only ${words} words extracted — the page may be paywalled, login-only or mostly non-text`);

  // Keep the lead image when Readability dropped it from the content.
  let coverUrl = null;
  if (pageMeta.ogImage) {
    const inBody = art.content.includes(pageMeta.ogImage.split('?')[0].split('/').pop());
    if (!inBody) coverUrl = new URL(pageMeta.ogImage, finalUrl).href;
  }
  return {
    kind: 'web',
    title: (art.title || '').trim() || new URL(finalUrl).hostname,
    byline: (art.byline || '').trim(),
    siteName: (art.siteName || '').trim() || new URL(finalUrl).hostname.replace(/^www\./, ''),
    published: art.publishedTime || pageMeta.published || '',
    excerpt: (art.excerpt || '').trim(),
    lang: art.lang || pageMeta.lang || 'en',
    sourceUrl: pageMeta.canonical || finalUrl,
    coverUrl,
    bodyHtml: art.content,
    method,
    warnings,
  };
}

/** Readability for a saved .html file. */
export async function fromHtmlFile(path, html) {
  await loadDeps();
  const fileUrl = 'file://' + path;
  const result = extract(makeDom(html, fileUrl));
  const warnings = [];
  if (!result) {
    // Not article-shaped: keep the whole body.
    const dom = makeDom(html, fileUrl);
    const doc = dom.window.document;
    return { kind: 'file', title: doc.title || path.split('/').pop(), byline: '', siteName: 'Local file', published: '', lang: 'en', sourceUrl: fileUrl, coverUrl: null, bodyHtml: doc.body?.innerHTML || '', warnings: ['Readability found no article; used the whole page body'] };
  }
  const { art, pageMeta } = result;
  return {
    kind: 'file',
    title: (art.title || '').trim() || path.split('/').pop(),
    byline: (art.byline || '').trim(),
    siteName: (art.siteName || '').trim() || 'Saved page',
    published: art.publishedTime || pageMeta.published || '',
    excerpt: (art.excerpt || '').trim(),
    lang: art.lang || 'en',
    sourceUrl: pageMeta.canonical || fileUrl,
    coverUrl: null,
    bodyHtml: art.content,
    warnings,
  };
}

export function writeDebug(dir, name, text) {
  try {
    writeFileSync(join(dir, name), text);
  } catch {
    /* debug output is optional */
  }
}
