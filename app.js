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
      ? items.filter(function (it) { return it.source === filter; })
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
      const category = it.category
        ? '<span class="card-category">' + escapeHTML(it.category) + '</span>'
        : '';
      return [
        '<a class="card" href="article.html?id=' + encodeURIComponent(it.id) + '">',
        '  ' + hero,
        '  <div class="card-body">',
        '    <div class="card-meta">',
        '      <span class="source-badge">' + escapeHTML(it.source) + '</span>',
        '      ' + category,
        '      <span class="card-date">' + escapeHTML(it.date_display) + '</span>',
        '    </div>',
        '    <h2 class="card-title">' + escapeHTML(it.title) + '</h2>',
        '    ' + dek,
        '    <span class="card-cta">Read</span>',
        '  </div>',
        '</a>'
      ].join('\n');
    }).join('\n');
  }

  function wireFilters() {
    const tags = document.querySelectorAll('.filters .tag');
    if (!tags.length) return;
    tags.forEach(function (tag) {
      tag.addEventListener('click', function () {
        tags.forEach(function (t) { t.classList.remove('tag-active'); });
        tag.classList.add('tag-active');
        renderFeed(tag.dataset.filter);
      });
    });
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

    const body = [
      '<div class="article-body">',
      '  <p>This is a prototype rendering of a Sqills News article page. The original publisher (' + escapeHTML(item.source) + ') hosts the full body, embedded media, and any partner quotes for this story.</p>',
      '  <p>Once Sqills News gains its content pipeline, summaries authored in Sqills voice will replace this placeholder. For now, the card above shows the headline and teaser; the link below opens the full story on the original source.</p>',
      '</div>'
    ].join('\n');

    const category = item.category
      ? '<span class="card-category">' + escapeHTML(item.category) + '</span>'
      : '';

    const hero = item.image
      ? '<div class="article-hero"><img src="' + escapeHTML(item.image) + '" alt="" onerror="this.parentNode.classList.add(\'article-hero-broken\')"></div>'
      : '';

    root.innerHTML = [
      hero,
      '<div class="article-meta">',
      '  <span class="source-badge">' + escapeHTML(item.source) + '</span>',
      '  ' + category,
      '  <span class="card-date">' + escapeHTML(item.date_display) + '</span>',
      '</div>',
      '<h1 class="article-title">' + escapeHTML(item.title) + '</h1>',
      dek,
      body,
      '<div class="outbound">',
      '  <div class="outbound-eyebrow">Read full story on</div>',
      '  <div class="outbound-source">' + escapeHTML(item.source) + '</div>',
      '  <div class="outbound-domain">' + escapeHTML(domainOf(item.link)) + '</div>',
      '  <a class="cta-primary" href="' + escapeHTML(item.link) + '" target="_blank" rel="noopener noreferrer">Open original</a>',
      '</div>',
      '<p class="attr-note">Sqills aggregates AI news from publicly-available sources. The story above was published by <strong>' + escapeHTML(item.source) + '</strong> on ' + escapeHTML(item.date_display) + '. All credit and copyright remain with the original publisher.</p>'
    ].join('\n');
  }

  // ─── Bootstrap ────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    renderFeed('all');
    wireFilters();
    renderArticle();
  });
})();
