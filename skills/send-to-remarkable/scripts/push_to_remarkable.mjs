#!/usr/bin/env node
// push_to_remarkable.mjs — put PDFs into the reMarkable library over SSH, then restart the UI once.
//
//   node push_to_remarkable.mjs <file.pdf> [--title T] [--folder Articles] [--hosts a,b] [--no-restart] [--force] [--dry-run]
//   node push_to_remarkable.mjs <file.pdf> --queue-only   queue without contacting the tablet (send later, or a batch), then one --flush
//   node push_to_remarkable.mjs --flush        sync: send whatever is queued, each item to its own folder, in one UI restart
//   node push_to_remarkable.mjs --list         offline: what is queued; never contacts the tablet
//   node push_to_remarkable.mjs --status       read-only: queue, reachability, guards
//
// Every new PDF is queued first, then the whole queue is delivered, so nothing is lost when the tablet is asleep or away.
// Env: RM_HOSTS (default "remarkable-wifi,remarkable"), RM_FOLDER (default "Articles"),
//      RM_STATE_DIR (queue + restart log), RM_TABLET_DIR (a local folder used as a fake tablet: no SSH, restart simulated).
// Exit: 0 done · 2 bad input · 3 queued (tablet offline) · 4 queued (reMarkdown open) · 5 queued (restart limit)
//       6 uploaded but the UI restart or check failed · 1 other error.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
const RESTART_WINDOW_S = 600; // xochitl.service: StartLimitIntervalSec=600, StartLimitBurst=4
const MAX_SKILL_RESTARTS = 2; // per window, leaving room for xovi/start and the user's own restarts
const MIN_UPTIME_S = 90; // never restart a UI that started less than this long ago

const EXIT = { ok: 0, error: 1, input: 2, offline: 3, busy: 4, rate: 5, restart: 6 };

function die(what, fix, code = EXIT.error) {
  process.stderr.write(`Error: ${what}\n${fix ? `Fix: ${fix}\n` : ''}`);
  process.exit(code);
}
const say = (m) => process.stderr.write(m + '\n');

// ---------- arguments ----------
const args = { pdf: null, title: null, folder: process.env.RM_FOLDER || 'Articles', hosts: (process.env.RM_HOSTS || 'remarkable-wifi,remarkable').split(',').map((s) => s.trim()).filter(Boolean), restart: true, force: false, dry: false, flush: false, status: false, list: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--title') args.title = argv[++i];
  else if (a === '--folder') args.folder = argv[++i];
  else if (a === '--hosts') args.hosts = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--no-restart') args.restart = false;
  else if (a === '--force') args.force = true;
  else if (a === '--dry-run') args.dry = true;
  else if (a === '--flush') args.flush = true;
  else if (a === '--queue-only') args.queueOnly = true;
  else if (a === '--status') args.status = true;
  else if (a === '--list') args.list = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write('Usage: node push_to_remarkable.mjs <file.pdf> [--title T] [--folder Articles] [--hosts a,b] [--no-restart] [--force] [--dry-run] [--queue-only]\n       node push_to_remarkable.mjs --flush | --list | --status\n');
    process.exit(0);
  } else if (a.startsWith('--')) die(`unknown option ${a}`, 'Run with --help to see the options.', EXIT.input);
  else if (!args.pdf) args.pdf = a;
  else die(`more than one PDF given (${args.pdf}, ${a})`, 'Push one PDF per call; earlier ones stay queued and go out together.', EXIT.input);
}
if (!args.pdf && !args.flush && !args.status && !args.list) die('no PDF given', 'Usage: node push_to_remarkable.mjs <file.pdf>  (or --flush / --list / --status)', EXIT.input);
if (!args.folder || /[\/\n]/.test(args.folder)) die(`invalid folder name "${args.folder}"`, 'Use a single top-level folder name such as Articles (no slashes).', EXIT.input);

const FAKE = process.env.RM_TABLET_DIR ? resolve(process.env.RM_TABLET_DIR) : null;
const STATE = resolve(process.env.RM_STATE_DIR || (FAKE ? FAKE + '.state' : join(homedir(), 'Library', 'Application Support', 'send-to-remarkable')));
const QUEUE = join(STATE, 'queue');
// Documents already on the tablet that still wait for a UI restart (the guard re-check stopped it).
const PENDING = join(STATE, 'pending-restart.json');
const readPending = () => (existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf8')) : []);
mkdirSync(QUEUE, { recursive: true });

// ---------- PDF facts ----------
function pdfPages(file) {
  const r = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
  const m = r.status === 0 && r.stdout.match(/^Pages:\s+(\d+)/m);
  if (m) return parseInt(m[1], 10);
  const n = (readFileSync(file).toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return n;
}
// The PDF's own Title (Chrome copies the article <title>), so titles never pass through a shell.
function pdfTitle(file) {
  const r = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
  const m = r.status === 0 && r.stdout.match(/^Title:\s+(.+)$/m);
  if (m) return m[1].trim();
  const raw = readFileSync(file).toString('latin1');
  const lit = raw.match(/\/Title\s*\(((?:\\.|[^\\)])*)\)/s);
  const hex = raw.match(/\/Title\s*<([0-9A-Fa-f]+)>/);
  let bytes = null;
  if (lit) bytes = Buffer.from(lit[1].replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[e] ?? (/^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e)), 'latin1');
  else if (hex) bytes = Buffer.from(hex[1], 'hex');
  if (!bytes) return null;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const le = Buffer.from(bytes.subarray(2));
    le.swap16();
    return le.toString('utf16le').trim() || null;
  }
  return bytes.toString('latin1').trim() || null;
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// ---------- tablet access ----------
class SshTablet {
  constructor(host) {
    this.host = host;
    this.label = `ssh ${host}`;
  }
  run(cmd, input) {
    return spawnSync('ssh', [...SSH_OPTS, this.host, cmd], { input, encoding: input && Buffer.isBuffer(input) ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  }
  sh(script) {
    const r = this.run('sh -s', script);
    return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '') };
  }
  probe() {
    return this.sh(`test -d ${XOCHITL} && echo ok`).out.trim() === 'ok';
  }
  guards() {
    // reMarkdown's backend runs as "backend/entry /tmp/reMarkdown.sock" (relative path, verified on OS 3.28),
    // so match the socket name in the command line or the resolved executable — never "rmd/backend/entry".
    const r = this.sh(`rmd=0
pgrep -f 'reMarkdown[.]sock' >/dev/null 2>&1 && rmd=1
for p in /proc/[0-9]*; do case "$(readlink $p/exe 2>/dev/null)" in */appload/rmd/backend/entry) rmd=1;; esac; done
echo rmd=$rmd
echo start=$(systemctl show xochitl -p ActiveEnterTimestamp --timestamp=unix 2>/dev/null | cut -d@ -f2)
echo now=$(date +%s)
echo up=$(cut -d. -f1 /proc/uptime)
echo mono=$(systemctl show xochitl -p ActiveEnterTimestampMonotonic | cut -d= -f2)
echo active=$(systemctl is-active xochitl)
pid=$(pidof xochitl | cut -d' ' -f1)
if [ -n "$pid" ] && grep -q xovi /proc/$pid/maps 2>/dev/null; then echo xovi=1; else echo xovi=0; fi
echo freekb=$(df -k /home | awk 'NR==2{print $4}')`);
    if (!r.ok) throw new Error(`guard check failed: ${r.err.trim()}`);
    const kv = Object.fromEntries(r.out.trim().split('\n').map((l) => l.split('=')));
    // Wall clock on both ends (tablet clock). The uptime/monotonic pair is only a fallback for systemd < 251:
    // /proc/uptime counts suspend time and the monotonic clock does not, so it overstates the gap.
    const sinceStart = /^\d+$/.test(kv.start || '') ? parseInt(kv.now, 10) - parseInt(kv.start, 10) : parseInt(kv.up, 10) - Math.floor(parseInt(kv.mono || '0', 10) / 1e6);
    return { remarkdownOpen: kv.rmd === '1', sinceStart, active: kv.active === 'active', xovi: kv.xovi === '1', freeKb: parseInt(kv.freekb || '0', 10) };
  }
  listMetadata() {
    const r = this.sh(`cd ${XOCHITL} && for f in *.metadata; do [ -f "$f" ] || continue; printf '\\n@@@%s\\n' "$f"; cat "$f"; done`);
    if (!r.ok) throw new Error(`could not read the library: ${r.err.trim()}`);
    return parseListing(r.out);
  }
  putFile(name, data) {
    const r = this.run(`cat > '${XOCHITL}/${name}.part'`, data);
    if (r.status !== 0) throw new Error(`upload of ${name} failed: ${String(r.stderr || '').trim()}`);
  }
  commit(names) {
    const r = this.sh(names.map((n) => `mv '${XOCHITL}/${n}.part' '${XOCHITL}/${n}'`).join(' && ') + ' && sync');
    if (!r.ok) throw new Error(`could not finalise ${names.join(', ')}: ${r.err.trim()}`);
  }
  abort(names) {
    this.sh(names.map((n) => `rm -f '${XOCHITL}/${n}.part'`).join('; '));
  }
  restartUi() {
    const r = this.sh(`systemctl restart xochitl
i=0; while [ $i -lt 40 ]; do [ "$(systemctl is-active xochitl)" = active ] && break; sleep 1; i=$((i+1)); done
sleep 4
echo active=$(systemctl is-active xochitl)
pid=$(pidof xochitl | cut -d' ' -f1)
if [ -n "$pid" ] && grep -q xovi /proc/$pid/maps 2>/dev/null; then echo xovi=1; else echo xovi=0; fi`);
    const kv = Object.fromEntries(r.out.trim().split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
    return { active: kv.active === 'active', xovi: kv.xovi === '1', err: r.err.trim() };
  }
  readMetadata(uuid) {
    const r = this.sh(`cat '${XOCHITL}/${uuid}.metadata' 2>/dev/null`);
    try {
      return JSON.parse(r.out);
    } catch {
      return null;
    }
  }
}

class FakeTablet {
  // Marker files in the fake folder simulate tablet states for tests: .fake-offline, .fake-remarkdown-open,
  // .fake-remarkdown-opens-later, .fake-last-start, .fake-xovi-lost. Each connection attempt adds a line to .fake-probes.log.
  constructor(dir) {
    this.dir = dir;
    this.label = `fake tablet ${dir}`;
    mkdirSync(dir, { recursive: true });
  }
  probe() {
    appendFileSync(join(this.dir, '.fake-probes.log'), new Date().toISOString() + '\n');
    return !existsSync(join(this.dir, '.fake-offline'));
  }
  guards() {
    const lastFile = join(this.dir, '.fake-last-start');
    const last = existsSync(lastFile) ? parseInt(readFileSync(lastFile, 'utf8'), 10) : 0;
    this.calls = (this.calls || 0) + 1; // .fake-remarkdown-opens-later: open from the second check on (mid-push)
    const opened = existsSync(join(this.dir, '.fake-remarkdown-open')) || (this.calls > 1 && existsSync(join(this.dir, '.fake-remarkdown-opens-later')));
    return { remarkdownOpen: opened, sinceStart: last ? Math.floor(Date.now() / 1000) - last : 99999, active: true, xovi: true, freeKb: 5e6 };
  }
  listMetadata() {
    const out = readdirSync(this.dir)
      .filter((f) => f.endsWith('.metadata'))
      .map((f) => `\n@@@${f}\n${readFileSync(join(this.dir, f), 'utf8')}`)
      .join('');
    return parseListing(out);
  }
  putFile(name, data) {
    writeFileSync(join(this.dir, name + '.part'), data);
  }
  commit(names) {
    for (const n of names) renameSync(join(this.dir, n + '.part'), join(this.dir, n));
  }
  abort(names) {
    for (const n of names) rmSync(join(this.dir, n + '.part'), { force: true });
  }
  restartUi() {
    writeFileSync(join(this.dir, '.fake-last-start'), String(Math.floor(Date.now() / 1000)));
    appendFileSync(join(this.dir, '.fake-restarts.log'), new Date().toISOString() + '\n');
    return { active: true, xovi: !existsSync(join(this.dir, '.fake-xovi-lost')), err: '' };
  }
  readMetadata(uuid) {
    try {
      return JSON.parse(readFileSync(join(this.dir, uuid + '.metadata'), 'utf8'));
    } catch {
      return null;
    }
  }
}

function parseListing(out) {
  const items = [];
  for (const chunk of out.split('\n@@@').slice(1)) {
    const nl = chunk.indexOf('\n');
    const file = chunk.slice(0, nl).trim();
    try {
      items.push({ uuid: file.replace(/\.metadata$/, ''), ...JSON.parse(chunk.slice(nl + 1)) });
    } catch {
      /* skip unreadable metadata */
    }
  }
  return items;
}

const live = (m) => m.parent !== 'trash' && m.deleted !== true;

// ---------- queue ----------
function readQueue() {
  return readdirSync(QUEUE)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: join(QUEUE, f), ...JSON.parse(readFileSync(join(QUEUE, f), 'utf8')) }))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}
function enqueue(pdf, title, folder) {
  const abs = resolve(pdf);
  if (!existsSync(abs)) die(`PDF not found: ${pdf}`, 'Pass the path printed by make_article.mjs (the "pdf" field).', EXIT.input);
  const head = readFileSync(abs).subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') die(`${pdf} is not a PDF file`, 'Pass a .pdf produced by make_article.mjs.', EXIT.input);
  const name = cleanName(title || pdfTitle(abs) || abs.split('/').pop().replace(/\.pdf$/i, ''));
  // One item per document and folder: the same PDF, or the same title rebuilt on another day (the newest PDF wins).
  const existing = readQueue().find((q) => q.folder === folder && (q.pdf === abs || q.title === name));
  if (existing) {
    if (existing.pdf !== abs) {
      const { file, ...item } = existing;
      writeFileSync(file, JSON.stringify({ ...item, pdf: abs }, null, 2));
      say(`Warning: "${name}" was already queued for ${folder}; the queue now sends ${abs} instead of ${existing.pdf}`);
      existing.replaced = existing.pdf;
      existing.pdf = abs;
    }
    return existing;
  }
  const item = { id: randomUUID(), pdf: abs, title: name, folder, queuedAt: new Date().toISOString() };
  writeFileSync(join(QUEUE, item.id + '.json'), JSON.stringify(item, null, 2));
  return item;
}
const dequeue = (item) => rmSync(item.file || join(QUEUE, item.id + '.json'), { force: true });

function recentRestarts() {
  const f = join(STATE, 'restarts.log');
  const now = Date.now() / 1000;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .map(Number)
    .filter((t) => t && now - t < RESTART_WINDOW_S);
}

// ---------- xochitl files (field set copied from documents written by OS 3.28) ----------
const json4 = (o) => JSON.stringify(o, null, 4) + '\n';
function docFiles(item, folderId) {
  const now = String(Date.now());
  const pages = pdfPages(item.pdf);
  const size = statSync(item.pdf).size;
  const metadata = { createdTime: now, lastModified: now, lastOpened: '0', lastOpenedPage: 0, new: false, parent: folderId, pinned: false, source: '', type: 'DocumentType', visibleName: item.title };
  const content = pages
    ? { coverPageNumber: 0, customZoomCenterX: 0, customZoomCenterY: 936, customZoomOrientation: 'portrait', customZoomPageHeight: 1872, customZoomPageWidth: 1404, customZoomScale: 1, documentMetadata: {}, extraMetadata: {}, fileType: 'pdf', fontName: '', formatVersion: 1, lineHeight: -1, orientation: 'portrait', originalPageCount: pages, pageCount: pages, pageTags: [], pages: Array.from({ length: pages }, () => randomUUID()), redirectionPageMap: Array.from({ length: pages }, (_, i) => i), sizeInBytes: String(size), tags: [], textAlignment: 'justify', textScale: 1, zoomMode: 'bestFit' }
    : { extraMetadata: {}, fileType: 'pdf', lineHeight: -1, orientation: 'portrait', tags: [], textScale: 1, zoomMode: 'bestFit' };
  // .pagedata: one template name per page, as xochitl writes it for imported PDFs ("Blank\n" × pages).
  return { metadata: json4(metadata), content: json4(content), pagedata: 'Blank\n'.repeat(pages), pages };
}
function folderFiles(name) {
  const now = String(Date.now());
  return { metadata: json4({ createdTime: now, lastModified: now, new: false, parent: '', pinned: false, source: '', type: 'CollectionType', visibleName: name }), content: '{\n}\n' };
}

// ---------- main ----------
function connect() {
  if (FAKE) {
    const t = new FakeTablet(FAKE);
    return t.probe() ? t : null;
  }
  for (const h of args.hosts) {
    const t = new SshTablet(h);
    if (t.probe()) return t;
  }
  return null;
}

function lock() {
  const f = join(STATE, 'push.lock');
  try {
    const fd = openSync(f, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    const pid = parseInt(readFileSync(f, 'utf8'), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) die(`another push is running (pid ${pid})`, 'Wait for it to finish; its documents and this one go out in one UI restart.', EXIT.error);
    writeFileSync(f, String(process.pid));
  }
  process.on('exit', () => rmSync(f, { force: true }));
}

function finish(summary, code) {
  process.stdout.write(JSON.stringify({ ...summary, exit: code }) + '\n');
  process.exit(code);
}

const SYNC_LATER = 'Sync when the tablet is nearby and awake (Wi-Fi on, or USB plugged in): node push_to_remarkable.mjs --flush. Any later push while the tablet answers delivers the queue too.';

function main() {
  if (args.list) {
    // Offline: reads the Mac-side state only, so it answers instantly while the tablet is away.
    const queue = readQueue();
    const pendingRestart = readPending().map((x) => x.title);
    finish({ ok: true, mode: 'list', count: queue.length, queue: queue.map((q) => ({ id: q.id, title: q.title, folder: q.folder, queuedAt: q.queuedAt, pdf: q.pdf, pdfExists: existsSync(q.pdf) })), pendingRestart, next: queue.length || pendingRestart.length ? SYNC_LATER : 'Nothing is waiting.' }, EXIT.ok);
  }
  if (args.status) {
    const t = connect();
    const g = t ? t.guards() : null;
    finish({ ok: true, mode: 'status', tablet: t ? t.label : null, reachable: !!t, guards: g, queue: readQueue().map((q) => ({ title: q.title, folder: q.folder, queuedAt: q.queuedAt, pdf: q.pdf })), pendingRestart: readPending().map((x) => x.title), skillRestartsLast10min: recentRestarts().length }, EXIT.ok);
  }
  if (args.queueOnly) {
    if (!args.pdf) die('--queue-only needs a PDF', 'Usage: node push_to_remarkable.mjs <file.pdf> --queue-only, then one --flush to sync the queue.', EXIT.input);
    const item = enqueue(args.pdf, args.title, args.folder);
    const queue = readQueue();
    finish({ ok: true, mode: 'queue-only', added: item.title, folder: item.folder, count: queue.length, queued: queue.map((q) => q.title), replaced: item.replaced, contacted: false, next: `Nothing was sent. ${SYNC_LATER}` }, EXIT.ok);
  }
  if (!args.dry) lock();
  const fresh = args.pdf ? (args.dry ? { id: 'dry-run', pdf: resolve(args.pdf), title: cleanName(args.title || pdfTitle(resolve(args.pdf)) || args.pdf), folder: args.folder, queuedAt: new Date().toISOString() } : enqueue(args.pdf, args.title, args.folder)) : null;
  const queue = args.dry ? [...readQueue(), ...(fresh ? [fresh] : [])] : readQueue();
  const missing = queue.filter((q) => !existsSync(q.pdf));
  for (const m of missing) {
    say(`Warning: dropped "${m.title}" from the queue — its PDF ${m.pdf} no longer exists`);
    if (!args.dry) dequeue(m);
  }
  const todo = queue.filter((q) => existsSync(q.pdf));
  const base = { ok: false, tablet: null, folder: args.folder, delivered: [], skipped: [], queued: todo.map((q) => q.title), dryRun: args.dry };
  const pending = args.restart ? readPending() : [];
  if (!todo.length && !pending.length) finish({ ...base, ok: true, note: 'queue empty, nothing to send' }, EXIT.ok);

  const t = connect();
  if (!t)
    finish({ ...base, reason: `tablet not reachable over ${FAKE ? 'the fake tablet folder' : args.hosts.join(', ')} (asleep, out of range, or not with you)`, next: `${args.pdf ? 'The PDF is queued' : 'The queue is kept'}. Tablet nearby: press its power button so Wi-Fi reconnects (or plug in USB), then run: node push_to_remarkable.mjs --flush. Tablet away: sync when you are back; any later push while the tablet answers delivers the queue too.` }, EXIT.offline);
  base.tablet = t.label;

  const g = t.guards();
  if (args.restart && g.remarkdownOpen)
    finish({ ...base, reason: 'reMarkdown is open on the tablet; restarting the UI now would lose its unsaved text', next: 'Close reMarkdown (Esc, then Esc from the file picker), then run: node push_to_remarkable.mjs --flush' }, EXIT.busy);
  const restarts = recentRestarts();
  if (args.restart && (g.sinceStart < MIN_UPTIME_S || restarts.length >= MAX_SKILL_RESTARTS)) {
    const waitS = Math.max(MIN_UPTIME_S - g.sinceStart, restarts.length >= MAX_SKILL_RESTARTS ? Math.ceil(restarts[0] + RESTART_WINDOW_S - Date.now() / 1000) : 0);
    const at = new Date(Date.now() + waitS * 1000).toTimeString().slice(0, 5);
    finish({ ...base, reason: `the UI started ${g.sinceStart}s ago and this skill restarted it ${restarts.length} time(s) in the last 10 min; xochitl allows 4 starts per 10 min before the tablet's failure handler reboots it`, next: `Run node push_to_remarkable.mjs --flush after ${at}` }, EXIT.rate);
  }
  if (args.restart && !g.active) finish({ ...base, reason: 'the reMarkable UI (xochitl) is not running, so it is not safe to restart it', next: 'Check the tablet screen; reboot it if it is stuck, then run --flush.' }, EXIT.restart);
  const needKb = todo.reduce((n, q) => n + Math.ceil(statSync(q.pdf).size / 1024), 0) + 2048;
  if (g.freeKb && g.freeKb < needKb) finish({ ...base, reason: `only ${g.freeKb} KB free on the tablet, ${needKb} KB needed` , next: 'Delete documents on the tablet, then run --flush.' }, EXIT.error);

  const lib = t.listMetadata();
  // Each queued item goes to the folder it was queued for, so a later sync never moves it to this call's --folder.
  const folderIds = {};
  const findFolder = (name) => {
    if (name in folderIds) return folderIds[name];
    const found = lib.filter((m) => live(m) && m.type === 'CollectionType' && m.parent === '' && m.visibleName === name);
    found.sort((a, b) => Number(b.lastModified || 0) - Number(a.lastModified || 0));
    if (found.length > 1) say(`Warning: ${found.length} top-level folders are named "${name}"; using the most recently modified one`);
    return (folderIds[name] = found[0]?.uuid || null);
  };
  const plan = [];
  const planned = new Set();
  for (const q of todo) {
    const fid = findFolder(q.folder);
    const key = `${q.folder}\n${q.title}`;
    const dup = fid && lib.find((m) => live(m) && m.type === 'DocumentType' && m.parent === fid && m.visibleName === q.title);
    if (dup && !args.force) plan.push({ q, action: 'skip', why: `already in ${q.folder} (document ${dup.uuid})` });
    else if (planned.has(key)) plan.push({ q, action: 'skip', why: `queued twice; sent once to ${q.folder}` });
    else {
      planned.add(key);
      plan.push({ q, action: 'upload' });
    }
  }
  const newFolders = [...new Set(plan.filter((p) => p.action === 'upload' && !folderIds[p.q.folder]).map((p) => p.q.folder))];
  if (args.dry)
    finish({ ...base, ok: true, guards: g, folderExists: !!findFolder(args.folder), newFolders, plan: plan.map((p) => ({ title: p.q.title, folder: p.q.folder, action: p.action, why: p.why })), pendingRestart: pending.map((x) => x.title), willRestart: args.restart && (pending.length > 0 || plan.some((p) => p.action === 'upload')) }, EXIT.ok);

  // Upload: every file lands as .part first and is renamed only when complete; metadata goes last.
  for (const name of newFolders) {
    const id = randomUUID();
    const f = folderFiles(name);
    t.putFile(`${id}.content`, f.content);
    t.putFile(`${id}.metadata`, f.metadata);
    t.commit([`${id}.content`, `${id}.metadata`]);
    folderIds[name] = id;
    say(`→ created folder "${name}" (${id})`);
  }
  const uploaded = [];
  for (const p of plan) {
    if (p.action === 'skip') {
      base.skipped.push({ title: p.q.title, folder: p.q.folder, why: p.why });
      dequeue(p.q);
      continue;
    }
    const uuid = randomUUID();
    const fid = folderIds[p.q.folder];
    const files = docFiles(p.q, fid);
    const names = [`${uuid}.pdf`, ...(files.pagedata ? [`${uuid}.pagedata`] : []), `${uuid}.content`, `${uuid}.metadata`];
    try {
      t.putFile(`${uuid}.pdf`, readFileSync(p.q.pdf));
      if (files.pagedata) t.putFile(`${uuid}.pagedata`, files.pagedata);
      t.putFile(`${uuid}.content`, files.content);
      t.putFile(`${uuid}.metadata`, files.metadata);
      t.commit(names);
      uploaded.push({ q: p.q, uuid, pages: files.pages, folderId: fid });
      say(`→ uploaded "${p.q.title}" (${files.pages} pages) to ${p.q.folder} as ${uuid}`);
    } catch (e) {
      t.abort(names);
      finish({ ...base, delivered: uploaded.map((u) => ({ title: u.q.title, folder: u.q.folder, uuid: u.uuid })), reason: e.message, next: 'Check the connection and run --flush; the queue still holds this document.' }, EXIT.error);
    }
  }
  base.queued = [];

  // Re-check the guards right before restarting: the uploads take time and the user may have opened reMarkdown meanwhile.
  const waiting = [...pending, ...uploaded.map((u) => ({ title: u.q.title, uuid: u.uuid, pages: u.pages, folderId: u.folderId }))];
  if (waiting.length && args.restart) {
    const g2 = t.guards();
    if (g2.remarkdownOpen || g2.sinceStart < MIN_UPTIME_S) {
      writeFileSync(PENDING, JSON.stringify(waiting, null, 2));
      for (const u of uploaded) dequeue(u.q);
      finish({ ...base, uploaded: waiting.map((w) => w.title), restarted: false, reason: g2.remarkdownOpen ? 'uploaded, but reMarkdown was opened before the UI restart, so the restart was skipped' : 'uploaded, but the UI restarted meanwhile, so this restart was skipped', next: 'The documents appear after the next UI restart. Close reMarkdown, then run: node push_to_remarkable.mjs --flush' }, g2.remarkdownOpen ? EXIT.busy : EXIT.rate);
    }
  }
  let restart = null;
  if (waiting.length && args.restart) {
    say('→ restarting the reMarkable UI so the new documents appear');
    appendFileSync(join(STATE, 'restarts.log'), Math.floor(Date.now() / 1000) + '\n');
    restart = t.restartUi();
  }
  for (const u of uploaded) {
    const m = t.readMetadata(u.uuid);
    const ok = m && m.visibleName === u.q.title && m.parent === u.folderId && live(m);
    base.delivered.push({ title: u.q.title, folder: u.q.folder, uuid: u.uuid, pages: u.pages, verified: !!ok });
    dequeue(u.q);
  }
  for (const w of pending) {
    const m = t.readMetadata(w.uuid);
    base.delivered.push({ title: w.title, uuid: w.uuid, pages: w.pages, verified: !!(m && m.visibleName === w.title && live(m)), note: 'uploaded earlier, shown after this restart' });
  }
  if (restart) rmSync(PENDING, { force: true });
  const xoviNote = restart ? (restart.xovi ? 'xovi still loaded' : g.xovi ? 'xovi NOT loaded after the restart — triple-press the power button to start it' : 'xovi was not running before') : null;
  const folders = Object.fromEntries(Object.entries(folderIds).filter(([, id]) => id));
  const summary = { ...base, ok: true, folderId: folders[args.folder] ?? null, folders, restarted: !!restart, uiActive: restart ? restart.active : null, xovi: xoviNote, note: uploaded.length && !args.restart ? 'uploaded without a UI restart; the documents appear after the next restart or reboot' : undefined };
  if (restart && !restart.active) finish({ ...summary, ok: false, reason: `the UI did not come back after the restart ${restart.err}`, next: 'Look at the tablet. If it shows an error, reboot it; the documents are already on it.' }, EXIT.restart);
  if (base.delivered.some((d) => !d.verified)) finish({ ...summary, ok: false, reason: 'a document was not found as written after the restart', next: 'Open the folder named in delivered[].folder on the tablet to check; run --status for details.' }, EXIT.restart);
  finish(summary, EXIT.ok);
}

try {
  main();
} catch (e) {
  die(`unexpected failure: ${e.message}`, 'Run with --status to check the connection and guards, then retry with --flush.', EXIT.error);
}
