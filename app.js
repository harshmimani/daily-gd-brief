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
    kickerEl.textContent = weekday ? weekday + (no ? ", edition " + no : "") : "Morning edition";
    datelineEl.textContent = d
      ? d.toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" })
      : (b.date_label || b.date || "");
    var parts = [];
    if (b.reading_time_min) parts.push(b.reading_time_min + " min read");
    if (b.story_count) parts.push(b.story_count + " stories");
    if ((b.sources_ok || []).length) parts.push(b.sources_ok.length + " sources");
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
    return m ? "<li><strong>" + esc(m[1]) + "</strong>" + esc(m[2]) + "</li>" : "<li>" + esc(p) + "</li>";
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

  function renderConcept(c) {
    if (!c || !c.name) return "";
    return (
      '<section class="concept" aria-labelledby="concept-name">' +
        '<div class="kicker">Concept of the day</div>' +
        '<h2 id="concept-name">' + esc(c.name) + "</h2>" +
        "<p>" + esc(c.explanation) + "</p>" +
        (c.indian_example ? '<div class="sub">Indian example</div><p>' + esc(c.indian_example) + "</p>" : "") +
        (c.use_in_gd ? '<div class="sub">How to use it in a GD</div><p>' + esc(c.use_in_gd) + "</p>" : "") +
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
          "<div><strong>" + (s.fact_is_context ? "Background (verify before quoting):" : "Quote this:") +
          "</strong> " + esc(s.key_fact) + "</div>" +
        "</div>";
    }
    var summary = s.summary && !/^Open the source link/i.test(s.summary) ? s.summary : "";
    var readLink = url
      ? '<a class="read-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Read at ' + esc(s.source || host) + ' <span aria-hidden="true">&#8599;</span></a>'
      : "";
    return (
      '<article class="story' + (read ? " is-read" : "") + (s.ai ? "" : " is-plain") + '" data-url="' + esc(s.url) + '">' +
        "<h3>" + heading + "</h3>" +
        '<div class="src">' + esc(s.source) + (host ? " (" + esc(host) + ")" : "") +
          (when ? ", " + esc(when) : "") + " " + coverage + "</div>" +
        (summary ? '<p class="summary">' + esc(summary) + "</p>" : "") +
        (s.why_it_matters ? '<p class="matters"><strong>Why it matters:</strong> ' + esc(s.why_it_matters) + "</p>" : "") +
        angles +
        fact +
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
    var open = openState.hasOwnProperty(c.key) ? openState[c.key] : index === 0;
    var list = c.stories || [];
    var stories = list.map(renderStory).join("");
    if (!stories) stories = '<p class="plain" style="padding:1rem 0">No fresh stories were found in this category today.</p>';
    return (
      '<details class="category" id="cat-' + esc(c.key) + '" data-key="' + esc(c.key) + '"' + (open ? " open" : "") + ">" +
        '<summary><span class="chev" aria-hidden="true"></span>' + esc(c.title) +
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
            return '<button class="chip" type="button" data-jump="' + esc(c.key) + '">' +
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

    var html =
      renderStaleNotice(b) +
      aiNote +
      renderHero(b.gd_topic) +
      renderConcept(b.concept) +
      renderChips(b) +

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
          (aiErrors.length ? "<p>Model log: " + esc(aiErrors.join("; ")) + "</p>" : "") +
          (b.story_cap ? "<p>Daily cap: " + esc(b.story_cap) + " stories</p>" : "") +
          "<p>Generated " + esc(new Date(b.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })) + " IST</p>" +
        "</details>" +
      "</div>";

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
    return fetchJSON(url).then(renderBrief).catch(function (err) {
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

  dateSelect.addEventListener("change", function () {
    var date = dateSelect.value;
    var params = new URLSearchParams(window.location.search);
    if (date) params.set("date", date); else params.delete("date");
    var qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    loadDay(date);
    window.scrollTo({ top: 0 });
  });

  var wanted = new URLSearchParams(window.location.search).get("date") || "";
  loadIndex().then(function () {
    if (wanted && dateSelect.querySelector('option[value="' + wanted + '"]')) dateSelect.value = wanted;
    else wanted = "";
    return loadDay(wanted);
  });
})();
