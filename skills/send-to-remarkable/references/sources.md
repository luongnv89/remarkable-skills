# Sources — how each input is read

Read this when an extraction looks wrong or incomplete. Code: `scripts/lib/x.mjs`, `scripts/lib/web.mjs`, `scripts/lib/local.mjs`; shared cleanup in `scripts/lib/render.mjs` → `prepareBody`.

## X (x.com, twitter.com, fxtwitter, fixupx, vxtwitter)

- **API:** `GET https://api.fxtwitter.com/2/status/<id>` (public FxTwitter API, no X login, 1000 requests/min per IP). `FXTWITTER_API` overrides the base URL.
- **URL forms:** `/<user>/status/<id>` and `/<user>/article/<id>` carry the **post** id and work. `/i/article/<id>` carries the **article** id, which FxTwitter answers with 404, so the script exits 2 and asks for the post link. The post that shares an article usually has a bare `x.com/i/article/...` link as its only text.
- **Article** (`status.article`): title, `cover_media`, and `content` in Draft.js form (`blocks` + `entityMap`).

| Draft.js | Output |
| --- | --- |
| `unstyled` | `<p>` (empty blocks dropped) |
| `header-one` / `header-two` / `header-three` | `<h2>` / `<h3>` / `<h4>` (the title is the page's `<h1>`) |
| `unordered-list-item` / `ordered-list-item` | consecutive items grouped into `<ul>` / `<ol>` |
| `blockquote`, `code-block` | grouped `<blockquote>`, `<pre><code>` |
| `atomic` + `MEDIA` | `<figure><img>`; `mediaItems[].mediaId` ↔ `media_entities[].media_id` → `original_img_url` (`?name=large`). Video/GIF → poster + caption |
| `atomic` + `DIVIDER` | `<hr>` |
| `atomic` + `TWEET` | embedded-post card (second API call); a post that shares an Article shows its title, opening and cover |
| `atomic` + `MARKDOWN` | fenced code → `<pre><code>`; other Markdown → `<pre class="markdown">` |
| inline `Bold`/`Italic`/`Strikethrough`/`Underline`/`Code`, `LINK` entity | `<strong>`/`<em>`/`<s>`/`<u>`/`<code>`, `<a href>` |

- **Range offsets count code points, not UTF-16 units.** Verified on 2026-11-03: the block `"𝕏"` (two UTF-16 units) carries a Bold range of length 1. Slicing by UTF-16 splits the surrogate pair and prints `��`. `renderInline` slices by code point and falls back to UTF-16 only when a range does not fit the code-point length.
- **Plain post:** text, photos, video posters and quoted posts become cards. When `/2/thread/<id>` returns several posts by the same author, the thread is unrolled.
- **Limits:** public posts only. Private, deleted or age-gated posts exit 2. An FxTwitter outage exits 1 with a retry hint. Replies by other people are not included.
- **Unknown block or entity types** are reported in `warnings`, so a format change in X shows up instead of silently losing content.

## Web pages

1. Plain download with a desktop-browser User-Agent. A `Content-Type: application/pdf` reply is saved as is (pass-through).
2. Mozilla Readability (`@mozilla/readability` on jsdom) extracts the article. Lazy images get their real URL from `data-src`, `data-lazy-src`, `data-original` or `srcset` first.
3. Fewer than 150 words, a refused download (401/403) or no article → headless Chrome renders the page (`--dump-dom`, 15 s virtual time) and Readability runs again; the longer result wins. `--render` skips step 1.
4. Metadata: title, byline, site name and published time from Readability, falling back to `article:published_time`. `og:image` becomes the cover only when the body does not already contain that image. The canonical URL becomes the source line.
5. Fewer than 150 words in the final result → a warning (paywall, login or non-article page). The skill never works around a paywall or login. A saved `.html` from the user's own browser session is the supported route.

## Local files

| Type | Reading |
| --- | --- |
| `.md`, `.markdown` | pandoc (`markdown+autolink_bare_uris-tex_math_dollars`). Title: front matter `title`, else the first `# H1`, else the file name. `author` and `date` from front matter. |
| `.txt`, `.text` | No Markup interpretation. A short first line followed by a blank line becomes the title. Blank lines split paragraphs. Hard-wrapped lines are joined, but a block of short lines (verse, addresses) keeps its breaks. |
| `.html`, `.htm` | Readability with the file's folder as the base URL, so relative images resolve. A page without an article keeps its whole body (with a warning). |
| `.pdf` | Copied into the library unchanged. |

**Obsidian notes:** `![[image.png]]` and `![[image.png|300]]` embeds become images. The file is looked up next to the note first, then anywhere in the vault (the nearest parent folder holding `.obsidian/`). `[[note|alias]]` prints `alias`; `[[note]]` prints `note`. Embedded notes (`![[Other note]]`) print as a placeholder line. Images that cannot be found are listed in `warnings`.

## Shared cleanup (all sources)

- Removed: scripts, styles, forms and their controls, `<object>`/`<embed>`, tracking pixels (≤ 3 px), all `style`/`class` attributes except the skill's own classes.
- Kept as text: task-list checkboxes become ☐/☑. Removed: footnote back-links (↩).
- `<iframe>` → dashed box with its URL. `<video>`/`<audio>` → poster plus link.
- Every image is downloaded into the run folder (`images/`), so the PDF never depends on the network. Images over 1800 px are shrunk with `sips`. Failed downloads become a dashed `[Image not available]` box and are listed in `images.failed`.
- A first heading that repeats the title is dropped (the masthead prints it).
