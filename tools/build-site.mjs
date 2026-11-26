#!/usr/bin/env node
// Builds the website into an output folder (default _site/): the static site in docs/ copied as it is,
// plus one HTML page per Markdown doc in docs/ (docs/<name>.md -> /docs/<name>/, docs/README.md -> /docs/)
// and a sitemap listing every page. The Markdown files stay the only source of the documentation; the
// pages are generated at deploy time (.github/workflows/pages.yml) and never committed.
//
//   node tools/build-site.mjs [--out <dir>]
//
// A link in a doc to another doc becomes its page on the site; a link to ../README.md becomes the README
// on GitHub; a link to any other repository file becomes its blob/main URL on GitHub. The build fails
// when a relative link names a file or a #anchor that does not exist.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Marked, Renderer } from "marked";

export const SITE_URL = "https://drive-it.designs-os.com";
export const REPO_URL = "https://github.com/jedbjorn/drive-it";
const SOURCE_DIR = "docs";
const INDEX_DOC = "README.md";
const DOCS_PATH = "/docs/";

const ALERTS = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };

export class SiteBuildError extends Error {}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// GitHub's heading anchors (github-slugger): lowercase the heading's text, drop everything but letters,
// marks, numbers, connector punctuation (_), spaces and hyphens, turn each space into a hyphen, and give a
// repeated slug a -1, -2... suffix in document order.
export function createSlugger() {
  const occurrences = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    let slug = base;
    while (occurrences.has(slug)) {
      occurrences.set(base, occurrences.get(base) + 1);
      slug = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

// The text a reader sees for a run of inline tokens: formatting dropped, code and link text kept.
function plainText(tokens = []) {
  return tokens
    .map((token) => {
      if (token.tokens) return plainText(token.tokens);
      if (token.type === "br") return " ";
      if (token.type === "html") return "";
      return decodeEntities(token.text ?? "");
    })
    .join("");
}

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function createMarked() {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        const id = token.anchor;
        if (token.depth === 1) return `<h1 id="${id}">${text}</h1>\n`;
        const label = escapeHtml(`Permalink: ${plainText(token.tokens)}`);
        return `<h${token.depth} id="${id}">${text}<a class="heading-link" href="#${id}" aria-label="${label}">#</a></h${token.depth}>\n`;
      },
      table(token) {
        return `<div class="table-wrap" role="region" aria-label="Table" tabindex="0">\n${Renderer.prototype.table.call(this, token)}</div>\n`;
      },
      code(token) {
        // Mermaid and every other language render as a plain code block; nothing runs in the browser.
        const lang = (token.lang ?? "").match(/^\S*/)[0];
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        const label = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
        const code = token.text.replace(/\n$/, "");
        return `<pre tabindex="0"${label}><code${cls}>${escapeHtml(code)}</code></pre>\n`;
      },
      blockquote(token) {
        if (!token.alert) return false;
        const body = this.parser.parse(token.tokens);
        const kind = token.alert.toLowerCase();
        return `<div class="callout callout-${kind}" role="note">\n<p class="callout-title">${ALERTS[token.alert]}</p>\n${body}</div>\n`;
      },
    },
  });
  return marked;
}

// A GitHub alert is a blockquote whose first line is [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
function markAlert(marked, token) {
  const first = token.tokens?.[0];
  if (first?.type !== "paragraph") return;
  const match = first.text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/);
  if (!match) return;
  token.alert = match[1];
  const rest = first.text.slice(match[0].length);
  if (rest.trim()) {
    first.text = rest;
    first.raw = rest;
    first.tokens = marked.Lexer.lexInline(rest);
  } else {
    token.tokens.shift();
  }
}

function isExternal(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

function listSourceDocs(root) {
  const dir = path.join(root, SOURCE_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

// Pass one: read every doc, lex it, and record its title, lead paragraph and heading anchors.
function loadDoc(marked, root, relPath) {
  const file = path.join(root, ...relPath.split("/"));
  const source = readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const tokens = marked.lexer(source);
  const slug = createSlugger();
  const anchors = new Set();
  let title = null;
  let lead = null;
  let afterTitle = false;
  marked.walkTokens(tokens, (token) => {
    if (token.type === "blockquote") markAlert(marked, token);
    if (token.type === "heading") {
      token.anchor = slug(plainText(token.tokens));
      anchors.add(token.anchor);
    }
  });
  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 1 && title === null) {
      title = plainText(token.tokens).trim();
      afterTitle = true;
    } else if (afterTitle && token.type === "paragraph") {
      lead = plainText(token.tokens).replace(/\s+/g, " ").trim();
      break;
    } else if (token.type !== "space" && afterTitle) {
      break;
    }
  }
  return { relPath, tokens, anchors, title, lead };
}

function describe(lead, limit = 200) {
  if (!lead || lead.length <= limit) return lead ?? "";
  const cut = lead.slice(0, limit - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

// The docs in the order docs/README.md lists them, with its link text as their name in the sidebar.
function navOrder(indexDoc, names) {
  const order = [];
  for (const token of indexDoc.tokens) {
    if (token.type !== "list") continue;
    for (const item of token.items) {
      const link = findFirst(item.tokens, (t) => t.type === "link");
      if (!link || isExternal(link.href)) continue;
      const file = link.href.split("#")[0];
      if (names.includes(file) && !order.some((entry) => entry.file === file)) {
        order.push({ file, label: plainText(link.tokens).trim() });
      }
    }
  }
  return order;
}

function findFirst(tokens = [], predicate) {
  for (const token of tokens) {
    if (predicate(token)) return token;
    const nested = findFirst(token.tokens ?? token.items, predicate);
    if (nested) return nested;
  }
  return null;
}

export function docUrl(name) {
  return name === INDEX_DOC ? DOCS_PATH : `${DOCS_PATH}${name.replace(/\.md$/, "")}/`;
}

export function buildSite({ root, out, log = () => {} }) {
  root = path.resolve(root);
  out = path.resolve(out);
  const sourceDir = path.join(root, SOURCE_DIR);
  const marked = createMarked();
  const names = listSourceDocs(root);
  if (!names.includes(INDEX_DOC)) throw new SiteBuildError(`${SOURCE_DIR}/${INDEX_DOC} is missing: it is the docs index.`);
  if (existsSync(path.join(sourceDir, "docs"))) {
    throw new SiteBuildError(`${SOURCE_DIR}/docs/ exists and would collide with the generated doc pages.`);
  }

  const docs = new Map(names.map((name) => [name, loadDoc(marked, root, `${SOURCE_DIR}/${name}`)]));
  for (const doc of docs.values()) {
    if (!doc.title) throw new SiteBuildError(`${doc.relPath} has no "# Title" heading.`);
  }
  const otherMarkdown = new Map(); // anchors of repository Markdown files outside docs/, read on demand

  const order = navOrder(docs.get(INDEX_DOC), names);
  for (const name of names) {
    if (name !== INDEX_DOC && !order.some((entry) => entry.file === name)) {
      log(`warning: ${SOURCE_DIR}/${name} is not listed in ${SOURCE_DIR}/${INDEX_DOC}; it goes last in the sidebar.`);
      order.push({ file: name, label: docs.get(name).title });
    }
  }
  const nav = [{ file: INDEX_DOC, label: "Overview" }, ...order];

  const errors = [];
  const anchorsOf = (repoPath) => {
    if (repoPath.startsWith(`${SOURCE_DIR}/`) && docs.has(repoPath.slice(SOURCE_DIR.length + 1))) {
      return docs.get(repoPath.slice(SOURCE_DIR.length + 1)).anchors;
    }
    if (!otherMarkdown.has(repoPath)) otherMarkdown.set(repoPath, loadDoc(marked, root, repoPath).anchors);
    return otherMarkdown.get(repoPath);
  };

  // Rewrites one relative href from a doc to its URL on the site or on GitHub, or records why it is broken.
  const rewrite = (doc, href, kind) => {
    if (!href || isExternal(href)) return href;
    const hashAt = href.indexOf("#");
    const target = decodeURI(hashAt === -1 ? href : href.slice(0, hashAt));
    const anchor = hashAt === -1 ? null : href.slice(hashAt + 1);
    const fail = (why) => {
      errors.push(`${doc.relPath}: ${kind} "${href}": ${why}`);
      return href;
    };

    if (target === "") {
      if (anchor !== null && !doc.anchors.has(decodeURIComponent(anchor))) return fail(`no heading with the anchor #${anchor} in this doc`);
      return href;
    }
    if (target.startsWith("/")) return fail("absolute paths are not allowed; link relative to the doc");

    const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(doc.relPath), target)).replace(/\/$/, "");
    if (repoPath === ".." || repoPath.startsWith("../")) return fail("points outside the repository");
    const file = path.join(root, ...repoPath.split("/"));
    if (!existsSync(file)) return fail(`${repoPath} does not exist`);
    const isDir = statSync(file).isDirectory();
    if (anchor !== null) {
      if (isDir || !repoPath.endsWith(".md")) return fail("an #anchor is only checked on Markdown files");
      if (!anchorsOf(repoPath).has(decodeURIComponent(anchor))) return fail(`${repoPath} has no heading with the anchor #${anchor}`);
    }
    const hash = anchor !== null ? `#${anchor}` : "";

    if (kind === "image") {
      if (!repoPath.startsWith(`${SOURCE_DIR}/`) || repoPath.endsWith(".md") || isDir) {
        return fail(`only files under ${SOURCE_DIR}/ are published; an image must live there`);
      }
      return `/${repoPath.slice(SOURCE_DIR.length + 1)}`;
    }
    if (repoPath.startsWith(`${SOURCE_DIR}/`) && docs.has(repoPath.slice(SOURCE_DIR.length + 1))) {
      return `${docUrl(repoPath.slice(SOURCE_DIR.length + 1))}${hash}`;
    }
    if (repoPath === "README.md") return `${REPO_URL}${hash}`;
    return `${REPO_URL}/${isDir ? "tree" : "blob"}/main/${repoPath.split("/").map(encodeURIComponent).join("/")}${hash}`;
  };

  const pages = [];
  for (const [index, entry] of nav.entries()) {
    const doc = docs.get(entry.file);
    marked.walkTokens(doc.tokens, (token) => {
      if (token.type === "link") token.href = rewrite(doc, token.href, "link");
      if (token.type === "image") token.href = rewrite(doc, token.href, "image");
    });
    const body = marked.parser(doc.tokens);
    pages.push({ entry, doc, body, prev: nav[index - 1], next: nav[index + 1] });
  }
  if (errors.length) {
    throw new SiteBuildError(`Broken links in the docs (${errors.length}):\n${errors.map((line) => `  - ${line}`).join("\n")}`);
  }

  // Write: the static site as it is (without the Markdown sources), then the doc pages and the sitemap.
  const contains = (parent, child) => !path.relative(parent, child).startsWith("..") && !path.isAbsolute(path.relative(parent, child));
  if (contains(out, root) || contains(sourceDir, out)) {
    throw new SiteBuildError(`Refusing to write the site into ${out}: it would replace the repository or ${SOURCE_DIR}/.`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(sourceDir, out, {
    recursive: true,
    filter: (src) => !(path.dirname(src) === sourceDir && src.endsWith(".md") && statSync(src).isFile()),
  });

  const urls = ["/"];
  for (const page of pages) {
    const url = docUrl(page.entry.file);
    const dir = path.join(out, ...url.split("/").filter(Boolean));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), renderPage(page, nav));
    urls.push(url);
  }
  writeFileSync(path.join(out, "sitemap.xml"), renderSitemap(urls));
  log(`Wrote ${pages.length} doc pages and sitemap.xml (${urls.length} URLs) to ${out}`);
  return { out, urls };
}

function renderSitemap(urls) {
  const entries = urls.map((url) => `  <url>\n    <loc>${SITE_URL}${url}</loc>\n  </url>\n`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}</urlset>\n`;
}

function renderPage({ entry, doc, body, prev, next }, nav) {
  const isIndex = entry.file === INDEX_DOC;
  const url = `${SITE_URL}${docUrl(entry.file)}`;
  const title = isIndex ? doc.title : `${doc.title} – Drive-It documentation`;
  const description = escapeHtml(describe(doc.lead) || `Drive-It documentation: ${doc.title}.`);
  const sourceUrl = `${REPO_URL}/blob/main/${doc.relPath}`;
  const t = escapeHtml(title);

  const sidebar = nav
    .map((item) => {
      const current = item.file === entry.file ? ' aria-current="page"' : "";
      return `          <li><a href="${docUrl(item.file)}"${current}>${escapeHtml(item.label)}</a></li>`;
    })
    .join("\n");

  const pager = [
    prev ? `<a class="doc-pager-prev" href="${docUrl(prev.file)}"><small>Previous</small><span><span aria-hidden="true">←</span> ${escapeHtml(prev.label)}</span></a>` : "",
    next ? `<a class="doc-pager-next" href="${docUrl(next.file)}"><small>Next</small><span>${escapeHtml(next.label)} <span aria-hidden="true">→</span></span></a>` : "",
  ].join("\n          ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <meta name="theme-color" content="#172033">
  <meta property="og:type" content="${isIndex ? "website" : "article"}">
  <meta property="og:site_name" content="Drive-It">
  <meta property="og:title" content="${t}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE_URL}/images/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Drive-It: give your AI agent a Revit session">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE_URL}/images/og-image.png">
  <meta name="twitter:image:alt" content="Drive-It: give your AI agent a Revit session">
  <meta name="twitter:title" content="${t}">
  <meta name="twitter:description" content="${description}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <title>${t}</title>
  <link rel="canonical" href="${url}">
  <link rel="icon" href="/assets/drive-it-mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/site.css">
  <link rel="stylesheet" href="/assets/docs.css">
</head>
<body id="top" class="doc-page">
  <a class="skip-link" href="#main">Skip to content</a>

  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Drive-It home">
        <img src="/assets/drive-it-mark.svg" alt="" width="42" height="42">
        <span class="brand-type">
          <strong>Drive-It</strong>
          <span>AI agents for Autodesk Revit</span>
        </span>
      </a>
      <nav class="site-nav" aria-label="Main navigation">
        <a href="/#run">One real run</a>
        <a href="/#features">Features</a>
        <a href="/#install">Install</a>
        <a href="/#window">In charge</a>
        <a href="/docs/" aria-current="${isIndex ? "page" : "true"}">Docs</a>
      </nav>
      <a class="github-link" href="${REPO_URL}">
        GitHub <span aria-hidden="true">↗</span>
      </a>
    </div>
  </header>

  <div class="container doc-layout">
    <nav class="doc-nav" aria-label="Documentation">
      <p class="eyebrow" id="doc-nav-title">Documentation</p>
      <ul aria-labelledby="doc-nav-title">
${sidebar}
      </ul>
    </nav>

    <main id="main" class="doc-main">
      <article class="doc-content">
${body}      </article>
      <footer class="doc-footer">
        <p class="doc-source">
          <a class="text-link" href="${sourceUrl}">Edit this page on GitHub <span aria-hidden="true">↗</span></a>
          <span>Generated from <code>${escapeHtml(doc.relPath)}</code></span>
        </p>
        <nav class="doc-pager" aria-label="Previous and next doc">
          ${pager}
        </nav>
      </footer>
    </main>
  </div>

  <footer class="site-footer">
    <div class="container footer-inner">
      <a class="brand brand-footer" href="#top" aria-label="Back to top">
        <img src="/assets/drive-it-mark.svg" alt="" width="34" height="34">
        <span class="brand-type"><strong>Drive-It</strong><span>AI agents for Autodesk Revit</span></span>
      </a>
      <p>MCP server and Revit add-in · MIT licensed</p>
      <div class="footer-links">
        <a href="${REPO_URL}">GitHub</a>
        <a href="${REPO_URL}/releases">Releases</a>
        <a href="${REPO_URL}/blob/main/LICENSE">License</a>
      </div>
    </div>
    <div class="container footer-more">
      <p>More from <a href="https://designs-os.com/">Designs/OS</a>: <a href="https://jedbjorn.github.io/rst-c/">RST</a> · <a href="https://jedbjorn.github.io/fai-browser/">FAI Browser</a> · <a href="https://subfloor.designs-os.com">Subfloor</a> · <a href="https://jedbjorn.github.io/gantt-it/">Gantt-It</a> · <a href="https://jedbjorn.github.io/splash-it/">Splash-It</a> · <a href="https://jedbjorn.github.io/pick-it/">Pick-It</a> · <a href="https://md-converter.designs-os.com">md-converter</a> · <a href="https://github.com/jedbjorn/storybench">Storybench</a> · <a href="https://jedbjorn.github.io/anj-cloud/">AnJ Cloud</a></p>
      <p><a href="https://designs-os.com/revit-add-ins/">Compare free Revit add-ins from Designs/OS</a></p>
    </div>
  </footer>
</body>
</html>
`;
}

function parseArgs(argv) {
  const args = { out: "_site" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
    else throw new SiteBuildError(`Unknown argument: ${argv[i]}\nUsage: node tools/build-site.mjs [--out <dir>]`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { out } = parseArgs(process.argv.slice(2));
    buildSite({ root, out: path.resolve(root, out), log: (line) => console.log(line) });
  } catch (error) {
    if (!(error instanceof SiteBuildError)) throw error;
    console.error(`build-site: ${error.message}`);
    process.exitCode = 1;
  }
}
