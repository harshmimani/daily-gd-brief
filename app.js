/* Daily GD Brief — front-end logic (no frameworks)
   Reads data/latest.json (or an archived day) and renders the page. */

(function () {
  "use strict";

  var app = document.getElementById("app");
  var dateSelect = document.getElementById("date-select");
  var themeToggle = document.getElementById("theme-toggle");
  var openState = {}; // remembers which categories are expanded when switching days

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function bust(url) {
    // Keep the phone from showing yesterday's cached JSON.
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
  function showStatus(msg, isError) {
    app.innerHTML = '<section class="status' + (isError ? " error" : "") + '"><p>' + esc(msg) + "</p></section>";
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

  // ---------- rendering ----------
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

  function renderHero(t) {
    if (!t) return "";
    var perspectives = Array.isArray(t.perspectives) && t.perspectives.length
      ? '<div class="perspectives"><div class="label">Different lenses</div><ul>' +
          t.perspectives.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>"
      : "";
    return (
      '<section class="hero" aria-labelledby="gd-topic">' +
        '<div class="kicker">Today\'s likely GD topic</div>' +
        '<h2 id="gd-topic">' + esc(t.topic) + "</h2>" +
        (t.why_now ? '<p class="why">' + esc(t.why_now) + "</p>" : "") +
        renderLine("Suggested opening", t.opening_line, true) +
        renderLine("Strong closing", t.closing_line, true) +
        perspectives +
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
    var host = hostOf(s.url);
    var when = timeAgo(s.published);
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
    return (
      '<article class="story">' +
        "<h3><a href=\"" + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + "</a></h3>" +
        '<div class="src">' + esc(s.source) + (host ? " (" + esc(host) + ")" : "") + (when ? ", " + esc(when) : "") +
          ' <a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">Read the article</a></div>' +
        (s.summary ? '<p class="summary">' + esc(s.summary) + "</p>" : "") +
        (s.why_it_matters ? '<p class="matters"><strong>Why it matters:</strong> ' + esc(s.why_it_matters) + "</p>" : "") +
        angles +
        (s.key_fact ? '<div class="fact"><span class="mark" aria-hidden="true">“</span><div><strong>Quote this:</strong> ' + esc(s.key_fact) + "</div></div>" : "") +
        (!s.ai && !s.why_it_matters ? '<p class="plain">AI commentary was not available for this story. Read the article and jot down one fact and one counter-argument.</p>' : "") +
      "</article>"
    );
  }

  function renderCategory(c, index) {
    var open = openState.hasOwnProperty(c.key) ? openState[c.key] : index === 0;
    var stories = (c.stories || []).map(renderStory).join("");
    if (!stories) stories = '<p class="plain" style="padding:1rem 0">No fresh stories were found in this category today.</p>';
    return (
      '<details class="category" data-key="' + esc(c.key) + '"' + (open ? " open" : "") + ">" +
        "<summary><span class=\"chev\" aria-hidden=\"true\"></span>" + esc(c.title) +
          '<span class="count">' + (c.stories || []).length + " stories</span></summary>" +
        '<div class="body">' + stories + "</div>" +
      "</details>"
    );
  }

  function renderBrief(b) {
    var sourcesOk = (b.sources_ok || []).length;
    var aiNote = "";
    if (!b.ai_enabled) {
      aiNote = '<span class="badge warn">AI commentary off for this day (no API key)</span>';
    } else if (!b.ai_story_count) {
      aiNote = '<span class="badge warn">AI commentary unavailable for this day (quota or error)</span>';
    } else if (b.ai_story_count < b.story_count) {
      aiNote = '<span class="badge">AI commentary on ' + b.ai_story_count + " of " + b.story_count + " stories</span>";
    }

    var html =
      '<section class="day">' +
        "<h1>" + esc(b.date_label || b.date) + "</h1>" +
        '<div class="meta"><span>' + esc(b.reading_time_min) + " min read</span><span>" +
          esc(b.story_count) + " stories</span><span>" + sourcesOk + " sources</span></div>" +
        (aiNote ? "<div>" + aiNote + "</div>" : "") +
      "</section>" +
      renderHero(b.gd_topic) +
      renderConcept(b.concept) +
      '<div class="toolbar">' +
        '<button class="text-btn" type="button" data-toggle="open">Expand all</button>' +
        '<button class="text-btn" type="button" data-toggle="close">Collapse all</button>' +
      "</div>" +
      (b.categories || []).map(renderCategory).join("");

    var failed = b.sources_failed || [];
    html +=
      '<div class="sources">' +
        "<details><summary>Sources checked (" + (sourcesOk + failed.length) + ")</summary>" +
          "<p>Worked: " + esc((b.sources_ok || []).join(", ") || "none") + "</p>" +
          (failed.length ? "<p>Could not fetch: " + esc(failed.join(", ")) + "</p>" : "") +
          (b.ai_model ? "<p>Commentary model: " + esc(b.ai_model) + "</p>" : "") +
          "<p>Generated " + esc(new Date(b.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })) + " IST</p>" +
        "</details>" +
      "</div>";

    app.innerHTML = html;
    document.title = "Daily GD Brief, " + (b.date_label || b.date);

    // remember open/closed state per category
    app.querySelectorAll("details.category").forEach(function (d) {
      d.addEventListener("toggle", function () { openState[d.dataset.key] = d.open; });
    });
    app.querySelectorAll("[data-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var open = btn.dataset.toggle === "open";
        app.querySelectorAll("details.category").forEach(function (d) { d.open = open; });
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
      list.forEach(function (entry) {
        if (!entry || !entry.date) return;
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
