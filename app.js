// Sqills News prototype — rendering logic (shared by index.html and article.html).
// Data: NEWS_DATA from news.js (embedded so the proto opens via file://).

(function () {
  "use strict";

  const items = (NEWS_DATA && NEWS_DATA.items) || [];

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (e) { return url; }
  }

  // ─── Feed (index.html) ────────────────────────────────────────
  function renderFeed(filter) {
    const root = document.getElementById("feed");
    if (!root) return;

    const filtered = filter && filter !== "all"
      ? items.filter(function (it) { return it.tags && it.tags.includes(filter); })
      : items;

    if (filtered.length === 0) {
      root.innerHTML = '<p class="empty">No items in this view.</p>';
      return;
    }

    root.innerHTML = filtered.map(function (it) {
      const hero = it.image
        ? '<div class="card-hero"><img loading="lazy" src="' + escapeHTML(it.image) + '" alt="" onerror="this.parentNode.classList.add(\'card-hero-broken\')"></div>'
        : '';
      const dek = it.description
        ? '<p class="card-dek">' + escapeHTML(it.description) + '</p>'
        : '';
      // Quiet footer: domain · category (HN points/comments) · date
      const footerBits = [escapeHTML(domainOf(it.link))];
      if (it.category) footerBits.push(escapeHTML(it.category));
      footerBits.push(escapeHTML(it.date_display));
      return [
        '<a class="card" href="article.html?id=' + encodeURIComponent(it.id) + '">',
        '  ' + hero,
        '  <div class="card-body">',
        '    <h2 class="card-title">' + escapeHTML(it.title) + '</h2>',
        '    ' + dek,
        '    <p class="card-footer">' + footerBits.join(' · ') + '</p>',
        '  </div>',
        '</a>'
      ].join('\n');
    }).join('\n');
  }

  // ─── Article (article.html) ───────────────────────────────────
  function getParam(name) {
    const m = new URLSearchParams(window.location.search).get(name);
    return m || '';
  }

  function renderArticle() {
    const root = document.getElementById('article-root');
    if (!root) return;

    const id = getParam('id');
    const item = items.find(function (it) { return it.id === id; });

    if (!item) {
      root.innerHTML = [
        '<h1 class="article-title">Story not found</h1>',
        '<p class="article-dek">This story isn’t in the current batch. It may have rolled out of the feed.</p>',
        '<a class="cta-primary" href="index.html" style="margin-top:24px;">Back to news</a>'
      ].join('\n');
      document.title = 'Not found — Sqills News';
      return;
    }

    document.title = item.title + ' — Sqills News';

    const dek = item.description
      ? '<p class="article-dek">' + escapeHTML(item.description) + '</p>'
      : '';

    // Body: Readability-extracted body_html when present; fall back to a quiet
    // note that the body wasn't extractable (footer attribution carries the link).
    const body = item.body_html
      ? '<div class="article-body">' + item.body_html + '</div>'
      : [
          '<div class="article-body">',
          '  <p><em>Full body wasn’t auto-extractable from this source. The attribution below links to the original.</em></p>',
          '</div>'
        ].join('\n');

    const hero = item.image
      ? '<div class="article-hero"><img src="' + escapeHTML(item.image) + '" alt="" onerror="this.parentNode.classList.add(\'article-hero-broken\')"></div>'
      : '';

    // Footer attribution: quiet single line, domain as inline link.
    // Format: "Source: domain · via Hacker News · 123 pts · May 22, 2026"
    const attrBits = [
      'Source: <a href="' + escapeHTML(item.link) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(domainOf(item.link)) + '</a>',
      'via ' + escapeHTML(item.source),
    ];
    if (item.category) attrBits.push(escapeHTML(item.category));
    attrBits.push(escapeHTML(item.date_display));

    root.innerHTML = [
      hero,
      '<h1 class="article-title">' + escapeHTML(item.title) + '</h1>',
      dek,
      body,
      '<p class="attr-note">' + attrBits.join(' · ') + '</p>'
    ].join('\n');
  }

  // ─── Bootstrap ────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    renderFeed('all');
    renderArticle();
  });
})();
