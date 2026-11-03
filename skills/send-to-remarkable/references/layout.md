# Layout — page geometry, typography, fixing a bad page

Read this when a Step 3 page check fails, or when the user asks for another font size, device or link style. The stylesheet is `assets/article.css`. Page size, margins and base font size are set per device in `scripts/lib/render.mjs` → `DEVICES`.

## Page size per device

The page matches the panel exactly (pixels ÷ dpi × 25.4), so the PDF fills the screen with no letterbox at "fit page".

| `--device` | Tablet | Panel | Page (mm) | Base font |
| --- | --- | --- | --- | --- |
| `rm2` (default) | reMarkable 2 (and 1) | 1404 × 1872 @ 226 dpi | 157.8 × 210.4 | 11 pt |
| `rmpp` | Paper Pro | 1620 × 2160 @ 229 dpi | 179.7 × 239.6 | 11.5 pt |
| `move` | Paper Pro Move | 954 × 1696 @ 264 dpi | 91.8 × 163.2 | 9.5 pt |

`RM_DEVICE` sets the default device. Chrome rounds the size to whole points, so `pageSizeMm` reads about 157.6 × 210.2 for rm2; the script warns only beyond 1 mm.

## What the reader layout does

- **Masthead:** a rule, a kicker line (source · date), the title, the byline with reading time (230 words/min), then the cover image.
- **Body:** Charter (falling back to Iowan Old Style, then Georgia), justified, hyphenated by the page's `lang`, with a drop cap on the first long paragraph. Headings never end a page (`break-after: avoid`).
- **Black on white only.** Grey text and coloured links wash out on e-ink, so links are black and underlined.
- **Links → numbered notes:** each external link gets a superscript number, and a **Links** list at the end prints the URLs. Repeated URLs share a number. Links whose text is already the URL get no number. `--no-notes` turns this off.
- **Figures** never split across pages and are capped at 150 mm high. Captions stay with the figure.
- **Code** wraps (`pre-wrap`) instead of running off the page. **Tables** take the full width and repeat their header row on each page.
- **Footer** on every page except the first: short title on the left, `page / pages` on the right (CSS `@page` margin boxes, Chrome 131 or newer).
- **Colophon:** the source URL or file and the save date.
- **PDF outline:** headings become PDF bookmarks (`--generate-pdf-document-outline`), shown in the tablet's table of contents.

## Fixing a page that fails the check

| Symptom on the sheet | Cause | Fix |
| --- | --- | --- |
| Title printed twice | The body's first heading differs slightly from the title | Fine to keep. Otherwise edit the heading-drop rule in `prepareBody` |
| A page with one huge image and nothing else | A tall image hits the 150 mm cap with a page break before it | Expected for tall images; lower `figure img { max-height }` if the user minds |
| Blank page | An element with `break-before`, or an empty figure | Open the `html` file from the JSON in Chrome, find the element, report it |
| Text cut at the right edge | A long unbroken string (URL, hash) in a table cell | `td { word-break: break-all }` for that run, or leave and report |
| Wide table squeezed to unreadable | Many columns on 134 mm of text width | Use `--device rmpp`, or accept and report |
| `[Image not available]` box | Download failed (listed in `images.failed`) | Retry once. Hot-link protection or a dead URL cannot be fixed here |
| `��` or boxes instead of characters | An emoji or symbol split, or missing from every font | Check `references/sources.md` → code points; report the character if it persists |
| Wrong or missing text | Extraction, not layout | See `references/sources.md` |

Change `assets/article.css` only for a lasting preference the user states (it applies to every future article). Bump the skill's `metadata.version` when you do.

## Inspecting a PDF by hand

- `make_article.mjs` prints `pages`, `pageSizeMm`, `preview` (page 1 PNG, from `sips`) and `sheet` (all pages, from poppler `pdftoppm` + ImageMagick `magick`, or `null` without them).
- `pdfinfo <pdf>` shows the page count and size in points (157.8 mm = 447.3 pt).
- The run folder in the JSON (`workDir`) holds `article.html` and `images/`. Open the HTML in Chrome to inspect an element.
