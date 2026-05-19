#!/usr/bin/env node
/**
 * Sqills News refresh script.
 *
 *   Fetches → normalizes → enriches (og:image) → writes news.js.
 *
 * Run from this folder:
 *   node refresh.mjs
 *
 * Or via package.json:
 *   npm run refresh
 *
 * Adds no network dependencies beyond rss-parser + cheerio (declared in package.json).
 * Pure local script. No env vars, no auth, no secrets — all sources are public.
 */

import Parser from "rss-parser";
import { load } from "cheerio";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 SqillsNewsBot/0.1";

const FETCH_TIMEOUT_MS = 12_000;
const PER_SOURCE_LIMIT = 4;
const OG_IMAGE_CONCURRENCY = 3;

const SOURCES = [
  { name: "Anthropic",    type: "html", url: "https://www.anthropic.com/news" },
  { name: "DeepMind",     type: "rss",  url: "https://deepmind.google/blog/rss.xml" },
  { name: "Hugging Face", type: "rss",  url: "https://huggingface.co/blog/feed.xml" },
];

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────────
// Tiny helpers
// ──────────────────────────────────────────────────────────────────────────────

const rssParser = new Parser({
  headers: { "User-Agent": UA },
  timeout: FETCH_TIMEOUT_MS,
});

function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function abs(url, base) {
  try { return new URL(url, base).toString(); } catch { return null; }
}

function isoFromAny(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}

function displayFromIso(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function stripHTML(s) {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Adapters
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Anthropic — no public RSS at v0; scrape the /news listing.
 * Cards use FeaturedGrid CSS modules. Each <a href="/news/..."> contains
 *   <span class="caption bold"> = category
 *   <time>                        = date display
 *   <h2|h4 class="headline-…">    = title
 *   <p class="body-3 serif">      = dek
 */
async function adapterAnthropic(source) {
  const html = await fetchText(source.url);
  const $ = load(html);
  const seen = new Set();
  const items = [];

  $('a[href^="/news/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href || seen.has(href)) return;
    seen.add(href);

    const title = $a.find("h1,h2,h3,h4,h5,h6").first().text().trim();
    if (!title) return; // skip pure-image / nav links

    const category = $a.find(".caption.bold").first().text().trim();
    const dateText = $a.find("time").first().text().trim();
    const datetime = $a.find("time").first().attr("datetime");
    const dek = $a.find("p").first().text().trim();

    const date_iso = isoFromAny(datetime) || isoFromAny(dateText);
    if (!date_iso) return; // skip non-dated entries

    items.push({
      id: slugify(href.replace(/^\/news\//, "")),
      title,
      source: source.name,
      category,
      date_iso,
      date_display: dateText || displayFromIso(date_iso),
      link: abs(href, source.url),
      description: dek,
      image: null,
      body_html: null,
    });
  });

  return items;
}

/**
 * RSS-based adapters — DeepMind + Hugging Face. Same shape.
 */
async function adapterRSS(source) {
  const feed = await rssParser.parseURL(source.url);
  return (feed.items || []).map((it) => {
    const date_iso = isoFromAny(it.isoDate) || isoFromAny(it.pubDate);
    return {
      id: slugify(it.link?.split("/").filter(Boolean).pop() || it.title || ""),
      title: (it.title || "").trim(),
      source: source.name,
      category: (it.categories?.[0] || "").trim(),
      date_iso,
      date_display: date_iso ? displayFromIso(date_iso) : "",
      link: it.link || "",
      description: stripHTML(it.contentSnippet || it.summary || it.content || ""),
      image: it.enclosure?.url || null,
      body_html: null,
    };
  });
}

const ADAPTERS = {
  html: adapterAnthropic,
  rss: adapterRSS,
};

// ──────────────────────────────────────────────────────────────────────────────
// Enrich — single per-article fetch yields BOTH og:image AND body_html
// ──────────────────────────────────────────────────────────────────────────────

/**
 * One HTTP fetch per article — extract og:image + Readability-parsed body.
 * Readability returns Reader-Mode-style clean HTML (no scripts, no nav, no ads).
 */
async function fetchArticleMetadata(pageUrl) {
  if (!pageUrl) return { image: null, body_html: null };

  let html;
  try {
    html = await fetchText(pageUrl);
  } catch {
    return { image: null, body_html: null };
  }

  // og:image via cheerio (cheap)
  let image = null;
  try {
    const $ = load(html);
    const candidates = [
      $('meta[property="og:image:secure_url"]').attr("content"),
      $('meta[property="og:image"]').attr("content"),
      $('meta[name="og:image"]').attr("content"),
      $('meta[name="twitter:image"]').attr("content"),
      $('meta[name="twitter:image:src"]').attr("content"),
    ];
    const found = candidates.find((v) => v && v.trim().length > 0);
    image = found ? abs(found, pageUrl) : null;
  } catch {}

  // body via Readability (heavier — jsdom + algorithm)
  let body_html = null;
  try {
    const dom = new JSDOM(html, { url: pageUrl });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();
    if (parsed && parsed.content) {
      body_html = sanitizeReadabilityHTML(parsed.content);
    }
  } catch {}

  return { image, body_html };
}

/**
 * Light pass to remove anything Readability might have left through that we
 * don't want in our rendering context. Readability already strips scripts and
 * most chrome, but it preserves iframes and a few attributes we'd rather not
 * embed inside the prototype's article column.
 */
function sanitizeReadabilityHTML(html) {
  const $ = load(html, { decodeEntities: false });

  // Drop anything obviously dangerous or out-of-flow
  $("script, style, iframe, noscript, form, button, input").remove();

  // Strip on* event handlers, javascript: URLs, and unsafe attributes
  $("*").each((_, el) => {
    if (!el.attribs) return;
    for (const name of Object.keys(el.attribs)) {
      if (name.toLowerCase().startsWith("on")) delete el.attribs[name];
      const val = el.attribs[name];
      if (typeof val === "string" && /^\s*javascript:/i.test(val)) {
        delete el.attribs[name];
      }
    }
  });

  // Readability sometimes wraps content in a top-level <div id="readability-page-1">.
  // Unwrap by returning innerHTML of body to keep markup flat.
  return $("body").html() || "";
}

async function enrichItems(items) {
  const queue = items.slice();
  const workers = Array.from({ length: OG_IMAGE_CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const { image, body_html } = await fetchArticleMetadata(item.link);
      if (!item.image && image) item.image = image;
      item.body_html = body_html;
      process.stdout.write(body_html ? "·" : "x");
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  const all = [];

  for (const source of SOURCES) {
    const adapter = ADAPTERS[source.type];
    process.stdout.write(`[${source.name}] fetching… `);
    try {
      const raw = await adapter(source);
      const picked = raw
        .filter((it) => it.title && it.link && it.date_iso)
        .sort((a, b) => b.date_iso.localeCompare(a.date_iso))
        .slice(0, PER_SOURCE_LIMIT);
      console.log(`ok — ${picked.length} of ${raw.length}`);
      all.push(...picked);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
    }
  }

  if (all.length === 0) {
    console.error("No items fetched — refusing to overwrite news.js");
    process.exit(1);
  }

  process.stdout.write(`[enrich] og:image + body for ${all.length} items `);
  await enrichItems(all);

  all.sort((a, b) => b.date_iso.localeCompare(a.date_iso));

  const payload = {
    generated_at: new Date().toISOString().slice(0, 10),
    items: all,
  };

  const banner = [
    "// Sqills News — prototype dataset",
    `// Generated ${new Date().toISOString()} by refresh.mjs`,
    "// Do not hand-edit — run `node refresh.mjs` to regenerate.",
    "",
  ].join("\n");

  const out = banner + "const NEWS_DATA = " + JSON.stringify(payload, null, 2) + ";\n";
  writeFileSync(join(__dirname, "news.js"), out);

  const withImg = all.filter((i) => i.image).length;
  const withBody = all.filter((i) => i.body_html).length;
  const ms = Date.now() - started;
  console.log(
    `\nWrote news.js — ${all.length} items, ${withImg} with images, ${withBody} with body, ${ms} ms.`
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
