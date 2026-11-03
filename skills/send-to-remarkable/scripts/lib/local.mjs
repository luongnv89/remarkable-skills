// Local files: Markdown (incl. Obsidian embeds), plain text, saved HTML.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { escapeHtml, fail, which } from './common.mjs';
import { fromHtmlFile } from './web.mjs';

export const LOCAL_TEXT = new Set(['.md', '.markdown', '.txt', '.text', '.html', '.htm']);

function pandoc(text, from) {
  if (!which('pandoc')) fail('pandoc is not installed; it converts Markdown files.', 'Ask the user to install it (brew install pandoc), or pass the note as .txt.', 1);
  const r = spawnSync('pandoc', ['-f', from, '-t', 'html5', '--wrap=none'], { input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`pandoc could not convert the file (${(r.stderr || '').trim()}).`, 'Check the file for broken front matter, or save it as .txt.', 1);
  return r.stdout;
}

function frontMatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Find the Obsidian vault root (a parent folder holding .obsidian/). */
function vaultRoot(start) {
  let d = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, '.obsidian'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function findInVault(root, name, limit = 20000) {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < limit) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
}

/** Turn Obsidian embeds/wikilinks into standard Markdown and resolve image paths. */
function obsidianToMarkdown(md, fileDir, warnings) {
  const root = vaultRoot(fileDir);
  const resolveImg = (target) => {
    if (/^https?:\/\//i.test(target)) return target;
    const direct = resolve(fileDir, decodeURIComponent(target));
    if (existsSync(direct)) return direct;
    if (root) {
      const hit = findInVault(root, basename(decodeURIComponent(target)));
      if (hit) return hit;
    }
    warnings.push(`image not found: ${target}`);
    return target;
  };
  return md
    .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target, alt) => {
      const ext = extname(target).toLowerCase();
      if (!/^\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?)$/.test(ext)) return `*(embedded note: ${target.trim()})*`;
      const p = resolveImg(target.trim());
      const altText = alt && !/^\d+(x\d+)?$/.test(alt) ? alt : '';
      return `![${altText}](<${p}>)`;
    })
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]+)(?:#([^\]|]*))?\]\]/g, (_, t) => t.trim())
    .replace(/!\[([^\]]*)\]\((?!https?:|data:|<)([^)\s]+)(\s+"[^"]*")?\)/g, (_, alt, target, title) => `![${alt}](<${resolveImg(target)}>${title || ''})`);
}

export async function fromFile(path) {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) fail(`file not found: ${path}`, 'Pass the full path to an existing .md, .txt or .html file.', 2);
  const ext = extname(abs).toLowerCase();
  const raw = readFileSync(abs, 'utf8');
  const warnings = [];
  const stat = statSync(abs);
  const base = { kind: 'file', siteName: 'Local file', byline: '', published: stat.mtime.toISOString(), lang: 'en', sourceUrl: 'file://' + abs, coverUrl: null, warnings };

  if (ext === '.html' || ext === '.htm') return fromHtmlFile(abs, raw);

  if (ext === '.md' || ext === '.markdown') {
    const { meta, body } = frontMatter(raw);
    let md = obsidianToMarkdown(body, dirname(abs), warnings);
    let title = meta.title || '';
    const h1 = md.match(/^#\s+(.+?)\s*#*\s*$/m);
    if (!title && h1) {
      title = h1[1];
      md = md.replace(h1[0], ''); // the title is printed in the masthead
    }
    return {
      ...base,
      title: title || basename(abs, ext),
      byline: meta.author || '',
      published: meta.date || meta.created || base.published,
      bodyHtml: pandoc(md, 'markdown+autolink_bare_uris-tex_math_dollars'),
      warnings,
    };
  }

  // Plain text: paragraphs on blank lines; no Markdown or HTML interpretation.
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const firstIdx = lines.findIndex((l) => l.trim());
  let title = basename(abs, ext);
  let bodyText = raw;
  if (firstIdx >= 0 && lines[firstIdx].trim().length <= 100 && (lines[firstIdx + 1] ?? '').trim() === '') {
    title = lines[firstIdx].trim();
    bodyText = lines.slice(firstIdx + 1).join('\n');
  }
  const paras = bodyText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const ls = p.split('\n');
      const keepBreaks = ls.length > 1 && ls.every((l) => l.length < 60);
      return `<p>${ls.map((l) => escapeHtml(l.trim())).join(keepBreaks ? '<br>' : ' ')}</p>`;
    });
  return { ...base, title, bodyHtml: paras.join('\n') };
}
