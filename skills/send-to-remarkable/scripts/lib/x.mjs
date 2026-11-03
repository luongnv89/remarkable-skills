// X (Twitter) source: long-form Articles, single posts and threads, via the public FxTwitter API.
// Article bodies arrive as Draft.js blocks whose range offsets count code points (see renderInline).
import { escapeHtml, fail, fetchWithTimeout, UA_BOT, warnLine } from './common.mjs';

const API = process.env.FXTWITTER_API || 'https://api.fxtwitter.com';
const X_HOSTS = /(^|\.)(x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com|fixvx\.com|nitter\.net)$/i;

export function isXUrl(input) {
  try {
    const u = new URL(input);
    return /^https?:$/.test(u.protocol) && X_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Returns { id, bareArticle } or null. */
export function parseXUrl(input) {
  const u = new URL(input);
  const bare = u.pathname.match(/^\/i\/article\/(\d+)/);
  if (bare) return { id: bare[1], bareArticle: true };
  const m = u.pathname.match(/\/(?:status|statuses|article)\/(\d+)/);
  return m ? { id: m[1], bareArticle: false } : null;
}

async function getStatus(id, path = 'status') {
  const url = `${API}/2/${path}/${id}`;
  let res;
  try {
    res = await fetchWithTimeout(url, { timeoutMs: 30000, headers: { 'User-Agent': UA_BOT, Accept: 'application/json' } });
  } catch (e) {
    return { code: 0, message: e.name === 'AbortError' ? 'timed out after 30 s' : e.message };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { code: res.status, message: `non-JSON reply (HTTP ${res.status})` };
  }
  return body;
}

function largeTwimg(url) {
  if (!url || !/pbs\.twimg\.com\/media\//.test(url)) return url;
  const u = new URL(url);
  u.searchParams.set('name', 'large');
  return u.toString();
}

function mediaFromEntity(article, mediaId) {
  const m = (article.media_entities || []).find((x) => x.media_id === mediaId || x.id === mediaId);
  const info = m?.media_info;
  if (!info) return null;
  if (info.__typename === 'ApiImage') return { kind: 'image', url: largeTwimg(info.original_img_url) };
  const poster = info.media_url_https || info.media_url;
  return { kind: info.__typename === 'ApiGif' ? 'gif' : 'video', url: largeTwimg(poster), alt: info.ext_alt_text };
}

// ---------- Draft.js inline rendering ----------

const STYLE_TAGS = [
  ['code', 'code'],
  ['strikethrough', 's'],
  ['underline', 'u'],
  ['italic', 'em'],
  ['bold', 'strong'],
];

function renderInline(block, entities) {
  const styles = (block.inlineStyleRanges || []).map((r) => ({ ...r, style: String(r.style).toLowerCase() }));
  const ents = block.entityRanges || [];
  // X counts range offsets in code points, not UTF-16 units: a Bold range of length 1 covers "𝕏" (2 units).
  // Slice by code point; fall back to UTF-16 units only if some range does not fit the code-point length.
  const cps = Array.from(block.text || '');
  const fitsCp = [...styles, ...ents].every((r) => r.offset + r.length <= cps.length);
  const text = fitsCp ? cps : (block.text || '').split('');
  const n = text.length;
  const cuts = new Set([0, n]);
  for (const r of [...styles, ...ents]) {
    cuts.add(Math.max(0, Math.min(n, r.offset)));
    cuts.add(Math.max(0, Math.min(n, r.offset + r.length)));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  let openHref = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a === b) continue;
    const active = styles.filter((r) => r.offset <= a && r.offset + r.length >= b).map((r) => r.style);
    const er = ents.find((r) => r.offset <= a && r.offset + r.length >= b);
    const ent = er ? entities.get(String(er.key)) : null;
    const href = ent && ent.type === 'LINK' ? ent.data?.url : null;
    if (openHref !== href) {
      if (openHref) html += '</a>';
      if (href) html += `<a href="${escapeHtml(href)}">`;
      openHref = href;
    }
    let seg = escapeHtml(text.slice(a, b).join('')).replace(/\n/g, '<br>');
    for (const [style, tag] of STYLE_TAGS) if (active.includes(style)) seg = `<${tag}>${seg}</${tag}>`;
    html += seg;
  }
  if (openHref) html += '</a>';
  return html;
}

// ---------- Embedded posts ----------

function postCard(s, { heading = true } = {}) {
  const a = s.author || {};
  const when = s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : '';
  const text = escapeHtml(s.text || '')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
  const photos = (s.media?.photos || []).map(
    (p) => `<figure><img src="${escapeHtml(largeTwimg(p.url))}" alt="${escapeHtml(p.altText || '')}"></figure>`,
  );
  const videos = (s.media?.videos || []).map(
    (v) =>
      `<figure><img src="${escapeHtml(v.thumbnail_url)}" alt=""><figcaption>Video (${Math.round(
        v.duration || 0,
      )} s) — watch on X: ${escapeHtml(s.url)}</figcaption></figure>`,
  );
  const meta = heading
    ? `<p class="post-meta"><strong>${escapeHtml(a.name || '')}</strong> @${escapeHtml(a.screen_name || '')} · ${when}</p>`
    : '';
  const quote = s.quote ? postCard(s.quote) : '';
  // A post that shares an X Article has empty text: show the article's title, opening and cover instead.
  let article = '';
  if (s.article) {
    const a = s.article;
    const prev = (a.preview_text || '').replace(/\s+/g, ' ').trim();
    const cover = a.cover_media?.media_info?.original_img_url;
    article = `<p><strong>${escapeHtml(a.title || 'X Article')}</strong></p>${prev ? `<p>${escapeHtml(prev.length > 280 ? prev.slice(0, 277) + '…' : prev)}</p>` : ''}${
      cover ? `<figure><img src="${escapeHtml(largeTwimg(cover))}" alt=""></figure>` : ''
    }`;
  }
  return `<aside class="embed-post">${meta}${text ? `<p>${text}</p>` : ''}${article}${photos.join('')}${videos.join('')}${quote}<p class="post-link">${escapeHtml(
    s.url || '',
  )}</p></aside>`;
}

async function renderEmbeddedPost(tweetId, warnings) {
  const body = await getStatus(tweetId);
  if (body.code !== 200 || !body.status) {
    warnings.push(`embedded post ${tweetId} could not be fetched (${body.code} ${body.message || ''}); kept as a link`);
    return `<aside class="embed-post"><p>Embedded post: https://x.com/i/status/${tweetId}</p></aside>`;
  }
  return postCard(body.status);
}

// ---------- Article (Draft.js) ----------

async function renderArticle(article, warnings) {
  const content = article.content || {};
  const blocks = content.blocks || [];
  const entities = new Map();
  for (const e of content.entityMap || []) entities.set(String(e.key), e.value || {});

  const out = [];
  let list = null; // { tag, items: [] }
  let quote = [];
  let code = [];
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    if (quote.length) out.push(`<blockquote>${quote.map((q) => `<p>${q}</p>`).join('')}</blockquote>`);
    if (code.length) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    list = null;
    quote = [];
    code = [];
  };

  for (const b of blocks) {
    const t = b.type;
    if (t !== 'unordered-list-item' && t !== 'ordered-list-item' && list) flush();
    if (t !== 'blockquote' && quote.length) flush();
    if (t !== 'code-block' && code.length) flush();

    if (t === 'unordered-list-item' || t === 'ordered-list-item') {
      const tag = t === 'ordered-list-item' ? 'ol' : 'ul';
      if (list && list.tag !== tag) flush();
      if (!list) list = { tag, items: [] };
      list.items.push(renderInline(b, entities));
    } else if (t === 'blockquote') {
      quote.push(renderInline(b, entities));
    } else if (t === 'code-block') {
      code.push(escapeHtml(b.text));
    } else if (t === 'header-one') {
      out.push(`<h2>${renderInline(b, entities)}</h2>`);
    } else if (t === 'header-two') {
      out.push(`<h3>${renderInline(b, entities)}</h3>`);
    } else if (t === 'header-three' || t === 'header-four') {
      out.push(`<h4>${renderInline(b, entities)}</h4>`);
    } else if (t === 'atomic') {
      for (const r of b.entityRanges || []) {
        const ent = entities.get(String(r.key));
        if (!ent) continue;
        if (ent.type === 'MEDIA') {
          for (const item of ent.data?.mediaItems || []) {
            const m = mediaFromEntity(article, item.mediaId);
            if (!m) {
              warnings.push(`article image ${item.mediaId} not found in media_entities; skipped`);
              continue;
            }
            const cap = m.kind === 'image' ? '' : `<figcaption>${m.kind === 'gif' ? 'Animated GIF' : 'Video'} — play it on X</figcaption>`;
            out.push(`<figure><img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt || '')}">${cap}</figure>`);
          }
        } else if (ent.type === 'DIVIDER') {
          out.push('<hr>');
        } else if (ent.type === 'TWEET') {
          out.push(await renderEmbeddedPost(ent.data?.tweetId, warnings));
        } else if (ent.type === 'MARKDOWN') {
          const md = String(ent.data?.markdown || '');
          const fence = md.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
          out.push(fence ? `<pre><code>${escapeHtml(fence[1])}</code></pre>` : `<pre class="markdown">${escapeHtml(md)}</pre>`);
        } else if (ent.type === 'LINK') {
          out.push(`<p><a href="${escapeHtml(ent.data?.url)}">${escapeHtml(ent.data?.url)}</a></p>`);
        } else {
          warnings.push(`unknown article block entity "${ent.type}"; skipped`);
        }
      }
    } else {
      if (t !== 'unstyled') warnings.push(`unknown article block type "${t}"; rendered as a paragraph`);
      if ((b.text || '').trim()) out.push(`<p>${renderInline(b, entities)}</p>`);
    }
  }
  flush();
  return out.join('\n');
}

// ---------- Entry point ----------

export async function fromX(input) {
  const parsed = parseXUrl(input);
  if (!parsed) fail(`not a post or article link: ${input}`, 'Use a link like https://x.com/<user>/status/<id> or https://x.com/<user>/article/<id>.', 2);
  const warnings = [];
  const body = await getStatus(parsed.id);
  if (body.code !== 200 || !body.status) {
    if (parsed.bareArticle)
      fail(
        `the bare article link ${input} cannot be resolved (FxTwitter answered ${body.code}).`,
        'Open the article on X and copy the link of the post that shares it (x.com/<user>/status/<id>), then run again.',
        2,
      );
    if (body.code === 0)
      fail(`could not reach the FxTwitter API at ${API} (${body.message}).`, 'Check the internet connection, or retry in a minute; the service is a free community API.', 1);
    fail(
      `X post ${parsed.id} is not available (FxTwitter ${body.code}: ${body.message || 'no message'}).`,
      'Only public posts work. Check the link in a browser; private, deleted or age-restricted posts cannot be fetched.',
      2,
    );
  }
  const s = body.status;
  const author = s.author || {};
  const sourceUrl = `https://x.com/${author.screen_name || 'i'}/status/${s.id}`;
  const base = {
    siteName: 'X',
    byline: author.name ? `${author.name} (@${author.screen_name})` : '',
    published: s.article?.created_at || (s.created_at ? new Date(s.created_at).toISOString() : ''),
    sourceUrl,
    lang: s.lang && s.lang !== 'zxx' ? s.lang : 'en',
    warnings,
  };

  if (s.article) {
    const a = s.article;
    const cover = a.cover_media?.media_info;
    return {
      ...base,
      kind: 'x-article',
      title: a.title || 'Untitled X article',
      coverUrl: cover?.__typename === 'ApiImage' ? largeTwimg(cover.original_img_url) : largeTwimg(cover?.media_url_https) || null,
      bodyHtml: await renderArticle(a, warnings),
    };
  }

  // Plain post: unroll the author's own thread when FxTwitter knows it.
  let posts = [s];
  const thread = await getStatus(parsed.id, 'thread');
  if (thread.code === 200 && Array.isArray(thread.thread) && thread.thread.length > 1) {
    const own = thread.thread.filter((p) => p.author?.screen_name === author.screen_name);
    if (own.length > 1) posts = own;
  } else if (thread.code !== 200) {
    warnLine(`thread lookup failed (${thread.code}); using the single post`);
  }
  const first = (s.text || '').split('\n').find((l) => l.trim()) || 'Post';
  const title = first.length > 90 ? first.slice(0, 87).trimEnd() + '…' : first;
  return {
    ...base,
    kind: posts.length > 1 ? 'x-thread' : 'x-post',
    title: posts.length > 1 ? `${title} (thread)` : title,
    coverUrl: null,
    bodyHtml: posts.map((p) => postCard(p, { heading: posts.length === 1 })).join('\n'),
  };
}
