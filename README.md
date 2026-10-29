# Quantity

The H Heuristics shelf for reports, dashboards, and projects. Built to hold hundreds or thousands of pieces. Each piece is a folder. The site generates the catalog, the reading page, and the metadata record that search engines and citation indexes read.

## Add a piece

Create `content/items/<slug>/` with `item.json`. Copy `content/_template/item.json` if you want the fields in front of you.

A piece is not published unless it has a title, date, author, abstract (`summary`), at least one keyword, at least one topic, and a licence. Those fields are what indexes use.

| File | Role |
| --- | --- |
| `item.json` | Metadata record |
| `body.md` | Reading text, optional |
| `source.pdf` | Original document, optional |
| `board.html` | Experimental dashboard, optional. Self-contained HTML |

`type` is `report`, `dashboard`, `project`, or `note`. `status` is `published`, `experimental`, or `draft`. Drafts are built but left out of the catalog, sitemap, and search indexes.

From a text PDF:

```bash
python3 scripts/pdf_to_md.py content/items/<slug>/source.pdf content/items/<slug>/body.md
```

Set `url` in `site.json` to the live origin, with no trailing slash, before you care about citation links. Absolute URLs in the citation tags are filled from that field.

## Metadata each page emits

Visible sheet, matching the H Heuristics record: keywords, topics, classification, data and method, report line, licence, cite as.

Machine-readable, on the same page:

- Highwire / Google Scholar tags (`citation_title`, `citation_author`, `citation_publication_date`, `citation_abstract`, `citation_keywords`, `citation_pdf_url`, `citation_technical_report_institution`)
- Dublin Core
- Open Graph and Twitter card
- schema.org JSON-LD (`ScholarlyArticle` for reports)
- `metadata.json` beside the page
- `/catalog.json`, `/sitemap.xml`, `/feed.xml`

## Build and Cloudflare

```bash
node scripts/build.mjs
```

Output is `dist/`. No install step.

On Cloudflare Pages, connect this GitHub repo and set:

- Build command: `node scripts/build.mjs`
- Build output directory: `dist`
- Production branch: `main`

Or upload a build directly:

```bash
npx wrangler pages deploy dist --project-name quantity-h-heuristics
```
