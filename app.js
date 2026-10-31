/* Daily GD Brief — front-end logic (no frameworks), v2.
   Reads data/latest.json (or an archived day) and renders the page.
   Adds: stale-brief warning, category jump chips, save/read state, sharing,
   archive search, and link-scheme checks. */

(function () {
  "use strict";

  var app = document.getElementById("app");
  var dateSelect = document.getElementById("date-select");
  var themeToggle = document.getElementById("theme-toggle");
  var kickerEl = document.getElementById("day-kicker");
  var datelineEl = document.getElementById("dateline");
  var metaEl = document.getElementById("day-meta");
  var coverEl = document.getElementById("cover");
  var openState = {};          // which categories are expanded
  var archiveIndex = [];       // list of past briefs
  var currentBrief = null;
  var SAVED_KEY = "gd-saved-v1";
  var READ_KEY = "gd-read-v1";

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "";
  }
  function bust(url) {
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "v=" + Math.floor(Date.now() / 60000);
  }
  function fetchJSON(url) {
    return fetch(bust(url), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    });
  }
  function timeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 60) return mins <= 1 ? "just now" : mins + " min ago";
    var h = Math.round(mins / 60);
    if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }
  function todayIST() {
    // en-CA gives YYYY-MM-DD, which is what the data files use.
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }
  function showStatus(msg, isError) {
    app.innerHTML = '<section class="status' + (isError ? " error" : "") + '"><p>' + esc(msg) + "</p></section>";
  }

  // ---------- small persistent store ----------
  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function savedMap() { return readStore(SAVED_KEY, {}) || {}; }
  function readList() { return readStore(READ_KEY, []) || []; }
  function isSaved(url) { return Object.prototype.hasOwnProperty.call(savedMap(), url); }
  function isRead(url) { return readList().indexOf(url) !== -1; }

  function toggleSaved(story, dateLabel) {
    var map = savedMap();
    if (map[story.url]) delete map[story.url];
    else {
      map[story.url] = {
        title: story.title, url: story.url, source: story.source,
        date: dateLabel || "", summary: story.summary || "", key_fact: story.key_fact || ""
      };
    }
    writeStore(SAVED_KEY, map);
    return !!map[story.url];
  }
  function toggleRead(url) {
    var list = readList();
    var i = list.indexOf(url);
    if (i === -1) list.push(url); else list.splice(i, 1);
    writeStore(READ_KEY, list.slice(-400));
    return i === -1;
  }

  // ---------- theme ----------
  function currentTheme() {
    var forced = document.documentElement.getAttribute("data-theme");
    if (forced) return forced;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  themeToggle.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("gd-theme", next); } catch (e) {}
  });

  // ---------- sharing ----------
  function shareOrCopy(title, text, url, btn) {
    var payload = { title: title, text: text, url: url || location.href };
    if (navigator.share) {
      navigator.share(payload).catch(function () {});
      return;
    }
    var flat = text + (url ? "\n" + url : "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(flat).then(function () {
        if (btn) {
          var old = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = old; }, 1500);
        }
      });
    }
  }

  // ---------- watchlist ----------
  // Topics are keyword sets matched against headlines and summaries. The list a
  // reader follows is kept in this browser only.
  var WATCH_KEY = "gd-watch-v1";
  var WATCH_TOPICS = [
    { id: "rates", label: "RBI and interest rates", rx: /\b(rbi|repo|interest rates?|monetary policy|inflation|cpi|mpc)\b/i },
    { id: "trade", label: "Trade and tariffs", rx: /\b(trade (deals?|pacts?|agreements?|talks|wars?|deficit|surplus)|ftas?|free trade|exports?|imports?|wto|import dut(y|ies)|customs dut(y|ies)|reciprocal tariffs?|tariffs? on)\b/i },
    { id: "ai", label: "AI and tech policy", rx: /\b(ai|artificial intelligence|semiconductors?|chips?|data protection|deepfakes?|chatbots?)\b/i },
    { id: "energy", label: "Energy and oil", rx: /\b(crude|oil|opec|fuel|lng|petrol|diesel|energy|power tariffs?)\b/i },
    { id: "startups", label: "Startups and funding", rx: /\b(startups?|funding|venture capital|vc|ipos?|unicorns?|valuation)\b/i },
    { id: "climate", label: "Climate", rx: /\b(climate|emissions?|cop ?\d+|net[- ]zero|carbon|heatwaves?|monsoon|biodiversity)\b/i },
    { id: "china", label: "China", rx: /\b(china|chinese|beijing|xi jinping)\b/i },
    { id: "us", label: "US policy", rx: /\b(trump|washington|white house|federal reserve|u\.s\.)\b/i },
    { id: "jobs", label: "Jobs and welfare", rx: /\b(jobs?|employment|unemployment|labou?r|welfare|poverty|wages?)\b/i },
    { id: "markets", label: "Markets", rx: /\b(sensex|nifty|stocks?|shares|sebi|bonds?|market cap|rupee)\b/i }
  ];
  function watchState() {
    var st = readStore(WATCH_KEY, null);
    if (!st || !Array.isArray(st.topics)) st = { topics: ["rates", "trade", "ai"], custom: [] };
    if (!Array.isArray(st.custom)) st.custom = [];
    return st;
  }
  function saveWatch(st) { writeStore(WATCH_KEY, st); }
  function escRx(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function activeTopics() {
    var st = watchState();
    var list = WATCH_TOPICS.filter(function (t) { return st.topics.indexOf(t.id) !== -1; });
    st.custom.forEach(function (w) {
      if (w) list.push({ id: "c:" + w, label: w, rx: new RegExp("\\b" + escRx(w) + "\\b", "i"), custom: true });
    });
    return list;
  }
  function watchMatches(story) {
    var text = (story.title || "") + " " + (story.summary || "");
    return activeTopics().filter(function (t) { return t.rx.test(text); });
  }

  // ---------- icons ----------
  var ICON = {
    star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
    share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>'
  };

  // ---------- reading progress ----------
  function briefUrls(b) {
    var out = [];
    (b && b.categories || []).forEach(function (c) {
      (c.stories || []).forEach(function (s) { if (s.url) out.push(s.url); });
    });
    return out;
  }
  function markRead(url) {
    if (!isRead(url)) toggleRead(url);
  }
  function updateProgress() {
    if (!currentBrief) return;
    var urls = briefUrls(currentBrief);
    var done = urls.filter(isRead).length;
    var bar = app.querySelector(".progress-fill");
    var label = app.querySelector(".progress-label");
    if (bar) bar.style.transform = "scaleX(" + (urls.length ? done / urls.length : 0) + ")";
    if (label) {
      label.textContent = done === urls.length && urls.length
        ? "All " + urls.length + " stories read"
        : done + " of " + urls.length + " read";
    }
    (currentBrief.categories || []).forEach(function (c) {
      var list = (c.stories || []).map(function (s) { return s.url; });
      var left = list.filter(function (u) { return !isRead(u); }).length;
      var chip = app.querySelector('[data-jump="' + c.key + '"]');
      if (chip) {
        chip.classList.toggle("is-done", left === 0 && list.length > 0);
        var n = chip.querySelector("span");
        if (n) n.innerHTML = left === 0 ? ICON.check : String(left);
        chip.setAttribute("aria-label", c.title + ", " + (left === 0 ? "all read" : left + " unread"));
      }
      var count = app.querySelector('#cat-' + c.key + ' .count');
      if (count) count.textContent = left === 0 && list.length ? "All read" : left + " of " + list.length + " unread";
    });
  }

  // ---------- masthead ----------
  function parseDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 6)) : null;
  }
  function shortDate(iso, label) {
    var d = parseDay(iso);
    return d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : (label || "");
  }
  function editionNumber(iso) {
    if (!archiveIndex.length || !iso) return 0;
    return archiveIndex.filter(function (e) { return e.date <= iso; }).length;
  }
  function renderMasthead(b) {
    var d = parseDay(b.date);
    var weekday = d ? d.toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" }) : "";
    var no = editionNumber(b.date);
    kickerEl.textContent = weekday || "Morning edition";
    datelineEl.textContent = d
      ? d.toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" })
      : (b.date_label || b.date || "");
    var parts = [];
    if (no) parts.push("Edition " + no);
    if (b.reading_time_min) parts.push(b.reading_time_min + " min read");
    if (b.story_count) parts.push(b.story_count + " stories");
    if ((b.sources_ok || []).length) parts.push(b.sources_ok.length + " vetted sources");
    metaEl.textContent = parts.join(", ");
    var savedBtn = document.getElementById("saved-btn");
    if (savedBtn) updateSavedCount();
  }

  // ---------- rendering pieces ----------
  function renderLine(label, text, copyable) {
    if (!text) return "";
    return (
      '<div class="line">' +
        '<div class="line-head"><span class="label">' + esc(label) + "</span>" +
          (copyable ? '<button class="copy" type="button" data-copy="' + esc(text) + '" aria-label="Copy ' + esc(label.toLowerCase()) + '">' + ICON.copy + "<span>Copy</span></button>" : "") +
        "</div>" +
        "<p>" + esc(text) + "</p>" +
      "</div>"
    );
  }
  function renderLens(p) {
    var m = /^([^:]{3,40}):\s+(.+)$/.exec(p);
    if (!m) return "<li>" + esc(p) + "</li>";
    var view = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return "<li><strong>" + esc(m[1]) + "</strong>" + esc(view) + "</li>";
  }

  function renderStaleNotice(b) {
    if (!b || !b.date) return "";
    if (dateSelect.value) return "";                 // looking at an archived day on purpose
    if (b.date === todayIST()) return "";
    return (
      '<div class="notice" role="status">' +
        "<strong>This is " + esc(b.date_label || b.date) + "'s brief.</strong> " +
        "Today's build has not published yet. GitHub's scheduler can run late; " +
        "you can trigger it from the repository's Actions tab." +
      "</div>"
    );
  }

  function renderHero(t) {
    if (!t) return "";
    var perspectives = Array.isArray(t.perspectives) && t.perspectives.length
      ? '<div class="perspectives"><div class="label">Who sees it how</div><ul>' +
          t.perspectives.map(renderLens).join("") + "</ul></div>"
      : "";
    return (
      '<section class="hero' + (t.fallback ? " is-auto" : "") + '" aria-labelledby="gd-topic">' +
        '<div class="kicker">' + (t.fallback ? "Most-covered story today" : "Likely GD topic") + "</div>" +
        '<h2 id="gd-topic">' + esc(t.topic) + "</h2>" +
        // Automatic topics carry template text (and older ones an apology); skip it.
        (t.why_now && !t.fallback ? '<p class="why">' + esc(t.why_now) + "</p>" : "") +
        (t.fallback ? "" : '<div class="lines">' +
          renderLine("Open with", t.opening_line, true) +
          renderLine("Close with", t.closing_line, true) + "</div>") +
        perspectives +
        '<div class="hero-actions"><button class="text-btn" type="button" data-share-topic="1">' + ICON.share + "<span>Share topic</span></button></div>" +
      "</section>"
    );
  }

  // "In 60 seconds": the lead story of each section, reduced to one quotable line.
  function renderQuick(b) {
    var items = [];
    (b.categories || []).forEach(function (c) {
      var pool = (c.stories || []).filter(function (x) { return x.ai && x.key_fact && !x.fact_is_context; });
      var withNum = pool.filter(function (x) { return pickNumber(x.key_fact); });
      var unitRx = /[%$₹€£]|Rs|bn|billion|crore|lakh|million|trillion|hours|days|months|years/i;
      var withUnit = withNum.filter(function (x) { return unitRx.test(pickNumber(x.key_fact)); });
      var s = withUnit[0] || withNum[0] || pool[0];
      if (s) items.push({ key: c.key, cat: c.title.split(/[,&:]/)[0].trim(), s: s, num: pickNumber(s.key_fact) });
    });
    if (items.length < 3) return "";
    return (
      '<section class="quick" aria-labelledby="quick-h">' +
        '<div class="quick-head"><h2 id="quick-h">In 60 seconds</h2>' +
        '<p class="quick-sub">One number from each section worth carrying into the room. Tap one to read the story.</p></div>' +
        '<ul class="tiles">' + items.map(function (it) {
          return '<li><button type="button" class="tile" data-cat="' + esc(it.key) + '" data-goto="' + esc(it.s.url) + '">' +
            '<span class="tile-cat">' + esc(it.cat) + "</span>" +
            (it.num ? '<span class="tile-num">' + esc(it.num) + "</span>" : "") +
            '<span class="tile-fact">' + esc(it.s.key_fact) + "</span>" +
            "</button></li>";
        }).join("") + "</ul>" +
      "</section>"
    );
  }

  function renderWatchToday(b) {
    var hits = [];
    (b.categories || []).forEach(function (c) {
      (c.stories || []).forEach(function (s) {
        var m = watchMatches(s);
        if (m.length) hits.push({ s: s, t: m[0] });
      });
    });
    var topics = activeTopics();
    return (
      '<section class="watch-card">' +
        '<div class="watch-head"><div class="kicker">Your watchlist today</div>' +
          '<a class="link-btn" href="#week">Edit topics</a></div>' +
        (hits.length
          ? "<ul>" + hits.slice(0, 5).map(function (h) {
              return '<li><button type="button" class="watch-hit" data-goto="' + esc(h.s.url) + '">' +
                '<span class="watch-topic">' + esc(h.t.label) + "</span>" + esc(h.s.title) + "</button></li>";
            }).join("") + "</ul>" +
            (hits.length > 5 ? '<p class="dim">' + (hits.length - 5) + " more marked in the brief below.</p>" : "")
          : '<p class="dim">' + (topics.length
              ? "Nothing on " + esc(topics.slice(0, 3).map(function (t) { return t.label; }).join(", ")) + " today."
              : "Follow a few topics and matching stories show up here.") + "</p>") +
      "</section>"
    );
  }

  function renderWeekTeaser() {
    if (archiveIndex.length < 3) return "";
    return (
      '<section class="teaser">' +
        '<div class="kicker">The week in review</div>' +
        "<h2>Threads, topics and an 8-question quiz</h2>" +
        "<p>Everything from the last seven briefs on one page, so the week's news actually sticks.</p>" +
        '<a class="text-btn" href="#week">Open this week</a>' +
      "</section>"
    );
  }

  function renderConcept(c) {
    if (!c || !c.name) return "";
    return (
      '<section class="concept" aria-labelledby="concept-name">' +
        '<div class="kicker">Concept of the day</div>' +
        '<h2 id="concept-name">' + esc(c.name) + "</h2>" +
        "<p>" + esc(c.explanation) + "</p>" +
        (c.indian_example || c.use_in_gd
          ? '<details class="concept-more"><summary>Indian example and how to use it</summary>' +
              (c.indian_example ? '<div class="sub">Indian example</div><p>' + esc(c.indian_example) + "</p>" : "") +
              (c.use_in_gd ? '<div class="sub">How to use it in a GD</div><p>' + esc(c.use_in_gd) + "</p>" : "") +
            "</details>"
          : "") +
      "</section>"
    );
  }

  function renderStory(s) {
    var url = safeUrl(s.url);
    var host = hostOf(url);
    var when = timeAgo(s.published);
    var saved = isSaved(s.url);
    var read = isRead(s.url);
    var angles = "";
    if ((s.gd_for && s.gd_for.length) || (s.gd_against && s.gd_against.length)) {
      angles =
        '<div class="angles">' +
          '<div class="angle for"><div class="label">For</div><ul>' +
            (s.gd_for || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>" +
          '<div class="angle against"><div class="label">Against / other views</div><ul>' +
            (s.gd_against || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>" +
        "</div>";
    }
    var heading = url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + "</a>"
      : esc(s.title);
    var coverage = s.sources_count > 1
      ? '<span class="pill">' + esc(s.sources_count) + " sources</span>" : "";
    var fact = "";
    if (s.key_fact) {
      fact =
        '<div class="fact' + (s.fact_is_context ? " context" : "") + '">' +
          '<span class="mark" aria-hidden="true">&ldquo;</span>' +
          "<div><strong>" + (s.fact_is_context ? "Background, verify before quoting" : "Quote this") +
          "</strong> " + esc(s.fact_is_context ? s.key_fact.replace(/^context:\s*/i, "") : s.key_fact) + "</div>" +
        "</div>";
    }
    var summary = s.summary && !/^Open the source link/i.test(s.summary) ? s.summary : "";
    var watched = watchMatches(s);
    var watchBadge = watched.length
      ? '<span class="watch-pill" title="On your watchlist">' + esc(watched[0].label) + "</span>" : "";
    var readLink = url
      ? '<a class="read-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Read at ' + esc(s.source || host) + ' <span aria-hidden="true">&#8599;</span></a>'
      : "";
    return (
      '<article class="story' + (read ? " is-read" : "") + (s.ai ? "" : " is-plain") + '" data-url="' + esc(s.url) + '">' +
        "<h3>" + heading + "</h3>" +
        '<div class="src">' + esc(s.source) + (host ? " (" + esc(host) + ")" : "") +
          (when ? ", " + esc(when) : "") + " " + coverage + watchBadge + "</div>" +
        (summary ? '<p class="summary">' + esc(summary) + "</p>" : "") +
        (s.why_it_matters ? '<p class="matters"><strong>Why it matters:</strong> ' + esc(s.why_it_matters) + "</p>" : "") +
        (s.business_impact ? '<p class="impact"><strong>Business impact:</strong> ' + esc(s.business_impact) + "</p>" : "") +
        angles +
        fact +
        (s.key_term && s.key_term.term
          ? '<p class="term"><span class="term-label">Term to know</span><strong>' + esc(s.key_term.term) + "</strong> " + esc(s.key_term.meaning || "") + "</p>"
          : "") +
        '<div class="story-actions">' +
          readLink +
          '<button class="icon-act" type="button" data-act="save" aria-pressed="' + saved + '" aria-label="Save for revision" title="Save for revision">' + ICON.star + "</button>" +
          '<button class="icon-act" type="button" data-act="read" aria-pressed="' + read + '" aria-label="Mark as read" title="Mark as read">' + ICON.check + "</button>" +
          '<button class="icon-act" type="button" data-act="share" aria-label="Share story" title="Share story">' + ICON.share + "</button>" +
        "</div>" +
      "</article>"
    );
  }

  function renderCategory(c, index) {
    var open = openState.hasOwnProperty(c.key) ? openState[c.key] : true;
    var list = c.stories || [];
    var stories = list.map(renderStory).join("");
    if (!stories) stories = '<p class="plain" style="padding:1rem 0">No fresh stories were found in this category today.</p>';
    return (
      '<details class="category" id="cat-' + esc(c.key) + '" data-key="' + esc(c.key) + '"' + (open ? " open" : "") + ">" +
        '<summary><span class="chev" aria-hidden="true"></span><span class="cat-dot" aria-hidden="true"></span>' + esc(c.title) +
          '<span class="count">' + list.length + " stories</span></summary>" +
        '<div class="body">' + stories + "</div>" +
      "</details>"
    );
  }

  function renderChips(b) {
    var cats = (b.categories || []).filter(function (c) { return (c.stories || []).length; });
    if (!cats.length) return "";
    return (
      '<div class="stickybar">' +
        '<nav class="chips" aria-label="Jump to a section">' +
          cats.map(function (c) {
            return '<button class="chip" type="button" data-cat="' + esc(c.key) + '" data-jump="' + esc(c.key) + '">' +
              esc(c.title.split(/[,&:]/)[0].trim()) + " <span>" + (c.stories || []).length + "</span></button>";
          }).join("") +
        "</nav>" +
        '<div class="progress">' +
          '<div class="progress-track" aria-hidden="true"><div class="progress-fill"></div></div>' +
          '<span class="progress-label" aria-live="polite"></span>' +
          '<button class="link-btn" type="button" data-toggle-all="1">Expand all</button>' +
        "</div>" +
      "</div>"
    );
  }

  function renderSavedView() {
    var map = savedMap();
    var items = Object.keys(map).map(function (k) { return map[k]; });
    var body = items.length
      ? items.reverse().map(function (s) {
          var url = safeUrl(s.url);
          return (
            '<article class="story" data-url="' + esc(s.url) + '">' +
              "<h3>" + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + "</a>" : esc(s.title)) + "</h3>" +
              '<div class="src">' + esc(s.source) + (s.date ? ", " + esc(s.date) : "") + "</div>" +
              (s.summary ? '<p class="summary">' + esc(s.summary) + "</p>" : "") +
              (s.key_fact ? '<div class="fact"><span class="mark" aria-hidden="true">&ldquo;</span><div>' + esc(s.key_fact) + "</div></div>" : "") +
              '<div class="story-actions"><button class="chip-btn" type="button" data-act="unsave">Remove</button></div>' +
            "</article>"
          );
        }).join("")
      : '<p class="plain">Nothing saved yet. Tap “Save” on any story to keep it here for revision.</p>';
    return (
      '<section class="saved-view">' +
        "<h2>Saved stories</h2>" +
        '<div class="category"><div class="body">' + body + "</div></div>" +
        '<div class="toolbar"><button class="text-btn" type="button" data-close-saved="1">Back to the brief</button>' +
          (items.length ? '<button class="text-btn" type="button" data-clear-saved="1">Clear all</button>' : "") +
        "</div>" +
      "</section>"
    );
  }

  function renderSearch() {
    if (!archiveIndex.length) return "";
    return (
      '<div class="search">' +
        '<label class="sr-only" for="archive-search">Search past briefs</label>' +
        '<input id="archive-search" type="search" placeholder="Search past GD topics and concepts…" autocomplete="off">' +
        '<div class="search-results" id="search-results"></div>' +
      "</div>"
    );
  }

  // ---------- page ----------
  function renderBrief(b) {
    currentBrief = b;
    var aiNote = "";
    // Commentary that the morning run missed is filled in by later runs (07:47 to
    // 18:17 IST). Say so quietly on today's brief; say nothing on past days.
    var pending = (b.story_count || 0) - (b.ai_story_count || 0);
    var hourIST = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
    if (b.ai_enabled && pending > 0 && b.date === todayIST() && hourIST < 19) {
      aiNote = '<p class="pending-note"><span class="dot" aria-hidden="true"></span>' +
        (b.ai_story_count ? "Analysis on " + pending + " more " + (pending === 1 ? "story" : "stories") + " lands later today."
                          : "Today\'s analysis is still being written. Headlines first, notes later this morning.") +
        "</p>";
    }
    renderMasthead(b);

    // The cover (inside the indigo band) carries the notices and the GD topic.
    if (coverEl) coverEl.innerHTML = renderStaleNotice(b) + aiNote + renderHero(b.gd_topic);

    // Desktop: section rail | stories | concept and weekly card. On phones the
    // rails fold into the flow (see .layout in style.css).
    var html =
      renderQuick(b) +
      '<div class="layout">' +
        '<aside class="rail-left" aria-label="Sections">' + renderChips(b) + "</aside>" +
        '<aside class="rail-right">' + renderWatchToday(b) + '<div id="next-up"></div>' +
          renderConcept(b.concept) + renderWeekTeaser() + "</aside>" +
        '<div class="main">' +
          (b.categories || []).map(renderCategory).join("") +
          renderSearch();

    var failed = b.sources_failed || [];
    var aiErrors = b.ai_errors || [];
    html +=
      '<div class="sources">' +
        "<details><summary>How this brief was built</summary>" +
          "<p>Worked: " + esc((b.sources_ok || []).join(", ") || "none") + "</p>" +
          (failed.length ? "<p>Could not fetch: " + esc(failed.join(", ")) + "</p>" : "") +
          (b.ai_model ? "<p>Commentary model: " + esc(b.ai_model) + "</p>" : "") +
          (b.grounding
            ? "<p>Fact check: every number in the notes was compared with the article text" +
              (b.grounding.removed ? "; " + esc(b.grounding.removed) + " unsupported line" + (b.grounding.removed === 1 ? " was" : "s were") + " removed." : "; nothing needed removing.") + "</p>"
            : "") +
          (aiErrors.length ? "<p>Model log: " + esc(aiErrors.join("; ")) + "</p>" : "") +
          (b.story_cap ? "<p>Daily cap: " + esc(b.story_cap) + " stories</p>" : "") +
          "<p>Generated " + esc(new Date(b.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })) + " IST</p>" +
        "</details>" +
      "</div>" +
      "</div></div>";

    app.innerHTML = html;
    document.title = "The Brief \u00b7 " + shortDate(b.date, b.date_label);
    wireUp(b);
  }

  function wireUp(b) {
    app.querySelectorAll("details.category").forEach(function (d) {
      d.addEventListener("toggle", function () { openState[d.dataset.key] = d.open; });
    });
    var toggleAll = app.querySelector("[data-toggle-all]");
    function syncToggleAll() {
      if (!toggleAll) return;
      var all = app.querySelectorAll("details.category");
      var allOpen = Array.prototype.every.call(all, function (d) { return d.open; });
      toggleAll.textContent = allOpen ? "Collapse all" : "Expand all";
    }
    if (toggleAll) {
      toggleAll.addEventListener("click", function () {
        var all = app.querySelectorAll("details.category");
        var open = !Array.prototype.every.call(all, function (d) { return d.open; });
        all.forEach(function (d) { d.open = open; openState[d.dataset.key] = open; });
        syncToggleAll();
      });
      app.querySelectorAll("details.category").forEach(function (d) { d.addEventListener("toggle", syncToggleAll); });
      syncToggleAll();
    }
    // Opening the full story counts as reading it.
    app.querySelectorAll(".story .read-link, .story h3 a").forEach(function (a) {
      a.addEventListener("click", function () {
        var article = a.closest(".story");
        var url = article.getAttribute("data-url");
        markRead(url);
        article.classList.add("is-read");
        var rb = article.querySelector('[data-act="read"]');
        if (rb) rb.setAttribute("aria-pressed", "true");
        updateProgress();
      });
    });
    app.querySelectorAll("[data-jump]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = document.getElementById("cat-" + btn.dataset.jump);
        if (!target) return;
        target.open = true;
        openState[btn.dataset.jump] = true;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    app.querySelectorAll("button.copy").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var text = btn.getAttribute("data-copy");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            var lbl = btn.querySelector("span") || btn;
            lbl.textContent = "Copied";
            btn.classList.add("is-done");
            setTimeout(function () { lbl.textContent = "Copy"; btn.classList.remove("is-done"); }, 1500);
          });
        }
      });
    });
    var shareTopic = app.querySelector("[data-share-topic]");
    if (shareTopic && b.gd_topic) {
      shareTopic.addEventListener("click", function () {
        shareOrCopy("Today's GD topic",
          b.gd_topic.topic + "\n\n" + (b.gd_topic.opening_line || ""), location.href, shareTopic);
      });
    }

    // per-story actions
    app.querySelectorAll(".story .story-actions button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var article = btn.closest(".story");
        var url = article.getAttribute("data-url");
        var story = findStory(b, url);
        var act = btn.dataset.act;
        if (act === "save" && story) {
          var nowSaved = toggleSaved(story, b.date_label || b.date);
          btn.setAttribute("aria-pressed", String(nowSaved));
          updateSavedCount();
        } else if (act === "read") {
          var nowRead = toggleRead(url);
          article.classList.toggle("is-read", nowRead);
          btn.setAttribute("aria-pressed", String(nowRead));
          updateProgress();
        } else if (act === "share" && story) {
          var text = story.title + (story.key_fact ? "\n\n" + story.key_fact : "");
          shareOrCopy(story.title, text, safeUrl(story.url), btn);
        } else if (act === "unsave") {
          var map = savedMap();
          delete map[url];
          writeStore(SAVED_KEY, map);
          article.remove();
          updateSavedCount();
        }
      });
    });

    app.querySelectorAll("[data-goto]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = app.querySelector('.story[data-url="' + CSS.escape(btn.dataset.goto) + '"]');
        if (!target) return;
        var det = target.closest("details");
        if (det) det.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.classList.add("is-flash");
        setTimeout(function () { target.classList.remove("is-flash"); }, 1600);
      });
    });
    var shareTopicBtn = coverEl && coverEl.querySelector("[data-share-topic]");
    if (shareTopicBtn && b.gd_topic && !shareTopicBtn.dataset.wired) {
      shareTopicBtn.dataset.wired = "1";
      shareTopicBtn.addEventListener("click", function () {
        shareOrCopy("Today's GD topic",
          b.gd_topic.topic + "\n\n" + (b.gd_topic.opening_line || ""), location.href, shareTopicBtn);
      });
    }
    if (coverEl) coverEl.querySelectorAll("button.copy").forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", function () {
        var text = btn.getAttribute("data-copy");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            var lbl = btn.querySelector("span") || btn;
            lbl.textContent = "Copied";
            btn.classList.add("is-done");
            setTimeout(function () { lbl.textContent = "Copy"; btn.classList.remove("is-done"); }, 1500);
          });
        }
      });
    });
    if (window.TB && TB.fillNextUp) TB.fillNextUp(document.getElementById("next-up"));
    wireSearch();
    updateProgress();
  }

  function wireSavedView() {
    app.querySelectorAll(".story-actions button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var article = btn.closest(".story");
        var map = savedMap();
        delete map[article.getAttribute("data-url")];
        writeStore(SAVED_KEY, map);
        article.remove();
      });
    });
    var back = app.querySelector("[data-close-saved]");
    if (back) back.addEventListener("click", function () { if (currentBrief) renderBrief(currentBrief); });
    var clear = app.querySelector("[data-clear-saved]");
    if (clear) clear.addEventListener("click", function () {
      writeStore(SAVED_KEY, {});
      app.innerHTML = renderSavedView();
      wireSavedView();
    });
  }

  function updateSavedCount() {
    var n = Object.keys(savedMap()).length;
    var badge = document.getElementById("saved-count");
    if (badge) { badge.textContent = n ? String(n) : ""; badge.hidden = !n; }
    var btn = document.getElementById("saved-btn");
    if (btn) btn.setAttribute("aria-label", "Saved stories" + (n ? ", " + n : ""));
  }
  var savedBtnEl = document.getElementById("saved-btn");
  if (savedBtnEl) {
    savedBtnEl.addEventListener("click", function () {
      app.innerHTML = renderSavedView();
      wireSavedView();
      window.scrollTo({ top: 0 });
    });
  }

  function findStory(b, url) {
    var found = null;
    (b.categories || []).forEach(function (c) {
      (c.stories || []).forEach(function (s) { if (s.url === url) found = s; });
    });
    return found;
  }

  function wireSearch() {
    var input = document.getElementById("archive-search");
    var out = document.getElementById("search-results");
    if (!input || !out) return;
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      if (q.length < 2) { out.innerHTML = ""; return; }
      var hits = archiveIndex.filter(function (e) {
        return ((e.gd_topic || "") + " " + (e.concept || "") + " " + (e.label || "") + " " + (e.date || ""))
          .toLowerCase().indexOf(q) !== -1;
      }).slice(0, 12);
      out.innerHTML = hits.length
        ? hits.map(function (e) {
            return '<button class="search-hit" type="button" data-date="' + esc(e.date) + '">' +
              "<strong>" + esc(e.label || e.date) + "</strong>" +
              (e.gd_topic ? "<span>" + esc(e.gd_topic) + "</span>" : "") +
              (e.concept ? '<span class="dim">Concept: ' + esc(e.concept) + "</span>" : "") +
              "</button>";
          }).join("")
        : '<p class="plain">No past brief matches that.</p>';
      out.querySelectorAll("[data-date]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          dateSelect.value = btn.dataset.date;
          dateSelect.dispatchEvent(new Event("change"));
        });
      });
    });
  }

  // ---------- data loading ----------
  function loadDay(date) {
    var url = date ? "data/archive/" + date + ".json" : "data/latest.json";
    showStatus("Loading " + (date || "today's") + " brief…");
    return fetchJSON(url).then(function (b) { b._requested = date || ""; renderBrief(b); }).catch(function (err) {
      showStatus(
        "Could not load the brief (" + err.message + "). " +
        "If this is a fresh setup, run the workflow once from the Actions tab and wait a couple of minutes.",
        true
      );
    });
  }

  function loadIndex() {
    return fetchJSON("data/archive/index.json").then(function (list) {
      if (!Array.isArray(list)) return;
      archiveIndex = list.filter(function (e) { return e && e.date; });
      archiveIndex.forEach(function (entry) {
        var opt = document.createElement("option");
        opt.value = entry.date;
        var d = parseDay(entry.date);
        opt.textContent = d
          ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
          : (entry.label || entry.date);
        if (entry.gd_topic) opt.title = entry.gd_topic;
        dateSelect.appendChild(opt);
      });
    }).catch(function () { /* archive is optional */ });
  }

  // ======================================================================
  // This week: themes, GD topics, concept cards and a quiz built only from
  // the week's verified facts. Everything is computed in the browser from
  // the archived briefs, so nothing here is generated or invented.
  // ======================================================================
  var STOP = ("A An The And Or Of In On At To For From With By As Is Are Was Were Be Been After Before Over Under Into " +
    "Amid Says Said New How Why What Who When Will Can May Could Should Its It His Her Their Our Your This That " +
    "These Those Than Then Not No Yes Up Down Out Off Explained Live Updates Report Reports Day Week Year Govt " +
    "Q1 Q2 Q3 Q4 Mr Ms Dr Top Big First Last Next Talks Deal Plan Bid Set Gets Get To").split(" ");
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w.toLowerCase()] = 1; });
  // Words too common to be a "thread" on their own.
  var GENERIC = ("india indian indians centre central government govt delhi new world global country nation national " +
    "state states people company companies market markets bank banks business year years week today news report " +
    "minister ministry pm chief court police city cities top key sector firms firm india's us u.s").split(" ");
  var GENSET = {};
  GENERIC.forEach(function (w) { GENSET[w] = 1; });
  var LABELS = { ai: "AI", fta: "FTA", gst: "GST", ipo: "IPO", repo: "Repo rate", tariffs: "Tariffs", tariff: "Tariffs",
    crude: "Crude oil", oil: "Crude oil", forex: "Forex reserves", rupee: "Rupee", startups: "Startups", startup: "Startups" };
  var KEYWORDS = ["tariff", "tariffs", "fta", "inflation", "repo", "gst", "ipo", "ai", "climate", "election",
    "budget", "rupee", "forex", "crude", "oil", "semiconductor", "startup", "startups", "monsoon", "ceasefire"];

  function weekDates(endIso) {
    var end = parseDay(endIso);
    if (!end) return [];
    var out = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(end.getTime() - i * 86400000);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function themesFor(briefs) {
    var seen = {};          // phrase -> {days:{}, items:[]}
    briefs.forEach(function (b) {
      (b.categories || []).forEach(function (c) {
        (c.stories || []).forEach(function (s) {
          var title = String(s.title || "").replace(/[‘’]/g, "'");
          var found = {};
          var words = title.split(/[^A-Za-z0-9'-]+/).filter(Boolean);
          for (var i = 0; i < words.length; i++) {
            var w = words[i].replace(/'s$/, "");
            var low = w.toLowerCase();
            if (KEYWORDS.indexOf(low) !== -1) { found[LABELS[low] || (low.charAt(0).toUpperCase() + low.slice(1))] = 1; continue; }
            if (!/^[A-Z]/.test(w) || STOPSET[low] || w.length < 3) continue;
            // join consecutive capitalised words: "West Asia", "Tata Motors"
            var phrase = w;
            while (i + 1 < words.length && /^[A-Z]/.test(words[i + 1]) && !STOPSET[words[i + 1].toLowerCase()]) {
              phrase += " " + words[i + 1].replace(/'s$/, "");
              i++;
              if (phrase.split(" ").length >= 3) break;
            }
            if (phrase.indexOf(" ") === -1 && GENSET[phrase.toLowerCase()]) continue;
            found[phrase] = 1;
          }
          Object.keys(found).forEach(function (p) {
            var key = p.toLowerCase();
            if (!seen[key]) seen[key] = { label: p, days: {}, items: [] };
            seen[key].days[b.date] = 1;
            if (seen[key].items.length < 4) seen[key].items.push({ s: s, date: b.date });
          });
        });
      });
    });
    var list = Object.keys(seen).map(function (k) { return seen[k]; })
      .filter(function (t) { return Object.keys(t.days).length >= 2; })
      .sort(function (a, b) {
        var sa = Object.keys(a.days).length * 2 + (a.label.indexOf(" ") !== -1 ? 1.5 : 0) + a.items.length * .1;
        var sb = Object.keys(b.days).length * 2 + (b.label.indexOf(" ") !== -1 ? 1.5 : 0) + b.items.length * .1;
        return sb - sa;
      });
    // drop themes contained in a stronger one ("Iran" vs "Iran War" keeps the first seen)
    var out = [];
    list.forEach(function (t) {
      var low = t.label.toLowerCase();
      if (out.some(function (o) { var l = o.label.toLowerCase(); return l.indexOf(low) !== -1 || low.indexOf(l) !== -1; })) return;
      if (out.length < 6) out.push(t);
    });
    return out;
  }

  // ---- quiz -------------------------------------------------------------
  var NUM_RX = /(?:[$₹€£]\s?|Rs\.?\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|per cent|bn|billion|crore|lakh|million|trillion|tonnes|km|hours|days|months|years)\b|B\b|%)?/g;
  var MONTH_BEFORE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i;
  function pickNumber(fact) {
    var best = null, m;
    NUM_RX.lastIndex = 0;
    while ((m = NUM_RX.exec(fact))) {
      var tok = m[0].replace(/[,.]+$/, "").trim();
      var before = fact.slice(0, m.index);
      var after = fact.slice(m.index + m[0].length, m.index + m[0].length + 4);
      if (/^\s?(am|pm|a\.m|p\.m)\b/i.test(after)) continue;   // a clock time
      var plain = tok.replace(/[^\d.]/g, "");
      var hasUnit = /[%$₹€£]|Rs|bn|billion|crore|lakh|million|trillion|hours|days|months|years|B$/i.test(tok);
      if (/^(19|20)\d\d$/.test(plain) && !hasUnit) continue;     // a year
      if (MONTH_BEFORE.test(before)) continue;                    // "October 24"
      if (!hasUnit && !(parseFloat(plain) > 12) && plain.indexOf(".") === -1) continue;
      var score = (hasUnit ? 2 : 0) + tok.length / 10;
      if (!best || score > best.score) best = { tok: tok, score: score };
    }
    return best && best.tok;
  }
  // Answer choices must share currency and unit: "$719.74 billion" never sits
  // beside "Rs 8,387 crore".
  function kindOf(tok) {
    var cur = /[$]/.test(tok) ? "usd" : /₹|Rs/.test(tok) ? "inr" : /€/.test(tok) ? "eur" : /£/.test(tok) ? "gbp" : "";
    var unit = (tok.match(/%|per cent|bn|billion|crore|lakh|million|trillion|tonnes|km|B$/i) || [""])[0].toLowerCase();
    if (unit === "per cent") unit = "%";
    if (unit === "bn" || unit === "b") unit = "billion";
    return cur + "|" + unit;
  }
  function scaleTok(tok, f) {
    return tok.replace(/\d[\d,]*(?:\.\d+)?/, function (n) {
      var dec = (n.split(".")[1] || "").length;
      var v = parseFloat(n.replace(/,/g, "")) * f;
      var s = v.toFixed(dec);
      return n.indexOf(",") !== -1 ? Number(s).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : s;
    });
  }
  function seeded(seed) {
    var x = 0;
    for (var i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0;
    return function () { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  }
  function buildQuiz(briefs, seed) {
    var rnd = seeded(seed);
    var facts = [];
    briefs.forEach(function (b) {
      (b.categories || []).forEach(function (c) {
        (c.stories || []).forEach(function (s) {
          if (!s.ai || !s.key_fact || s.fact_is_context) return;
          var tok = pickNumber(s.key_fact);
          if (tok) facts.push({ s: s, tok: tok, kind: kindOf(tok), date: b.date, cat: c.key });
        });
      });
    });
    // spread across sections and days
    facts.sort(function () { return rnd() - 0.5; });
    var chosen = [], usedCat = {};
    facts.forEach(function (f) {
      if (chosen.length >= 8) return;
      var k = f.cat + f.date;
      if (usedCat[k]) return;
      usedCat[k] = 1;
      chosen.push(f);
    });
    return chosen.map(function (f) {
      var pool = facts.filter(function (o) { return o !== f && o.kind === f.kind && o.tok !== f.tok; })
        .map(function (o) { return o.tok; });
      var opts = [];
      pool.sort(function () { return rnd() - 0.5; }).forEach(function (t) {
        if (opts.length < 3 && opts.indexOf(t) === -1) opts.push(t);
      });
      [0.5, 1.5, 2, 0.75].forEach(function (k) {
        var t = scaleTok(f.tok, k);
        if (opts.length < 3 && t !== f.tok && opts.indexOf(t) === -1) opts.push(t);
      });
      opts.push(f.tok);
      opts.sort(function () { return rnd() - 0.5; });
      return {
        prompt: f.s.key_fact.replace(f.tok, "_____"),
        answer: f.tok, options: opts, story: f.s, date: f.date
      };
    });
  }

  var weekState = null;

  function renderWeek(briefs, dates) {
    var first = parseDay(dates[0]), last = parseDay(dates[dates.length - 1]);
    var fmt = function (d, opt) { return d.toLocaleDateString("en-IN", Object.assign({ timeZone: "UTC" }, opt)); };
    var range = first.getUTCMonth() === last.getUTCMonth()
      ? fmt(first, { day: "numeric" }) + "–" + fmt(last, { day: "numeric", month: "long" })
      : fmt(first, { day: "numeric", month: "short" }) + " – " + fmt(last, { day: "numeric", month: "short" });
    var stories = 0;
    briefs.forEach(function (b) { stories += b.story_count || 0; });

    kickerEl.textContent = "The week in review";
    datelineEl.textContent = range;
    metaEl.textContent = briefs.length + " briefs, " + stories + " stories, every fact from a vetted source";

    var themes = themesFor(briefs);
    var quiz = buildQuiz(briefs, dates[dates.length - 1]);
    weekState = { quiz: quiz, answered: 0, correct: 0 };

    coverEl.innerHTML =
      '<section class="hero week-hero" aria-labelledby="themes-h">' +
        '<div class="kicker">What kept coming back</div>' +
        '<h2 id="themes-h">' + (themes.length
          ? esc(themes.slice(0, 3).map(function (t) { return t.label; }).join(", ")) + (themes.length > 3 ? " and more" : "")
          : "A quieter week") + "</h2>" +
        '<p class="why">The stories that ran on more than one day. Follow a thread to see how it developed.</p>' +
        '<div class="hero-actions"><button class="text-btn" type="button" data-back-today="1">Back to today\'s brief</button></div>' +
      "</section>";

    var html = '<div id="watch-week"></div>';
    if (themes.length) {
      html += '<section class="wk-block" aria-labelledby="threads-h"><h2 id="threads-h">Threads to follow</h2>' +
        '<div class="threads">' + themes.map(function (t) {
          var days = Object.keys(t.days).length;
          return '<details class="thread"><summary><span class="thread-name">' + esc(t.label) + "</span>" +
            '<span class="thread-days">' + days + " days</span></summary><ul>" +
            t.items.map(function (it) {
              var u = safeUrl(it.s.url);
              return "<li>" + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(it.s.title) + "</a>" : esc(it.s.title)) +
                '<span class="dim">' + esc(it.s.source) + ", " + esc(shortDate(it.date)) + "</span></li>";
            }).join("") + "</ul></details>";
        }).join("") + "</div></section>";
    }

    var topics = briefs.filter(function (b) { return b.gd_topic && b.gd_topic.topic && !b.gd_topic.fallback; });
    if (topics.length) {
      html += '<section class="wk-block" aria-labelledby="topics-h"><h2 id="topics-h">This week\'s GD topics</h2>' +
        '<p class="wk-sub">Say each one out loud. Could you open and close on it?</p><ol class="wk-topics">' +
        topics.map(function (b) {
          return '<li><details><summary><span class="wk-date">' + esc(shortDate(b.date)) + "</span>" +
            '<span class="wk-topic">' + esc(b.gd_topic.topic) + "</span></summary>" +
            (b.gd_topic.opening_line ? '<p><strong>Open with:</strong> ' + esc(b.gd_topic.opening_line) + "</p>" : "") +
            (b.gd_topic.closing_line ? '<p><strong>Close with:</strong> ' + esc(b.gd_topic.closing_line) + "</p>" : "") +
            '<button class="link-btn" type="button" data-open-day="' + esc(b.date) + '">Open that day\'s brief</button>' +
            "</details></li>";
        }).join("") + "</ol></section>";
    }

    if (quiz.length >= 3) {
      html += '<section class="wk-block quiz" aria-labelledby="quiz-h"><h2 id="quiz-h">Test yourself</h2>' +
        '<p class="wk-sub">Fill the gap in each fact from this week. <span class="quiz-score" aria-live="polite">0 of ' + quiz.length + "</span></p>" +
        quiz.map(function (q, i) {
          return '<div class="q" data-q="' + i + '"><p class="q-prompt">' + esc(q.prompt) + "</p>" +
            '<div class="q-opts">' + q.options.map(function (o) {
              return '<button class="q-opt" type="button" data-opt="' + esc(o) + '">' + esc(o) + "</button>";
            }).join("") + "</div>" +
            '<p class="q-src" hidden>From ' + esc(q.story.source) + ", " + esc(shortDate(q.date)) + ": " + esc(q.story.title) + "</p></div>";
        }).join("") + "</section>";
    }

    var concepts = briefs.filter(function (b) { return b.concept && b.concept.name; });
    if (concepts.length) {
      html += '<section class="wk-block" aria-labelledby="concepts-h"><h2 id="concepts-h">Concepts to recall</h2>' +
        '<p class="wk-sub">Try to explain each one before you open it.</p><div class="cards">' +
        concepts.map(function (b) {
          return '<details class="card"><summary><span class="wk-date">' + esc(shortDate(b.date)) + "</span>" +
            '<span class="card-name">' + esc(b.concept.name) + "</span></summary>" +
            "<p>" + esc(b.concept.explanation || "") + "</p>" +
            (b.concept.use_in_gd ? '<p class="dim"><strong>In a GD:</strong> ' + esc(b.concept.use_in_gd) + "</p>" : "") +
            "</details>";
        }).join("") + "</div></section>";
    }

    app.innerHTML = html;
    if (window.TB && TB.fillWatchWeek) TB.fillWatchWeek(document.getElementById("watch-week"));
    document.title = "The Brief · Week of " + shortDate(dates[0]);

    coverEl.querySelector("[data-back-today]").addEventListener("click", function () { goTab("today"); });
    app.querySelectorAll("[data-open-day]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        leaveWeek(btn.dataset.openDay);
      });
    });
    app.querySelectorAll(".q").forEach(function (box) {
      var q = quiz[+box.dataset.q];
      box.querySelectorAll(".q-opt").forEach(function (b) {
        b.addEventListener("click", function () {
          if (box.classList.contains("is-done")) return;
          box.classList.add("is-done");
          var right = b.dataset.opt === q.answer;
          weekState.answered++;
          if (right) weekState.correct++;
          box.querySelectorAll(".q-opt").forEach(function (o) {
            if (o.dataset.opt === q.answer) o.classList.add("is-right");
            else if (o === b) o.classList.add("is-wrong");
            o.disabled = true;
          });
          box.querySelector(".q-prompt").textContent = q.story.key_fact;
          box.querySelector(".q-src").hidden = false;
          var sc = app.querySelector(".quiz-score");
          sc.textContent = weekState.correct + " of " + quiz.length +
            (weekState.answered === quiz.length ? (weekState.correct >= quiz.length - 1 ? ". Sharp week." : ". Re-read the ones you missed.") : "");
        });
      });
    });
  }

  function openWeek() {
    var end = (currentBrief && currentBrief.date) || todayIST();
    var dates = weekDates(end);
    var have = {};
    archiveIndex.forEach(function (e) { have[e.date] = 1; });
    var wanted = dates.filter(function (d) { return have[d]; });
    showStatus("Putting the week together…");
    return Promise.all(wanted.map(function (d) {
      return fetchJSON("data/archive/" + d + ".json").catch(function () { return null; });
    })).then(function (list) {
      renderWeek(list.filter(Boolean), dates);
      window.scrollTo({ top: 0 });
    });
  }
  function leaveWeek(date) {
    if (date) { dateSelect.value = date; dateSelect.dispatchEvent(new Event("change")); return; }
    goTab("today");
  }

  // ---------- tabs and routing ----------
  // Views live in the URL hash (#week, #upcoming, #library, #review) so each
  // one can be bookmarked or shared. Today is the default.
  var TABS = ["today", "week", "upcoming", "library", "review"];
  function currentTab() {
    var h = (location.hash || "").replace("#", "");
    return TABS.indexOf(h) !== -1 ? h : "today";
  }
  function setActiveNav(tab) {
    document.body.setAttribute("data-tab", tab);
    document.querySelectorAll("[data-tab-link]").forEach(function (a) {
      if (a.getAttribute("data-tab-link") === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  function goTab(tab) {
    if (currentTab() === tab && tab === "today") { route(); return; }
    location.hash = tab === "today" ? "today" : tab;
  }
  function route() {
    var tab = currentTab();
    setActiveNav(tab);
    window.scrollTo({ top: 0 });
    if (tab === "week") return openWeek();
    if (tab !== "today" && window.TB && TB.views && TB.views[tab]) return TB.views[tab]();
    if (currentBrief && (dateSelect.value || "") === (currentBrief._requested || "")) {
      renderBrief(currentBrief);
      return Promise.resolve();
    }
    return loadDay(dateSelect.value);
  }
  window.addEventListener("hashchange", route);

  // Shared helpers for the extra views in tabs.js.
  window.TB = window.TB || {};
  Object.assign(window.TB, {
    esc: esc, safeUrl: safeUrl, fetchJSON: fetchJSON, parseDay: parseDay, shortDate: shortDate,
    todayIST: todayIST, showStatus: showStatus, readStore: readStore, writeStore: writeStore,
    ICON: ICON, app: app, kickerEl: kickerEl, datelineEl: datelineEl, metaEl: metaEl, coverEl: coverEl,
    archive: function () { return archiveIndex; }, goTab: goTab,
    watch: { topics: WATCH_TOPICS, state: watchState, save: saveWatch, active: activeTopics, matches: watchMatches }
  });

  dateSelect.addEventListener("change", function () {
    var date = dateSelect.value;
    var params = new URLSearchParams(window.location.search);
    if (date) params.set("date", date); else params.delete("date");
    var qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : "") + "#today");
    setActiveNav("today");
    loadDay(date);
    window.scrollTo({ top: 0 });
  });

  var wanted = new URLSearchParams(window.location.search).get("date") || "";
  loadIndex().then(function () {
    if (wanted && dateSelect.querySelector('option[value="' + wanted + '"]')) dateSelect.value = wanted;
    else wanted = "";
    return route();
  });
})();
