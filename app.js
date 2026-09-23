/* Daily GD Brief — front-end logic (no frameworks), v2.
   Reads data/latest.json (or an archived day) and renders the page.
   Adds: stale-brief warning, category jump chips, save/read state, sharing,
   archive search, and link-scheme checks. */

(function () {
  "use strict";

  var app = document.getElementById("app");
  var dateSelect = document.getElementById("date-select");
  var themeToggle = document.getElementById("theme-toggle");
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

  // ---------- rendering pieces ----------
  function renderLine(label, text, copyable) {
    if (!text) return "";
    return (
      '<div class="line">' +
        '<div class="label">' + esc(label) + "</div>" +
        "<p>" + esc(text) + "</p>" +
        (copyable ? '<button class="copy" type="button" data-copy="' + esc(text) + '">Copy</button>' : "") +
      "</div>"
    );
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
      ? '<div class="perspectives"><div class="label">Different lenses</div><ul>' +
          t.perspectives.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>"
      : "";
    return (
      '<section class="hero" aria-labelledby="gd-topic">' +
        '<div class="kicker">Today\'s likely GD topic' + (t.fallback ? " (picked automatically)" : "") + "</div>" +
        '<h2 id="gd-topic">' + esc(t.topic) + "</h2>" +
        (t.why_now ? '<p class="why">' + esc(t.why_now) + "</p>" : "") +
        renderLine("Suggested opening", t.opening_line, true) +
        renderLine("Strong closing", t.closing_line, true) +
        perspectives +
        '<div class="hero-actions"><button class="text-btn" type="button" data-share-topic="1">Share this topic</button></div>' +
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
    return (
      '<article class="story' + (read ? " is-read" : "") + '" data-url="' + esc(s.url) + '">' +
        "<h3>" + heading + "</h3>" +
        '<div class="src">' + esc(s.source) + (host ? " (" + esc(host) + ")" : "") +
          (when ? ", " + esc(when) : "") + " " + coverage + "</div>" +
        (s.summary ? '<p class="summary">' + esc(s.summary) + "</p>" : "") +
        (s.why_it_matters ? '<p class="matters"><strong>Why it matters:</strong> ' + esc(s.why_it_matters) + "</p>" : "") +
        angles +
        fact +
        (!s.ai && !s.why_it_matters ? '<p class="plain">AI commentary was not available for this story. Read the article and note one fact and one counter-argument.</p>' : "") +
        '<div class="story-actions">' +
          '<button class="chip-btn" type="button" data-act="save">' + (saved ? "★ Saved" : "☆ Save") + "</button>" +
          '<button class="chip-btn" type="button" data-act="read">' + (read ? "Mark unread" : "Mark read") + "</button>" +
          '<button class="chip-btn" type="button" data-act="share">Share</button>' +
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
      '<nav class="chips" aria-label="Jump to a section">' +
        cats.map(function (c) {
          return '<button class="chip" type="button" data-jump="' + esc(c.key) + '">' +
            esc(c.title.split(/[,&:]/)[0].trim()) + " <span>" + (c.stories || []).length + "</span></button>";
        }).join("") +
      "</nav>"
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
    var sourcesOk = (b.sources_ok || []).length;
    var aiNote = "";
    if (!b.ai_enabled) {
      aiNote = '<span class="badge warn">AI commentary off for this day (no API key)</span>';
    } else if (!b.ai_story_count) {
      aiNote = '<span class="badge warn">AI commentary unavailable for this day (quota or error)</span>';
    } else if (b.ai_story_count < b.story_count) {
      aiNote = '<span class="badge">AI commentary on ' + b.ai_story_count + " of " + b.story_count + " stories</span>";
    }
    var savedCount = Object.keys(savedMap()).length;

    var html =
      renderStaleNotice(b) +
      '<section class="day">' +
        "<h1>" + esc(b.date_label || b.date) + "</h1>" +
        '<div class="meta"><span>' + esc(b.reading_time_min) + " min read</span><span>" +
          esc(b.story_count) + " stories</span><span>" + sourcesOk + " sources</span></div>" +
        (aiNote ? "<div>" + aiNote + "</div>" : "") +
      "</section>" +
      renderHero(b.gd_topic) +
      renderConcept(b.concept) +
      renderChips(b) +
      '<div class="toolbar">' +
        '<button class="text-btn" type="button" data-open-saved="1">Saved (' + savedCount + ")</button>" +
        '<button class="text-btn" type="button" data-toggle="open">Expand all</button>' +
        '<button class="text-btn" type="button" data-toggle="close">Collapse all</button>' +
      "</div>" +
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
          (aiErrors.length ? "<p>AI notes: " + esc(aiErrors.join("; ")) + "</p>" : "") +
          (b.story_cap ? "<p>Daily cap: " + esc(b.story_cap) + " stories</p>" : "") +
          "<p>Generated " + esc(new Date(b.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })) + " IST</p>" +
        "</details>" +
      "</div>";

    app.innerHTML = html;
    document.title = "Daily GD Brief, " + (b.date_label || b.date);
    wireUp(b);
  }

  function wireUp(b) {
    app.querySelectorAll("details.category").forEach(function (d) {
      d.addEventListener("toggle", function () { openState[d.dataset.key] = d.open; });
    });
    app.querySelectorAll("[data-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var open = btn.dataset.toggle === "open";
        app.querySelectorAll("details.category").forEach(function (d) { d.open = open; });
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
            btn.textContent = "Copied";
            setTimeout(function () { btn.textContent = "Copy"; }, 1500);
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
          btn.textContent = nowSaved ? "★ Saved" : "☆ Save";
          updateSavedCount();
        } else if (act === "read") {
          var nowRead = toggleRead(url);
          article.classList.toggle("is-read", nowRead);
          btn.textContent = nowRead ? "Mark unread" : "Mark read";
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

    var openSaved = app.querySelector("[data-open-saved]");
    if (openSaved) {
      openSaved.addEventListener("click", function () {
        app.innerHTML = renderSavedView();
        wireSavedView();
        window.scrollTo({ top: 0 });
      });
    }
    wireSearch();
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
    var btn = app.querySelector("[data-open-saved]");
    if (btn) btn.textContent = "Saved (" + Object.keys(savedMap()).length + ")";
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
        opt.textContent = entry.label || entry.date;
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
