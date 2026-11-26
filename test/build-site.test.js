import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SiteBuildError, buildSite, createSlugger, docUrl } from "../tools/build-site.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, files) {
  const root = tempDir(t, "drive-it-site-fixture-");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const hrefs = (html) => [...html.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]);

test("slugs follow GitHub's heading anchors", () => {
  const slug = createSlugger();
  assert.equal(slug("Require dry run"), "require-dry-run");
  assert.equal(slug("Windows (MSI)"), "windows-msi");
  assert.equal(slug("Workspace and outside-root decisions"), "workspace-and-outside-root-decisions");
  assert.equal(slug("save_script & get_script"), "save_script--get_script");
  assert.equal(slug("Use"), "use");
  assert.equal(slug("Use"), "use-1");
  assert.equal(slug("Use"), "use-2");
  assert.equal(slug("Use 1"), "use-1-1");
});

test("the repository's docs build into one page each, with every in-site link resolving", (t) => {
  const out = path.join(tempDir(t, "drive-it-site-"), "_site");
  const { urls } = buildSite({ root: REPO, out });

  const sources = readdirSync(path.join(REPO, "docs")).filter((name) => name.endsWith(".md"));
  for (const name of sources) {
    const page = path.join(out, ...docUrl(name).split("/").filter(Boolean), "index.html");
    assert.ok(existsSync(page), `${name} has a page`);
    assert.ok(urls.includes(docUrl(name)), `${name} is in the sitemap`);
  }
  assert.ok(!readdirSync(out).some((name) => name.endsWith(".md")), "the Markdown sources are not published");
  assert.ok(existsSync(path.join(out, "assets", "site.css")));
  assert.ok(existsSync(path.join(out, ".nojekyll")));

  const sitemap = readFileSync(path.join(out, "sitemap.xml"), "utf8");
  assert.equal([...sitemap.matchAll(/<loc>/g)].length, urls.length);

  // Every root-relative link in every generated page and the home page lands on a page and, with a
  // #anchor, on an element with that id.
  const pages = ["/", ...urls.filter((url) => url !== "/")];
  for (const url of pages) {
    const html = readFileSync(path.join(out, ...url.split("/").filter(Boolean), "index.html"), "utf8");
    for (const href of hrefs(html).filter((value) => value.startsWith("/docs/"))) {
      const [target, anchor] = href.split("#");
      const file = path.join(out, ...target.split("/").filter(Boolean), "index.html");
      assert.ok(existsSync(file), `${url} links to ${href}, which exists`);
      if (anchor) assert.ok(ids(readFileSync(file, "utf8")).has(anchor), `${url} links to ${href}, whose anchor exists`);
    }
  }
  const home = readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(home, /<nav class="site-nav"[^>]*>[\s\S]*<a href="\/docs\/">Docs<\/a>[\s\S]*<\/nav>/);
});

test("links are rewritten for the site, alerts become callouts, tables scroll", (t) => {
  const root = fixture(t, {
    "README.md": "# Project\n\n## Install\n\nText.\n",
    "LICENSE": "MIT\n",
    "src/a b.cs": "class A {}\n",
    "docs/README.md": "# Docs\n\nThe index.\n\n- [First](first.md): one.\n- [Second](second.md): two.\n",
    "docs/first.md": [
      "# First",
      "",
      "The lead, with `code` and a [link](second.md).",
      "",
      "## Details",
      "",
      "[same page](#details) [other doc](second.md#more-detail) [readme](../README.md#install)",
      "[readme root](../README.md) [license](../LICENSE) [source](../src/a%20b.cs) [folder](../src)",
      "[external](https://example.com/x.md) [index](README.md)",
      "",
      "> [!CAUTION]",
      "> Be careful.",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
    ].join("\n"),
    "docs/second.md": "# Second\n\nLead.\n\n## More detail\n",
    "docs/assets/site.css": "body {}\n",
  });
  const out = path.join(root, "_site");
  buildSite({ root, out });

  const first = readFileSync(path.join(out, "docs", "first", "index.html"), "utf8");
  const links = hrefs(first);
  for (const expected of [
    "#details",
    "/docs/second/#more-detail",
    "https://github.com/jedbjorn/drive-it#install",
    "https://github.com/jedbjorn/drive-it",
    "https://github.com/jedbjorn/drive-it/blob/main/LICENSE",
    "https://github.com/jedbjorn/drive-it/blob/main/src/a%20b.cs",
    "https://github.com/jedbjorn/drive-it/tree/main/src",
    "https://example.com/x.md",
    "/docs/",
    "https://github.com/jedbjorn/drive-it/blob/main/docs/first.md",
  ]) {
    assert.ok(links.includes(expected), `links include ${expected}`);
  }
  assert.ok(ids(first).has("details"));
  assert.match(first, /<div class="callout callout-caution" role="note">\s*<p class="callout-title">Caution<\/p>\s*<p>Be careful.<\/p>/);
  assert.doesNotMatch(first, /\[!CAUTION\]/);
  assert.match(first, /<div class="table-wrap"[^>]*>\s*<table>/);
  assert.match(first, /<pre tabindex="0" data-lang="mermaid"><code class="language-mermaid">graph TD; A--&gt;B<\/code><\/pre>/);
  assert.match(first, /<meta name="description" content="The lead, with code and a link.">/);
  assert.match(first, /<link rel="canonical" href="https:\/\/drive-it.designs-os.com\/docs\/first\/">/);
  assert.match(first, /<title>First – Drive-It documentation<\/title>/);
  assert.match(first, /<a href="\/docs\/first\/" aria-current="page">First<\/a>/);
  assert.ok(!existsSync(path.join(out, "README.md")));
});

test("a link to a missing file or anchor fails the build and names it", (t) => {
  const root = fixture(t, {
    "README.md": "# Project\n\n## Install\n",
    "docs/README.md": "# Docs\n\n- [First](first.md): one.\n",
    "docs/first.md": [
      "# First",
      "",
      "[gone](gone.md) [bad anchor](README.md#nowhere) [readme anchor](../README.md#uninstall) [here](#nothing)",
      "",
    ].join("\n"),
  });
  const out = path.join(root, "_site");
  assert.throws(() => buildSite({ root, out }), (error) => {
    assert.ok(error instanceof SiteBuildError);
    assert.match(error.message, /Broken links in the docs \(4\)/);
    assert.match(error.message, /docs\/first\.md: link "gone\.md": docs\/gone\.md does not exist/);
    assert.match(error.message, /docs\/README\.md has no heading with the anchor #nowhere/);
    assert.match(error.message, /README\.md has no heading with the anchor #uninstall/);
    assert.match(error.message, /link "#nothing": no heading with the anchor #nothing in this doc/);
    return true;
  });
  assert.ok(!existsSync(out), "nothing is written when a link is broken");
});
