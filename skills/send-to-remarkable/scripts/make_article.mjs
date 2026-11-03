#!/usr/bin/env node
// make_article.mjs — turn an X link, a web URL or a local text file into a reMarkable-sized PDF.
//
//   node make_article.mjs <url-or-file> [--device rm2|rmpp|move] [--out DIR] [--render] [--no-notes]
//   node make_article.mjs --check
//
// stdout: one JSON summary line. stderr: progress, warnings, errors (each error says what failed and how to fix it).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { ensureDir, expandHome, fail, findChrome, slugify, which } from './lib/common.mjs';
import { isXUrl, fromX } from './lib/x.mjs';
import { fromWeb } from './lib/web.mjs';
import { fromFile, LOCAL_TEXT } from './lib/local.mjs';
import { buildHtml, contactSheet, DEVICES, inspectPdf, prepareBody, previewPng, printPdf, writeHtml } from './lib/render.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const CSS_PATH = join(HERE, '..', 'assets', 'article.css');

function parseArgs(argv) {
  const opts = { device: process.env.RM_DEVICE || 'rm2', out: process.env.RM_ARTICLES_DIR || join(homedir(), 'Documents', 'remarkable-articles'), render: false, notes: true, check: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device') opts.device = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--render') opts.render = true;
    else if (a === '--no-notes') opts.notes = false;
    else if (a === '--check') opts.check = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: node make_article.mjs <url-or-file> [--device rm2|rmpp|move] [--out DIR] [--render] [--no-notes]\n       node make_article.mjs --check\n');
      process.exit(0);
    } else if (a.startsWith('--')) fail(`unknown option ${a}`, 'Run with --help to see the options.', 2);
    else if (!opts.input) opts.input = a;
    else fail(`more than one input given (${opts.input}, ${a})`, 'Convert one article per run.', 2);
  }
  if (!DEVICES[opts.device]) fail(`unknown device "${opts.device}"`, `Use one of: ${Object.keys(DEVICES).join(', ')}.`, 2);
  opts.out = resolve(expandHome(opts.out));
  return opts;
}

function check() {
  const rows = [];
  const deps = existsSync(join(HERE, 'node_modules', 'jsdom')) && existsSync(join(HERE, 'node_modules', '@mozilla', 'readability'));
  rows.push(['node packages', deps, deps ? 'ok' : `missing — run: npm ci --prefix "${HERE}"`]);
  const chrome = findChrome();
  rows.push(['chrome', !!chrome, chrome || 'missing — install Google Chrome or set CHROME_PATH']);
  const pandoc = which('pandoc');
  rows.push(['pandoc (Markdown files only)', pandoc ? true : null, pandoc || 'not found — .md files cannot be converted until it is installed (ask the user before installing)']);
  const ok = rows.every((r) => r[1] !== false);
  for (const [name, good, note] of rows) process.stderr.write(`${good === true ? '√' : good === null ? '—' : '×'} ${name}: ${note}\n`);
  process.stdout.write(JSON.stringify({ ok, checks: Object.fromEntries(rows.map((r) => [r[0], r[2]])) }) + '\n');
  process.exit(ok ? 0 : 1);
}

function classify(input) {
  if (/^https?:\/\//i.test(input)) return isXUrl(input) ? 'x' : 'web';
  const p = resolve(expandHome(input));
  if (!existsSync(p)) fail(`input not found: ${input}`, 'Pass an http(s) URL or the path of an existing .md, .txt, .html or .pdf file.', 2);
  const ext = extname(p).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (LOCAL_TEXT.has(ext)) return 'file';
  fail(`unsupported file type "${ext || '(none)'}" for ${input}`, 'Supported: .md, .markdown, .txt, .html, .htm, or a ready .pdf. Export other formats to one of these first.', 2);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) return check();
  if (!opts.input) fail('no input given', 'Usage: node make_article.mjs <url-or-file> [--device rm2]', 2);

  const kind = classify(opts.input);
  ensureDir(opts.out);
  const workDir = mkdtempSync(join(tmpdir(), 'send-to-remarkable-'));
  const stamp = new Date().toISOString().slice(0, 10);

  // A ready PDF is passed through untouched (it keeps its own page size).
  const finishPdf = (pdfPath, title, sourceUrl, warnings = []) => {
    const info = inspectPdf(pdfPath);
    if (!info.pages) fail(`${pdfPath} has no readable pages`, 'Open it in Preview to check it is a valid PDF.', 1);
    const preview = previewPng(pdfPath, join(workDir, 'preview-1.png'));
    const sheet = contactSheet(pdfPath, workDir);
    process.stdout.write(JSON.stringify({ ok: true, kind: 'pdf', title, pdf: pdfPath, pages: info.pages, pageSizeMm: info.pageSizeMm, device: null, words: null, images: null, links: 0, warnings, preview, sheet, workDir, sourceUrl }) + '\n');
  };
  if (kind === 'pdf') {
    const src = resolve(expandHome(opts.input));
    const title = src.split('/').pop().replace(/\.pdf$/i, '');
    const dest = join(opts.out, `${stamp}-${slugify(title)}.pdf`);
    if (src !== dest) copyFileSync(src, dest);
    return finishPdf(dest, title, 'file://' + src);
  }

  process.stderr.write(`→ reading ${kind === 'x' ? 'X post' : kind === 'web' ? 'web page' : 'file'}: ${opts.input}\n`);
  const model = kind === 'x' ? await fromX(opts.input) : kind === 'web' ? await fromWeb(opts.input, { render: opts.render }) : await fromFile(resolve(expandHome(opts.input)));

  if (model.kind === 'pdf') {
    const title = decodeURIComponent(new URL(model.sourceUrl).pathname.split('/').pop() || 'document').replace(/\.pdf$/i, '');
    const dest = join(opts.out, `${stamp}-${slugify(title)}.pdf`);
    writeFileSync(dest, model.pdfBytes);
    return finishPdf(dest, title, model.sourceUrl, model.warnings);
  }

  process.stderr.write(`→ "${model.title}" — downloading images\n`);
  const body = await prepareBody(model, workDir, { notes: opts.notes });
  if (body.words < 30 && body.images.saved === 0)
    fail(`almost nothing was extracted from ${opts.input} (${body.words} words, no images).`, 'Retry with --render, or save the page from your browser as .html and pass that file.', 1);

  const css = readFileSync(CSS_PATH, 'utf8');
  const htmlPath = writeHtml(workDir, buildHtml(model, body, opts.device, css));
  const pdfPath = join(opts.out, `${stamp}-${slugify(model.title)}.pdf`);
  process.stderr.write(`→ printing PDF for ${DEVICES[opts.device].label}\n`);
  printPdf(htmlPath, pdfPath);

  const info = inspectPdf(pdfPath);
  const want = [DEVICES[opts.device].w, DEVICES[opts.device].h];
  const warnings = [...(model.warnings || [])];
  if (body.images.failed.length) warnings.push(`${body.images.failed.length} image(s) could not be downloaded: ${body.images.failed.map((f) => `${f.src} (${f.error})`).join('; ')}`);
  if (!info.pageSizeMm || Math.abs(info.pageSizeMm[0] - want[0]) > 1 || Math.abs(info.pageSizeMm[1] - want[1]) > 1)
    warnings.push(`PDF page size ${JSON.stringify(info.pageSizeMm)} mm differs from the ${opts.device} screen ${JSON.stringify(want)} mm`);
  const preview = previewPng(pdfPath, join(workDir, 'preview-1.png'));
  const sheet = contactSheet(pdfPath, workDir);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      kind: model.kind,
      title: model.title,
      pdf: pdfPath,
      pages: info.pages,
      pageSizeMm: info.pageSizeMm,
      device: opts.device,
      words: body.words,
      images: body.images,
      links: body.notes.length,
      method: model.method || null,
      warnings,
      preview,
      sheet,
      html: htmlPath,
      workDir,
      sourceUrl: model.sourceUrl,
    }) + '\n',
  );
}

main().catch((e) => fail(`unexpected failure: ${e.stack || e.message}`, 'Re-run once; if it repeats, the stack trace above names the failing step.', 1));
