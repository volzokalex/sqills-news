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
const PER_SOURCE_LIMIT = 3;
const OG_IMAGE_CONCURRENCY = 4;
const MAX_AGE_DAYS = 120;  // soft age cap — skip items older than this
const DEK_MAX_CHARS = 220; // hard cap to prevent feed-card overflow

// SINGLE SOURCE — Hacker News via Algolia search API, filtered to AI titles.
// Algolia HN Search lets us query AI-related stories with a points threshold and
// sort by date. Free, no auth. URL-encoded: `>` → %3E.
const SOURCES = [
  {
    name: "Hacker News",
    type: "hn-algolia",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E50&query=AI&hitsPerPage=80",
    limit: 20,
    defaultTags: ["builders"],
  },
];

// ─── Interest-tag keyword dictionaries ──────────────────────────────────────
// Each tag's keyword list is matched (case-insensitive, substring) against
// item.title + item.description. A hit adds the tag. Items always have at
// least the source's defaultTags.
const TAG_KEYWORDS = {
  beginners: [
    "intro to", "introduction to", "getting started", "what is ",
    "primer", "explained", "for beginners", "fundamentals", "the basics",
    "how to use", "guide to", "tutorial", "101", "starter",
    "how to work with", "first steps",
  ],
  builders: [
    " model", "api", "sdk", "agent", "agentic", "eval", "evaluation",
    "fine-tun", "lora", "rag", "embedding", "vector", "inference",
    "deploy", "production", "engineer", "developer", "open-source",
    "context window", "tokens", "transformer", "pytorch", "benchmark",
    "code", "github", "repo",
  ],
  design: [
    "design", "designer", "figma", "midjourney", "stable diffusion",
    "image generation", "image-gen", "creative", "illustration", "branding",
    "dall-e", "dalle", "flux", "image-to-image", "logo", "typography",
    "ui ", " ux ",
  ],
  video: [
    "sora", "runway", "veo", "pika", "luma", "video model",
    "video generation", "text-to-video", "video ai", "animation",
    "video clip", "filmmaking",
  ],
  income: [
    "monetize", "side hustle", "make money", "income", "freelance",
    "client", "pricing", "mrr", "arr", "revenue", "subscription",
    "earn", "passive income", "creator economy",
  ],
  founders: [
    "founder", "startup", "raised", "series a", "series b", "series c",
    "ipo", "fundraising", " vc ", "venture", "valuation", "founded",
    "acquisition", "acquired", "merger", "strategy", "go-to-market",
    "product-market fit", "pmf", "company building",
  ],
};

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

function truncateDek(s, max = DEK_MAX_CHARS) {
  if (!s) return "";
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 100 ? cut.slice(0, lastSpace) : cut;
  return head.replace(/[\s.,;:!?\-—]+$/, "") + "…";
}

function tagItem(item, defaultTags) {
  const tags = new Set(defaultTags || []);
  const haystack = ((item.title || "") + " " + (item.description || "")).toLowerCase();
  for (const [tag, kws] of Object.entries(TAG_KEYWORDS)) {
    if (kws.some((k) => haystack.includes(k))) tags.add(tag);
  }
  return Array.from(tags);
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

    const dekSafe = truncateDek(dek);
    const item = {
      id: slugify(href.replace(/^\/news\//, "")),
      title,
      source: source.name,
      category,
      date_iso,
      date_display: dateText || displayFromIso(date_iso),
      link: abs(href, source.url),
      description: dekSafe,
      image: null,
      body_html: null,
      tags: [],
    };
    item.tags = tagItem(item, source.defaultTags);
    items.push(item);
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
    const item = {
      id: slugify(it.link?.split("/").filter(Boolean).pop() || it.title || ""),
      title: (it.title || "").trim(),
      source: source.name,
      category: (it.categories?.[0] || "").trim(),
      date_iso,
      date_display: date_iso ? displayFromIso(date_iso) : "",
      link: it.link || "",
      description: truncateDek(stripHTML(it.contentSnippet || it.summary || it.content || "")),
      image: it.enclosure?.url || null,
      body_html: null,
      tags: [],
    };
    item.tags = tagItem(item, source.defaultTags);
    return item;
  });
}

/**
 * Hacker News via Algolia. Returns AI-only stories ranked by date.
 * Only items with an external `url` are kept (Ask HN / poll variants skipped).
 */
async function adapterHNAlgolia(source) {
  const res = await fetch(source.url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // Conservative AI keyword set — strict enough to drop non-AI noise on HN.
  const AI_KEYWORDS =
    /\b(ai|a\.i\.|llm|gpt|chatgpt|claude|anthropic|openai|gemini|deepmind|hugging\s*face|midjourney|stable\s*diffusion|sora|runway|deepseek|qwen|mistral|llama|transformer|diffusion|fine[-\s]?tun(?:e|ed|ing)|rag|agent|machine\s*learning|deep\s*learning|neural\s*net)\b/i;

  return (json.hits || [])
    .filter((h) => h.title && AI_KEYWORDS.test(h.title))
    .filter((h) => h.url) // drop Ask HN / Show HN text-only posts
    .map((h) => {
      const date_iso = isoFromAny(h.created_at);
      const item = {
        id: slugify(h.objectID),
        title: (h.title || "").trim(),
        source: source.name,
        category: `${h.points || 0} pts · ${h.num_comments || 0} comments`,
        date_iso,
        date_display: date_iso ? displayFromIso(date_iso) : "",
        link: h.url,
        description: "",
        image: null,
        body_html: null,
        tags: [],
        hn_discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
      };
      item.tags = tagItem(item, source.defaultTags);
      return item;
    });
}

const ADAPTERS = {
  html: adapterAnthropic,
  rss: adapterRSS,
  "hn-algolia": adapterHNAlgolia,
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

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  for (const source of SOURCES) {
    const adapter = ADAPTERS[source.type];
    const limit = source.limit || PER_SOURCE_LIMIT;
    process.stdout.write(`[${source.name}] fetching… `);
    try {
      const raw = await adapter(source);
      const picked = raw
        .filter((it) => it.title && it.link && it.date_iso)
        .filter((it) => it.date_iso >= cutoff)   // skip items older than MAX_AGE_DAYS
        .sort((a, b) => b.date_iso.localeCompare(a.date_iso))
        .slice(0, limit);
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
