import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const PAGE_SIZE = 48;
const TYPES = ["report", "dashboard", "project", "note"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const site = JSON.parse(await readFile(path.join(root, "site.json"), "utf8"));
site.url = (site.url || "").replace(/\/$/, "");

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function absUrl(pathname) {
  if (!site.url) return pathname;
  return site.url + pathname;
}

function formatDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function authorsOf(item) {
  if (Array.isArray(item.authors) && item.authors.length) return item.authors;
  if (item.author) return [item.author];
  return [];
}

function reportLine(item) {
  if (item.reportLine) return item.reportLine;
  const when = `Published ${formatDate(item.date)}`;
  if (item.reportNumber) return `H Heuristics Digital Report Nº ${item.reportNumber} · ${when}`;
  if (item.series) return `H Heuristics ${item.series} · ${when}`;
  const label = item.type.charAt(0).toUpperCase() + item.type.slice(1);
  return `H Heuristics ${label} · ${when}`;
}

function citeAs(item) {
  if (item.citeAs) return item.citeAs;
  const year = item.date.slice(0, 4);
  const author = authorsOf(item).join(", ");
  const title = item.subtitle ? `${item.title}: ${item.subtitle}` : item.title;
  const venue = item.series ? `H Heuristics ${item.series}` : site.imprint;
  const url = absUrl(item.path);
  return `${author} (${year}). ${title}. ${venue}. ${url}`;
}

function validate(raw, slug) {
  const missing = [];
  if (!raw.title) missing.push("title");
  if (!TYPES.includes(raw.type)) missing.push("type");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date || "")) missing.push("date");
  if (!authorsOf(raw).length) missing.push("author");
  if (!raw.summary || String(raw.summary).trim().length < 40) missing.push("summary");
  if (!Array.isArray(raw.keywords) || raw.keywords.filter(Boolean).length === 0) missing.push("keywords");
  if (!Array.isArray(raw.topics) || raw.topics.filter(Boolean).length === 0) missing.push("topics");
  if (!raw.licence?.name) missing.push("licence.name");
  if (raw.status && !["published", "draft", "experimental"].includes(raw.status)) missing.push("status");
  if (missing.length) {
    throw new Error(`${slug}: missing or invalid ${missing.join(", ")}`);
  }
}

function inline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html = [];
  const toc = [];
  const used = new Map();
  let i = 0;
  let para = [];

  const flush = () => {
    if (!para.length) return;
    html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };

  const headingId = (text) => {
    const base = slugify(text) || "section";
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = headingId(text);
      if (level === 1) toc.push({ text, id });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      const parts = quote.filter((part) => part.trim()).map((part) => `<p>${inline(part)}</p>`).join("");
      html.push(`<blockquote>${parts}</blockquote>`);
      continue;
    }
    if (line.startsWith("|")) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").slice(1, -1).map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
        i += 1;
      }
      const head = rows[0] || [];
      const body = rows.slice(1);
      html.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${body
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flush();
  return { html: html.join("\n"), toc };
}

function jsonLd(data) {
  return JSON.stringify(data).replaceAll("<", "\\u003c");
}

function head({ title, description, path: pathname, item, robots = "index,follow" }) {
  const canonical = absUrl(pathname);
  const tags = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<link rel="alternate" type="application/json" href="${esc(absUrl("/catalog.json"))}" title="Quantity catalog">`,
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:type" content="${item ? "article" : "website"}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">`,
    `<link rel="stylesheet" href="/assets/site.css">`,
  ];

  if (item) {
    const authors = authorsOf(item);
    const keywords = item.keywords.join(", ");
    const pdfUrl = item.pdf ? absUrl(`${item.path}${item.pdf}`) : "";
    tags.push(
      `<meta name="author" content="${esc(authors.join(", "))}">`,
      `<meta name="keywords" content="${esc(keywords)}">`,
      `<meta name="citation_title" content="${esc(item.subtitle ? `${item.title}: ${item.subtitle}` : item.title)}">`,
      ...authors.map((author) => `<meta name="citation_author" content="${esc(author)}">`),
      `<meta name="citation_publication_date" content="${esc(item.date.replaceAll("-", "/"))}">`,
      `<meta name="citation_online_date" content="${esc(item.date.replaceAll("-", "/"))}">`,
      `<meta name="citation_abstract" content="${esc(item.summary)}">`,
      `<meta name="citation_keywords" content="${esc(keywords)}">`,
      `<meta name="citation_language" content="${esc(item.language || "en")}">`,
      `<meta name="citation_publisher" content="${esc(site.imprint)}">`,
      `<meta name="citation_technical_report_institution" content="${esc(site.imprint)}">`,
      `<meta name="citation_abstract_html_url" content="${esc(canonical)}">`,
      `<meta name="citation_fulltext_html_url" content="${esc(canonical)}">`,
      `<meta name="DC.title" content="${esc(item.title)}">`,
      ...authors.map((author) => `<meta name="DC.creator" content="${esc(author)}">`),
      `<meta name="DC.date" content="${esc(item.date)}">`,
      `<meta name="DC.description" content="${esc(item.summary)}">`,
      `<meta name="DC.subject" content="${esc(keywords)}">`,
      `<meta name="DC.publisher" content="${esc(site.imprint)}">`,
      `<meta name="DC.type" content="Text">`,
      `<meta name="DC.language" content="${esc(item.language || "en")}">`,
      `<meta name="DC.identifier" content="${esc(canonical)}">`,
      `<meta name="DC.rights" content="${esc(item.licence.name)}">`,
      `<meta property="article:published_time" content="${esc(item.date)}">`,
      ...item.keywords.map((keyword) => `<meta property="article:tag" content="${esc(keyword)}">`),
      `<link rel="alternate" type="application/json" href="${esc(absUrl(`${item.path}metadata.json`))}" title="Item metadata">`,
    );
    if (item.reportNumber) {
      tags.push(`<meta name="citation_technical_report_number" content="${esc(item.reportNumber)}">`);
    }
    if (item.series) tags.push(`<meta name="DC.relation" content="${esc(item.series)}">`);
    if (pdfUrl) {
      tags.push(
        `<meta name="citation_pdf_url" content="${esc(pdfUrl)}">`,
        `<link rel="alternate" type="application/pdf" href="${esc(pdfUrl)}">`,
      );
    }

    const linkedData = {
      "@context": "https://schema.org",
      "@type": item.type === "report" ? "ScholarlyArticle" : "CreativeWork",
      headline: item.title,
      name: item.title,
      alternativeHeadline: item.subtitle || undefined,
      abstract: item.summary,
      description: item.summary,
      author: authors.map((name) => ({
        "@type": "Person",
        name,
        affiliation: { "@type": "Organization", name: site.imprint },
      })),
      publisher: { "@type": "Organization", name: site.imprint },
      datePublished: item.date,
      inLanguage: item.language || "en",
      keywords,
      about: item.topics.map((name) => ({ "@type": "Thing", name })),
      license: item.licence.url || item.licence.name,
      url: canonical,
      citation: citeAs(item),
      isPartOf: item.series ? { "@type": "CreativeWorkSeries", name: item.series } : undefined,
      identifier: item.reportNumber || undefined,
      encoding: pdfUrl
        ? { "@type": "MediaObject", contentUrl: pdfUrl, encodingFormat: "application/pdf" }
        : undefined,
    };
    for (const key of Object.keys(linkedData)) {
      if (linkedData[key] === undefined) delete linkedData[key];
    }
    tags.push(`<script type="application/ld+json">${jsonLd(linkedData)}</script>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
${tags.join("\n")}
</head>`;
}

function shell({ title, description, path: pathname, item, robots, body, script = false }) {
  const counts = new Map();
  return `${head({ title, description, path: pathname, item, robots })}
<body id="top">
  <header class="site-header"><div class="wrap">
    <a class="brand" href="/">
      <span class="brand-name">${esc(site.name)}</span>
      <span class="brand-imprint">${esc(site.imprint)}</span>
    </a>
    <nav aria-label="Shelf">${NAV}</nav>
  </div></header>
  <main class="wrap">
    ${body}
  </main>
  <footer class="site-footer"><div class="wrap">${esc(site.imprint)} · ${esc(site.name)}</div></footer>
  ${script ? `<script type="module" src="/assets/site.js"></script>` : ""}
</body>
</html>`;
  void counts;
}

let NAV = "";

function card(item) {
  const chips = item.keywords.slice(0, 6).map((keyword) => `<span class="chip">${esc(keyword)}</span>`).join("");
  return `<a class="card" href="${esc(item.path)}">
    <div class="card-kicker"><span class="kind">${esc(item.type)}</span><span>${esc(formatDate(item.date))}</span></div>
    <h2>${esc(item.title)}</h2>
    <p>${esc(item.summary)}</p>
    <div class="chips">${chips}</div>
  </a>`;
}

function metadataSheet(item) {
  const keywords = item.keywords
    .map((keyword) => `<a class="chip" href="/keywords/${esc(slugify(keyword))}/">${esc(keyword)}</a>`)
    .join("");
  const topics = item.topics
    .map((topic) => `<a href="/topics/${esc(slugify(topic))}/">${esc(topic)}</a>`)
    .join("");
  const rows = [
    `<div class="sheet-row"><div class="sheet-label mark">Metadata</div><div></div></div>`,
    `<div class="sheet-row"><div class="sheet-label">Keywords</div><div class="chips">${keywords}</div></div>`,
    `<div class="sheet-row"><div class="sheet-label">Topics</div><div class="topics">${topics}</div></div>`,
  ];
  if (item.classification?.codes?.length) {
    const scheme = item.classification.scheme || "Classification";
    const codes = item.classification.codes
      .map((code) => `<a href="/classification/${esc(slugify(scheme))}/${esc(code)}/">${esc(code)}</a>`)
      .join(", ");
    const gloss = item.classification.gloss ? ` — ${esc(item.classification.gloss)}` : "";
    rows.push(
      `<div class="sheet-row"><div class="sheet-label">${esc(scheme)} classification</div><div class="sheet-value">${codes}${gloss}</div></div>`,
    );
  }
  if (item.dataAndMethod) {
    rows.push(
      `<div class="sheet-row"><div class="sheet-label">Data and method</div><div class="sheet-value">${esc(item.dataAndMethod)}</div></div>`,
    );
  }
  const licence = item.licence.url
    ? `<a href="${esc(item.licence.url)}">${esc(item.licence.name)}</a>`
    : esc(item.licence.name);
  const note = item.licence.note ? `<span class="sheet-note">${esc(item.licence.note)}</span>` : "";
  rows.push(
    `<div class="sheet-row"><div class="sheet-label">Report</div><div class="sheet-value">${esc(reportLine(item))}</div></div>`,
    `<div class="sheet-row"><div class="sheet-label">Licence</div><div class="sheet-value">${licence}${note}</div></div>`,
    `<div class="sheet-row"><div class="sheet-label">Cite as</div><div class="sheet-value cite">${esc(citeAs(item))}</div></div>`,
  );
  return `<section class="sheet" id="metadata" aria-label="Metadata">${rows.join("")}</section>
  <p class="back"><a href="#top">Back to top</a></p>`;
}

async function writePage(pathname, html) {
  const file = path.join(dist, pathname.replace(/^\//, ""), "index.html");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, html);
}

function pager(base, page, pages) {
  if (pages <= 1) return "";
  const href = (n) => (n === 1 ? `${base}` : `${base}page/${n}/`);
  const links = [];
  if (page > 1) links.push(`<a href="${href(page - 1)}">Previous</a>`);
  links.push(`<span>${page} / ${pages}</span>`);
  if (page < pages) links.push(`<a href="${href(page + 1)}">Next</a>`);
  return `<nav class="pager" aria-label="Pages">${links.join("")}</nav>`;
}

async function writeList({ base, title, description, items }) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const urls = [];
  for (let page = 1; page <= pages; page += 1) {
    const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const pathname = page === 1 ? base : `${base}page/${page}/`;
    const cards = slice.map(card).join("");
    const html = shell({
      title: page === 1 ? title : `${title} · page ${page}`,
      description,
      path: pathname,
      body: `<h1>${esc(title)}</h1><p class="lede">${esc(description)}</p><div class="shelf">${cards || `<p class="empty">Nothing here yet.</p>`}</div>${pager(base, page, pages)}`,
    });
    await writePage(pathname, html);
    urls.push(pathname);
  }
  return urls;
}

async function loadItems() {
  const dir = path.join(root, "content", "items");
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const slug = entry.name;
    const folder = path.join(dir, slug);
    const raw = JSON.parse(await readFile(path.join(folder, "item.json"), "utf8"));
    validate(raw, slug);
    let body = "";
    try {
      body = await readFile(path.join(folder, "body.md"), "utf8");
    } catch { /* optional */ }
    let board = false;
    try {
      await stat(path.join(folder, "board.html"));
      board = true;
    } catch { /* optional */ }
    const pdfName = raw.pdf || "source.pdf";
    let pdf = null;
    try {
      await stat(path.join(folder, pdfName));
      pdf = pdfName;
    } catch { /* optional */ }

    const item = {
      ...raw,
      slug,
      path: `/i/${slug}/`,
      status: raw.status || "published",
      language: raw.language || "en",
      keywords: raw.keywords.map((keyword) => String(keyword).trim()).filter(Boolean),
      topics: raw.topics.map((topic) => String(topic).trim()).filter(Boolean),
      body,
      board,
      pdf,
      folder,
    };
    items.push(item);
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));
  return items;
}

async function copyTree(from, to) {
  const entries = await readdir(from, { withFileTypes: true });
  await mkdir(to, { recursive: true });
  for (const entry of entries) {
    if (entry.name === "item.json" || entry.name === "body.md") continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest);
    else await copyFile(src, dest);
  }
}

const items = await loadItems();
const live = items.filter((item) => item.status !== "draft");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "assets"), { recursive: true });
await copyFile(path.join(root, "src", "site.css"), path.join(dist, "assets", "site.css"));
await copyFile(path.join(root, "src", "site.js"), path.join(dist, "assets", "site.js"));

const typeCounts = Object.fromEntries(TYPES.map((type) => [type, live.filter((item) => item.type === type).length]));
const navBits = [`<a href="/">Shelf</a>`];
for (const type of TYPES) {
  if (typeCounts[type]) navBits.push(`<a href="/${type}s/">${type[0].toUpperCase()}${type.slice(1)}s</a>`);
}
navBits.push(`<a href="/topics/">Topics</a>`, `<a href="/keywords/">Keywords</a>`, `<a href="/browse/">Search</a>`);
NAV = `<ul class="nav">${navBits.map((bit) => `<li>${bit}</li>`).join("")}</ul>`;

const sitemap = ["/", "/browse/", "/topics/", "/keywords/", "/feed.xml"];

const homeItems = live.slice(0, PAGE_SIZE);
const countLine = TYPES.filter((type) => typeCounts[type])
  .map((type) => `<li><strong>${typeCounts[type]}</strong> ${type}${typeCounts[type] === 1 ? "" : "s"}</li>`)
  .join("");
const home = shell({
  title: `${site.name} · ${site.imprint}`,
  description: site.description,
  path: "/",
  body: `<p class="lede">${esc(site.description)} Every piece carries a metadata record so it can be cited and indexed.</p>
    <form class="search" action="/browse/" method="get">
      <input id="q" name="q" type="search" placeholder="Search titles, keywords, topics, classification" aria-label="Search the shelf">
      <button type="submit">Search</button>
    </form>
    <ul class="counts">${countLine}</ul>
    <div class="shelf">${homeItems.map(card).join("") || `<p class="empty">The shelf is empty.</p>`}</div>`,
});
await writeFile(path.join(dist, "index.html"), home);
if (live.length > PAGE_SIZE) {
  sitemap.push(...(await writeList({
    base: "/all/",
    title: "All pieces",
    description: "Every published piece on the shelf.",
    items: live,
  })));
}

for (const type of TYPES) {
  const group = live.filter((item) => item.type === type);
  if (!group.length) continue;
  const label = `${type[0].toUpperCase()}${type.slice(1)}s`;
  sitemap.push(...(await writeList({
    base: `/${type}s/`,
    title: label,
    description: `${label} on the ${site.name} shelf.`,
    items: group,
  })));
}

function groupBy(list, pick) {
  const groups = new Map();
  for (const item of list) {
    for (const value of pick(item)) {
      const key = typeof value === "string" ? value : value.key;
      const label = typeof value === "string" ? value : value.label;
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key).items.push(item);
    }
  }
  return [...groups.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
}

const topics = groupBy(live, (item) => item.topics.map((topic) => ({ key: slugify(topic), label: topic })));
const topicIndex = topics
  .map(([, group]) => `<li><a href="/topics/${esc(slugify(group.label))}/">${esc(group.label)}</a> · ${group.items.length}</li>`)
  .join("");
await writePage("/topics/", shell({
  title: `Topics · ${site.name}`,
  description: "Topics across the Quantity shelf.",
  path: "/topics/",
  body: `<h1>Topics</h1><ul class="index-list">${topicIndex}</ul>`,
}));
for (const [key, group] of topics) {
  sitemap.push(...(await writeList({
    base: `/topics/${key}/`,
    title: group.label,
    description: `Pieces tagged with the topic ${group.label}.`,
    items: group.items,
  })));
}

const keywords = groupBy(live, (item) => item.keywords.map((keyword) => ({ key: slugify(keyword), label: keyword })));
const keywordIndex = keywords
  .map(([, group]) => `<li><a href="/keywords/${esc(slugify(group.label))}/">${esc(group.label)}</a> · ${group.items.length}</li>`)
  .join("");
await writePage("/keywords/", shell({
  title: `Keywords · ${site.name}`,
  description: "Keywords across the Quantity shelf.",
  path: "/keywords/",
  body: `<h1>Keywords</h1><ul class="index-list">${keywordIndex}</ul>`,
}));
for (const [key, group] of keywords) {
  sitemap.push(...(await writeList({
    base: `/keywords/${key}/`,
    title: group.label,
    description: `Pieces tagged with the keyword ${group.label}.`,
    items: group.items,
  })));
}

const classes = groupBy(live, (item) => {
  const scheme = item.classification?.scheme;
  const codes = item.classification?.codes || [];
  if (!scheme) return [];
  return codes.map((code) => ({ key: `${slugify(scheme)}/${code}`, label: `${scheme} ${code}` }));
});
for (const [key, group] of classes) {
  sitemap.push(...(await writeList({
    base: `/classification/${key}/`,
    title: group.label,
    description: `Pieces classified ${group.label}.`,
    items: group.items,
  })));
}

const seriesGroups = groupBy(live, (item) => (item.series ? [{ key: slugify(item.series), label: item.series }] : []));
for (const [key, group] of seriesGroups) {
  sitemap.push(...(await writeList({
    base: `/series/${key}/`,
    title: group.label,
    description: `Pieces in ${group.label}.`,
    items: group.items,
  })));
}

const catalogItems = live.map((item) => ({
  title: item.title,
  subtitle: item.subtitle || "",
  summary: item.summary,
  type: item.type,
  status: item.status,
  date: item.date,
  dateDisplay: formatDate(item.date),
  authors: authorsOf(item),
  keywords: item.keywords,
  topics: item.topics,
  classification: item.classification || null,
  series: item.series || "",
  reportNumber: item.reportNumber || "",
  licence: item.licence,
  path: item.path,
  pdf: item.pdf ? `${item.path}${item.pdf}` : "",
  citeAs: citeAs(item),
  search: [
    item.title, item.subtitle, item.summary, item.series, item.type,
    ...authorsOf(item), ...item.keywords, ...item.topics,
    ...(item.classification?.codes || []), item.classification?.gloss || "",
  ].join(" ").toLowerCase(),
}));

await writeFile(path.join(dist, "catalog.json"), JSON.stringify({
  name: site.name,
  imprint: site.imprint,
  url: site.url,
  generated: new Date().toISOString(),
  count: catalogItems.length,
  items: catalogItems,
}, null, 2));

const browse = shell({
  title: `Search · ${site.name}`,
  description: "Search the Quantity shelf by title, keyword, topic, or classification.",
  path: "/browse/",
  script: true,
  body: `<h1>Search</h1>
    <form class="search" action="/browse/" method="get" role="search">
      <input id="q" name="q" type="search" placeholder="Title, keyword, topic, author, JEL code" aria-label="Search">
      <select id="type" name="type" aria-label="Type">
        <option value="">All types</option>
        ${TYPES.map((type) => `<option value="${type}">${type[0].toUpperCase()}${type.slice(1)}s</option>`).join("")}
      </select>
      <button type="submit">Search</button>
    </form>
    <div data-catalog><noscript><p>Search needs JavaScript. The <a href="/reports/">reports</a>, <a href="/topics/">topics</a>, and <a href="/keywords/">keywords</a> indexes are plain HTML.</p></noscript></div>`,
});
await writePage("/browse/", browse);

for (const item of items) {
  const rendered = item.body ? renderMarkdown(item.body) : { html: "", toc: [] };
  const robots = item.status === "draft" ? "noindex,nofollow" : "index,follow";
  const fullTitle = item.subtitle ? `${item.title}: ${item.subtitle}` : item.title;
  const toc = rendered.toc.length
    ? `<nav class="contents" aria-label="Contents"><div class="kicker">Contents</div><ol>${rendered.toc
        .map((entry) => `<li><a href="#${esc(entry.id)}">${esc(entry.text)}</a></li>`)
        .join("")}</ol></nav>`
    : "";
  const links = (item.links || [])
    .map((link) => `<a class="btn" href="${esc(link.href)}">${esc(link.label)}</a>`)
    .join("");
  const pdfLink = item.pdf ? `<a class="btn" href="${esc(item.pdf)}">Source PDF</a>` : "";
  const boardLink = item.board ? `<a class="btn" href="board/">Open dashboard</a>` : "";
  const role = item.authorRole ? `, ${esc(item.authorRole)}` : "";
  const pdfBlock = item.pdf
    ? `<section class="pdf-block" id="pdf"><h2>Source PDF</h2><p><a href="${esc(item.pdf)}">Download the original PDF</a>${item.pages ? ` · ${esc(item.pages)} pages` : ""}</p><iframe src="${esc(item.pdf)}" title="${esc(item.title)} PDF"></iframe></section>`
    : "";
  const page = shell({
    title: `${item.title} · ${site.name}`,
    description: item.summary,
    path: item.path,
    item: item.status === "draft" ? null : item,
    robots,
    body: `<article class="record">
      <p class="kicker">${esc(item.type)}${item.series ? ` · ${esc(item.series)}` : ""}${item.status === "published" ? "" : ` · ${esc(item.status)}`}</p>
      <h1>${esc(item.title)}</h1>
      ${item.subtitle ? `<p class="subtitle">${esc(item.subtitle)}</p>` : ""}
      <p class="byline">${esc(authorsOf(item).join(", "))}${role} · ${esc(formatDate(item.date))}</p>
      <p class="standfirst">${esc(item.summary)}</p>
      <div class="actions">${pdfLink}${boardLink}${links}<a href="#metadata">Metadata</a></div>
      ${toc}
      <div class="prose">${rendered.html}</div>
      ${pdfBlock}
      ${metadataSheet(item)}
    </article>`,
  });
  await writePage(item.path, page);
  if (item.status !== "draft") sitemap.push(item.path);

  const record = {
    title: item.title,
    subtitle: item.subtitle || "",
    abstract: item.summary,
    authors: authorsOf(item),
    datePublished: item.date,
    keywords: item.keywords,
    topics: item.topics,
    classification: item.classification || null,
    dataAndMethod: item.dataAndMethod || "",
    report: reportLine(item),
    licence: item.licence,
    citeAs: citeAs(item),
    type: item.type,
    status: item.status,
    series: item.series || "",
    reportNumber: item.reportNumber || "",
    language: item.language,
    publisher: site.imprint,
    path: item.path,
    url: absUrl(item.path),
    pdf: item.pdf ? absUrl(`${item.path}${item.pdf}`) : "",
  };
  await writeFile(path.join(dist, "i", item.slug, "metadata.json"), JSON.stringify(record, null, 2));
  await copyTree(item.folder, path.join(dist, "i", item.slug));

  if (item.board) {
    const board = `${head({
      title: `${item.title} · dashboard`,
      description: item.summary,
      path: `${item.path}board/`,
      item,
      robots,
    })}
<body class="board-page">
  <a class="board-back" href="../">← ${esc(site.name)}</a>
  <iframe src="../board.html" title="${esc(item.title)} dashboard"></iframe>
</body></html>`;
    await mkdir(path.join(dist, "i", item.slug, "board"), { recursive: true });
    await writeFile(path.join(dist, "i", item.slug, "board", "index.html"), board);
    if (item.status !== "draft") sitemap.push(`${item.path}board/`);
  }
}

const feedItems = live.slice(0, 40).map((item) => `  <entry>
    <title>${esc(item.title)}</title>
    <link href="${esc(absUrl(item.path))}"/>
    <id>${esc(absUrl(item.path))}</id>
    <updated>${esc(item.date)}T00:00:00Z</updated>
    <summary>${esc(item.summary)}</summary>
    <author><name>${esc(authorsOf(item).join(", "))}</name></author>
  </entry>`).join("\n");
await writeFile(path.join(dist, "feed.xml"), `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(site.name)}</title>
  <link href="${esc(absUrl("/feed.xml"))}" rel="self"/>
  <link href="${esc(absUrl("/"))}"/>
  <updated>${new Date().toISOString()}</updated>
  <id>${esc(absUrl("/"))}</id>
${feedItems}
</feed>
`);

const uniqueUrls = [...new Set(sitemap)];
await writeFile(path.join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${uniqueUrls.map((pathname) => `  <url><loc>${esc(absUrl(pathname))}</loc></url>`).join("\n")}
</urlset>
`);
await writeFile(path.join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${absUrl("/sitemap.xml")}\n`);
await writeFile(path.join(dist, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/i/*/source.pdf
  X-Robots-Tag: index
  Content-Disposition: inline
`);
await writeFile(path.join(dist, "404.html"), shell({
  title: `Not found · ${site.name}`,
  description: "That page is not on the shelf.",
  path: "/404.html",
  robots: "noindex,nofollow",
  body: `<h1>Not on the shelf</h1><p class="lede"><a href="/">Back to Quantity</a></p>`,
}));

const sample = live[0];
if (sample) {
  const html = await readFile(path.join(dist, "i", sample.slug, "index.html"), "utf8");
  const required = [
    "citation_title",
    "citation_author",
    "citation_publication_date",
    "citation_abstract",
    "citation_keywords",
    "citation_pdf_url",
    "DC.title",
    "application/ld+json",
    "id=\"metadata\"",
    "Keywords",
    "Cite as",
    "Data and method",
  ];
  const absent = required.filter((needle) => !html.includes(needle));
  if (absent.length) throw new Error(`Metadata check failed: ${absent.join(", ")}`);
}

if (!site.url) {
  console.warn("site.json url is empty. Citation and canonical links are root-relative until you set the live origin.");
}
console.log(`built ${items.length} pieces (${live.length} indexed) → dist/`);
