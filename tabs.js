/* The Brief: extra views (Upcoming, Library, Review) and the watchlist.
   Loaded before app.js; app.js adds its shared helpers to window.TB, and the
   router calls TB.views[name]() when a tab is opened. Everything here reads
   the static data files built by scripts/build_derived.py, plus the
   hand-checked data/calendar.json. Nothing is generated in the browser. */

(function () {
  "use strict";
  var TB = (window.TB = window.TB || {});
  TB.views = TB.views || {};

  // ---------- small helpers ----------
  var cache = {};
  function load(url) {
    if (!cache[url]) cache[url] = TB.fetchJSON(url).catch(function (e) { delete cache[url]; throw e; });
    return cache[url];
  }
  function day(iso) { var d = TB.parseDay(String(iso).slice(0, 10)); return d; }
  function daysBetween(a, b) { return Math.round((day(b) - day(a)) / 86400000); }
  function addDays(iso, n) { return new Date(day(iso).getTime() + n * 86400000).toISOString().slice(0, 10); }
  function fmt(iso, opt) {
    return day(iso).toLocaleDateString("en-IN", Object.assign({ timeZone: "UTC" }, opt || { day: "numeric", month: "short" }));
  }
  function until(n) {
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n < 0) return "Happening now";
    if (n < 14) return "in " + n + " days";
    if (n < 60) return "in " + Math.round(n / 7) + " weeks";
    return "in " + Math.round(n / 30) + " months";
  }
  function setHead(kicker, title, meta, cover) {
    TB.kickerEl.textContent = kicker;
    TB.datelineEl.textContent = title;
    TB.metaEl.textContent = meta || "";
    TB.coverEl.innerHTML = cover || "";
  }
  function cap(t) { t = String(t || ""); return t.charAt(0).toUpperCase() + t.slice(1); }
  function failed(what, err) {
    TB.showStatus("Could not load " + what + " (" + err.message + "). It is created by the morning build; try again after the next run.", true);
  }

  // ======================================================================
  // Upcoming: a calendar of scheduled events plus dates found in the news
  // ======================================================================
  var GROUPS = [
    { id: "all", label: "Everything" },
    { id: "rates", label: "RBI and the Fed" },
    { id: "data", label: "Data releases" },
    { id: "policy", label: "Policy and Parliament" },
    { id: "elections", label: "Elections" },
    { id: "global", label: "Global" },
    { id: "climate", label: "Climate" },
    { id: "news", label: "In the news" }
  ];
  var STATUS = {
    confirmed: "Confirmed", scheduled: "Scheduled", expected: "Expected", tentative: "Date not announced"
  };
  var upState = { group: "all" };

  function eventEnd(e) { return e.end || e.start; }

  function icsFor(events) {
    function d(iso) { return iso.replace(/-/g, ""); }
    function clean(t) { return String(t || "").replace(/[\\;,]/g, function (c) { return "\\" + c; }).replace(/\n/g, "\\n"); }
    var stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//The Brief//Upcoming//EN", "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:The Brief: upcoming events"];
    events.forEach(function (e) {
      lines.push("BEGIN:VEVENT", "UID:" + e.id + "@the-brief", "DTSTAMP:" + stamp,
        "DTSTART;VALUE=DATE:" + d(e.start), "DTEND;VALUE=DATE:" + d(addDays(eventEnd(e), 1)),
        "SUMMARY:" + clean(e.title),
        "DESCRIPTION:" + clean((e.why || "") + (e.note ? " " + e.note : "") + (e.source ? " Source: " + e.source : "")),
        "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }
  function downloadICS(events) {
    var exact = events.filter(function (e) { return e.precision !== "month"; });
    var blob = new Blob([icsFor(exact)], { type: "text/calendar" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "the-brief-upcoming.ics";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return exact.length;
  }

  function eventRow(e, today) {
    var n = daysBetween(today, e.start);
    var running = n < 0 && daysBetween(today, eventEnd(e)) >= 0;
    var month = e.precision === "month";
    var dateBlock = month
      ? '<div class="ev-date is-month"><span class="ev-mon">' + TB.esc(fmt(e.start, { month: "short" })) + "</span><span class=\"ev-tba\">TBA</span></div>"
      : '<div class="ev-date"><span class="ev-day">' + day(e.start).getUTCDate() + "</span>" +
          '<span class="ev-mon">' + TB.esc(fmt(e.start, { weekday: "short" })) + "</span></div>";
    var range = e.end && !month ? fmt(e.start) + " to " + fmt(e.end) : "";
    var src = e.source ? '<a href="' + TB.esc(e.source) + '" target="_blank" rel="noopener noreferrer">' + TB.esc(e.source_name || "Source") + "</a>" : "";
    return (
      '<li class="ev' + (e.importance === "high" ? " is-key" : "") + '" data-cat="' + TB.esc(e.category) + '">' +
        dateBlock +
        '<div class="ev-body">' +
          '<div class="ev-top"><h3>' + TB.esc(e.title) + "</h3>" +
            '<span class="ev-when">' + (month ? "Date to be announced" : running ? "Happening now" : until(n)) + "</span></div>" +
          (range ? '<div class="ev-range">' + TB.esc(range) + "</div>" : "") +
          (e.why ? '<p class="ev-why">' + TB.esc(e.why) + "</p>" : "") +
          '<div class="ev-meta">' +
            '<span class="ev-status is-' + TB.esc(e.status) + '">' + TB.esc(STATUS[e.status] || e.status) + "</span>" +
            (e.note ? '<span class="ev-note">' + TB.esc(e.note) + "</span>" : "") +
            (src ? '<span class="ev-src">' + src + "</span>" : "") +
          "</div>" +
        "</div>" +
      "</li>"
    );
  }

  function newsRow(e, today) {
    var u = TB.safeUrl(e.url);
    return (
      '<li class="ev is-news" data-cat="news">' +
        '<div class="ev-date"><span class="ev-day">' + day(e.date).getUTCDate() + "</span>" +
          '<span class="ev-mon">' + TB.esc(fmt(e.date, { month: "short" })) + "</span></div>" +
        '<div class="ev-body">' +
          '<div class="ev-top"><h3>' + TB.esc(cap(e.event)) + "</h3>" +
            '<span class="ev-when">' + until(daysBetween(today, e.date)) + "</span></div>" +
          '<p class="ev-why">Mentioned in ' + (u ? '<a href="' + TB.esc(u) + '" target="_blank" rel="noopener noreferrer">' + TB.esc(e.story) + "</a>" : TB.esc(e.story)) +
            " (" + TB.esc(e.source) + ", " + TB.esc(fmt(e.reported)) + ")</p>" +
        "</div>" +
      "</li>"
    );
  }

  function renderUpcoming(cal, news) {
    var today = TB.todayIST();
    var events = (cal.events || []).filter(function (e) { return eventEnd(e) >= today; });
    var newsEvents = (news.events || []).filter(function (e) { return e.date >= today; });
    var next = events.filter(function (e) { return e.importance === "high" && e.precision !== "month" && e.start >= today; })[0] || events[0];

    if (next) {
      var n = daysBetween(today, next.start);
      var later = events.filter(function (e) { return e !== next && e.importance === "high" && e.precision !== "month"; }).slice(0, 3);
      setHead("Upcoming", n <= 0 ? "Today" : n === 1 ? "Tomorrow" : n + " days",
        "until the " + next.title + ", " + fmt(next.start, { weekday: "long", day: "numeric", month: "long" }),
        '<section class="hero up-hero">' +
          '<div class="kicker">Next big moment</div>' +
          "<h2>" + TB.esc(next.title) + "</h2>" +
          '<p class="why">' + TB.esc(next.why || "") + "</p>" +
          (later.length
            ? '<div class="up-next">' + later.map(function (e) {
                return '<div class="up-mini"><span class="up-mini-when">' + TB.esc(fmt(e.start, { day: "numeric", month: "short" })) +
                  " &middot; " + until(daysBetween(today, e.start)) + "</span><span>" + TB.esc(e.title) + "</span></div>";
              }).join("") + "</div>"
            : "") +
        "</section>");
    } else {
      setHead("Upcoming", "Nothing scheduled", "", "");
    }

    var counts = { all: events.length, news: newsEvents.length };
    events.forEach(function (e) { counts[e.category] = (counts[e.category] || 0) + 1; });

    var html =
      '<div class="up-tools">' +
        '<div class="seg" role="group" aria-label="Filter events">' + GROUPS.map(function (g) {
          if (g.id !== "all" && !counts[g.id] && g.id !== "news") return "";
          return '<button type="button" class="seg-btn' + (upState.group === g.id ? " is-on" : "") + '" data-group="' + g.id + '"' +
            (g.id !== "all" ? ' data-cat="' + g.id + '"' : "") + ">" + TB.esc(g.label) +
            ' <span>' + (counts[g.id] || 0) + "</span></button>";
        }).join("") + "</div>" +
        '<button type="button" class="text-btn" id="ics-btn">' + calIcon() + "<span>Add to my calendar</span></button>" +
      "</div>" +
      '<p class="up-hint dim" id="ics-msg">Adds every dated event in the current filter to your phone or laptop calendar as one file.</p>';

    var list = upState.group === "all" ? events
      : upState.group === "news" ? [] : events.filter(function (e) { return e.category === upState.group; });

    if (upState.group !== "news") {
      var byMonth = {};
      list.forEach(function (e) {
        var k = e.start.slice(0, 7);
        (byMonth[k] = byMonth[k] || []).push(e);
      });
      html += Object.keys(byMonth).sort().map(function (k) {
        return '<section class="up-month"><h2>' + TB.esc(fmt(k + "-01", { month: "long", year: "numeric" })) + "</h2>" +
          '<ol class="ev-list">' + byMonth[k].map(function (e) { return eventRow(e, today); }).join("") + "</ol></section>";
      }).join("") || '<p class="plain">No upcoming events in this group.</p>';
    }

    if (upState.group === "all" || upState.group === "news") {
      html += '<section class="up-month up-news"><h2>Dates spotted in the news</h2>' +
        '<p class="dim">Future dates that a story states outright, checked against the article text each morning. ' +
        "Follow the link before relying on one.</p>" +
        (newsEvents.length
          ? '<ol class="ev-list">' + newsEvents.map(function (e) { return newsRow(e, today); }).join("") + "</ol>"
          : '<p class="plain">None yet. They start appearing from the next morning\'s brief.</p>') +
        "</section>";
    }
    html += '<p class="dim up-foot">Calendar last checked ' + TB.esc(fmt(cal.updated || today, { day: "numeric", month: "long", year: "numeric" })) +
      ". Dates can move; each event links to its source.</p>";

    TB.app.innerHTML = html;
    document.title = "The Brief · Upcoming";
    TB.app.querySelectorAll("[data-group]").forEach(function (b) {
      b.addEventListener("click", function () { upState.group = b.dataset.group; renderUpcoming(cal, news); });
    });
    var ics = document.getElementById("ics-btn");
    ics.addEventListener("click", function () {
      var n = downloadICS(list);
      document.getElementById("ics-msg").textContent = n
        ? "Downloaded " + n + " event" + (n === 1 ? "" : "s") + ". Open the file to add them to your calendar. Events without a confirmed date are left out."
        : "Nothing with a confirmed date in this filter.";
    });
  }
  function calIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5"/></svg>';
  }

  TB.views.upcoming = function () {
    TB.showStatus("Loading the calendar…");
    return Promise.all([load("data/calendar.json"), load("data/news-events.json").catch(function () { return { events: [] }; })])
      .then(function (r) { renderUpcoming(r[0], r[1]); })
      .catch(function (e) { failed("the calendar", e); });
  };

  // "Coming up" card in Today's right-hand rail.
  TB.fillNextUp = function (el) {
    if (!el) return;
    load("data/calendar.json").then(function (cal) {
      var today = TB.todayIST();
      var list = (cal.events || []).filter(function (e) { return e.start >= today && e.precision !== "month"; })
        .sort(function (a, b) { return (a.start < b.start ? -1 : 1); }).slice(0, 4);
      if (!list.length) return;
      el.innerHTML =
        '<section class="next-card">' +
          '<div class="watch-head"><div class="kicker">Coming up</div><a class="link-btn" href="#upcoming">Full calendar</a></div>' +
          "<ul>" + list.map(function (e) {
            return '<li data-cat="' + TB.esc(e.category) + '"><span class="nc-when">' + TB.esc(until(daysBetween(today, e.start))) + "</span>" +
              '<span class="nc-title">' + TB.esc(e.title) + "</span></li>";
          }).join("") + "</ul>" +
        "</section>";
    }).catch(function () {});
  };

  // ======================================================================
  // Library: every term and concept the brief has explained
  // ======================================================================
  var libState = { mode: "terms", q: "" };

  function renderLibrary(lib) {
    var terms = lib.terms || [], concepts = lib.concepts || [];
    var first = [].concat(terms.map(function (t) { return t.date; }), concepts.map(function (c) { return c.date; })).sort()[0];
    setHead("Library", (terms.length + concepts.length) + " ideas",
      terms.length + " terms and " + concepts.length + " concepts explained in the brief" + (first ? " since " + fmt(first, { day: "numeric", month: "long" }) : ""),
      '<section class="hero lib-hero">' +
        '<label class="sr-only" for="lib-search">Search the library</label>' +
        '<input id="lib-search" class="lib-search" type="search" placeholder="Search a term or concept, e.g. repo rate" autocomplete="off" value="' + TB.esc(libState.q) + '">' +
        '<div class="lib-modes" role="group" aria-label="Show">' +
          '<button type="button" class="lib-mode' + (libState.mode === "terms" ? " is-on" : "") + '" data-mode="terms">Terms <span>' + terms.length + "</span></button>" +
          '<button type="button" class="lib-mode' + (libState.mode === "concepts" ? " is-on" : "") + '" data-mode="concepts">Concepts <span>' + concepts.length + "</span></button>" +
          '<button type="button" class="lib-mode" data-random="1">Surprise me</button>' +
        "</div>" +
      "</section>");
    var search = document.getElementById("lib-search");
    search.addEventListener("input", function () { libState.q = search.value; drawLibrary(lib); });
    TB.coverEl.querySelectorAll("[data-mode]").forEach(function (b) {
      b.addEventListener("click", function () { libState.mode = b.dataset.mode; renderLibrary(lib); });
    });
    TB.coverEl.querySelector("[data-random]").addEventListener("click", function () {
      var pool = libState.mode === "terms" ? terms : concepts;
      if (!pool.length) return;
      var pick = pool[Math.floor(Math.random() * pool.length)];
      libState.q = libState.mode === "terms" ? pick.term : pick.name;
      search.value = libState.q;
      drawLibrary(lib);
    });
    drawLibrary(lib);
    document.title = "The Brief · Library";
  }

  function drawLibrary(lib) {
    var q = libState.q.trim().toLowerCase();
    var html = "";
    if (libState.mode === "terms") {
      var list = (lib.terms || []).filter(function (t) {
        return !q || (t.term + " " + t.meaning).toLowerCase().indexOf(q) !== -1;
      });
      var groups = {};
      list.forEach(function (t) {
        var L = (t.term.charAt(0) || "#").toUpperCase();
        if (!/[A-Z]/.test(L)) L = "#";
        (groups[L] = groups[L] || []).push(t);
      });
      var letters = Object.keys(groups).sort();
      html += letters.length > 4 && !q
        ? '<nav class="az" aria-label="Jump to letter">' + letters.map(function (L) {
            return '<a href="#lib-' + L + '" data-az="' + L + '">' + L + "</a>";
          }).join("") + "</nav>"
        : "";
      html += letters.map(function (L) {
        return '<section class="lib-group" id="lib-' + L + '"><h2>' + L + "</h2><dl>" + groups[L].map(function (t) {
          var u = TB.safeUrl(t.url);
          return '<div class="lib-term" data-cat="' + TB.esc(t.category || "") + '"><dt>' + TB.esc(cap(t.term)) + "</dt>" +
            "<dd><p>" + TB.esc(t.meaning) + "</p>" +
            '<p class="lib-from">From ' + (u ? '<a href="' + TB.esc(u) + '" target="_blank" rel="noopener noreferrer">' + TB.esc(t.story) + "</a>" : TB.esc(t.story)) +
            " &middot; " + TB.esc(t.category_title || "") + ", " + TB.esc(fmt(t.date)) + "</p></dd></div>";
        }).join("") + "</dl></section>";
      }).join("") || '<p class="plain">No terms match "' + TB.esc(libState.q) + '".</p>';
    } else {
      var cs = (lib.concepts || []).filter(function (c) {
        return !q || (c.name + " " + c.explanation).toLowerCase().indexOf(q) !== -1;
      });
      html += '<div class="lib-concepts">' + cs.map(function (c) {
        return '<article class="lib-concept"><div class="wk-date">' + TB.esc(fmt(c.date, { day: "numeric", month: "long" })) + "</div>" +
          "<h3>" + TB.esc(c.name) + "</h3><p>" + TB.esc(c.explanation) + "</p>" +
          (c.indian_example || c.use_in_gd
            ? '<details class="concept-more"><summary>Indian example and how to use it</summary>' +
                (c.indian_example ? '<div class="sub">Indian example</div><p>' + TB.esc(c.indian_example) + "</p>" : "") +
                (c.use_in_gd ? '<div class="sub">How to use it in a GD</div><p>' + TB.esc(c.use_in_gd) + "</p>" : "") +
              "</details>"
            : "") +
          "</article>";
      }).join("") + "</div>" + (cs.length ? "" : '<p class="plain">No concepts match "' + TB.esc(libState.q) + '".</p>');
    }
    TB.app.innerHTML = html;
    TB.app.querySelectorAll("[data-az]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();       // keep #library in the address bar
        var t = document.getElementById("lib-" + a.dataset.az);
        if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  TB.views.library = function () {
    TB.showStatus("Opening the library…");
    return load("data/library.json").then(renderLibrary).catch(function (e) { failed("the library", e); });
  };

  // ======================================================================
  // Review: spaced repetition. Cards come back 1, 3, 7, 14 and 30 days after
  // they appeared; "Again" brings a card back tomorrow, "Got it" pushes it out.
  // Progress lives in this browser only.
  // ======================================================================
  var REVIEW_KEY = "gd-review-v1";
  var STEPS = [1, 3, 7, 14, 30, 60];
  var SESSION_MAX = 12;
  var keepGoing = false;     // set when the reader asks for more after finishing

  function rstate() {
    var s = TB.readStore(REVIEW_KEY, null) || {};
    s.cards = s.cards || {};
    s.streak = s.streak || { last: "", count: 0 };
    s.reviewed = s.reviewed || 0;
    return s;
  }
  function buildSession(deck, st, today) {
    var due = [], scheduled = [], fresh = [];
    deck.forEach(function (c) {
      var k = st.cards[c.id];
      var age = daysBetween(c.date, today);
      if (k) { if (k.due <= today) due.push(c); }
      else if (STEPS.indexOf(age) !== -1) scheduled.push(c);
      else if (age <= 1) fresh.push(c);
    });
    due.sort(function (a, b) { return st.cards[a.id].due < st.cards[b.id].due ? -1 : 1; });
    var mix = function (arr) {     // alternate kinds so a session is not all facts
      var by = { fact: [], term: [], concept: [] };
      arr.forEach(function (c) { (by[c.kind] || by.fact).push(c); });
      var out = [];
      while (by.fact.length || by.term.length || by.concept.length) {
        ["fact", "term", "fact", "concept"].forEach(function (k) { if (by[k].length) out.push(by[k].shift()); });
      }
      return out;
    };
    var list = due.concat(mix(scheduled));
    if (list.length < 5) list = list.concat(mix(fresh));
    return list.slice(0, SESSION_MAX);
  }

  function renderReview(data) {
    var today = TB.todayIST();
    var st = rstate();
    var deck = data.cards || [];
    var session = buildSession(deck, st, today);
    var learned = Object.keys(st.cards).filter(function (k) { return (st.cards[k].box || 0) >= 2; }).length;
    var streakAlive = st.streak.last === today || st.streak.last === addDays(today, -1);
    var streak = streakAlive ? st.streak.count : 0;
    var doneToday = st.doneOn === today;
    var resting = doneToday && !keepGoing;

    setHead("Review",
      resting ? "Done for today" : session.length ? session.length + " card" + (session.length === 1 ? "" : "s") : "All caught up",
      (doneToday ? "Done for today. " : "") + "Five minutes a day, so what you read stays with you.",
      '<section class="hero rv-hero">' +
        '<div class="rv-stats">' +
          '<div class="rv-stat"><span class="rv-num">' + streak + '</span><span class="rv-lab">day streak</span></div>' +
          '<div class="rv-stat"><span class="rv-num">' + (resting ? 0 : session.length) + '</span><span class="rv-lab">due today</span></div>' +
          '<div class="rv-stat"><span class="rv-num">' + learned + '</span><span class="rv-lab">cards learned</span></div>' +
          '<div class="rv-stat"><span class="rv-num">' + deck.length + '</span><span class="rv-lab">in your deck</span></div>' +
        "</div>" +
        '<p class="why">Facts, terms and concepts from past briefs come back 1, 3, 7, 14 and 30 days after you first saw them. ' +
          "Say the answer out loud, then check it.</p>" +
      "</section>");
    document.title = "The Brief · Review";

    if (resting) {
      TB.app.innerHTML = '<section class="rv-empty rv-done"><h2>You\'re done for today</h2>' +
        "<p>Today's session is complete. Stopping here is the point: spacing reviews out is what makes them stick.</p>" +
        '<div class="rv-end-actions">' +
          (session.length ? '<button type="button" class="text-btn" data-more="1">Keep going (' + session.length + " more due)</button>" : "") +
          '<a class="text-btn" href="#library">Browse the library</a></div></section>';
      var more = TB.app.querySelector("[data-more]");
      if (more) more.addEventListener("click", function () { keepGoing = true; renderReview(data); });
      return;
    }
    if (!session.length) {
      TB.app.innerHTML = '<section class="rv-empty"><h2>Nothing due right now</h2>' +
        "<p>New cards arrive with each morning's brief. Come back tomorrow to keep the streak going.</p>" +
        '<a class="text-btn" href="#library">Browse the library instead</a></section>';
      return;
    }

    var i = 0, got = 0;
    function show() {
      if (i >= session.length) return finish();
      var c = session[i];
      var label = c.kind === "fact" ? "Quote this" : c.kind === "term" ? "Term to know" : "Concept";
      var prompt = c.kind === "fact" ? "What is the key fact or number?" : c.kind === "term" ? "What does it mean?" : "Explain it in one or two sentences.";
      TB.app.innerHTML =
        '<section class="rv">' +
          '<div class="rv-progress" aria-hidden="true">' + session.map(function (_, k) {
            return '<span class="' + (k < i ? "is-done" : k === i ? "is-now" : "") + '"></span>';
          }).join("") + "</div>" +
          '<p class="rv-count">Card ' + (i + 1) + " of " + session.length + "</p>" +
          '<article class="rv-card" data-cat="' + TB.esc(c.category || "") + '">' +
            '<div class="rv-label"><span class="rv-kind">' + label + "</span>" +
              (c.category_title ? "<span>" + TB.esc(c.category_title) + "</span>" : "") +
              "<span>" + TB.esc(fmt(c.date)) + " brief</span></div>" +
            '<h2 class="rv-front">' + TB.esc(cap(c.front)) + "</h2>" +
            '<p class="rv-prompt">' + prompt + "</p>" +
            '<div class="rv-back" hidden><p>' + TB.esc(c.back) + "</p>" +
              (c.url ? '<a class="read-link" href="' + TB.esc(TB.safeUrl(c.url)) + '" target="_blank" rel="noopener noreferrer">Read the story <span aria-hidden="true">&#8599;</span></a>' : "") +
            "</div>" +
            '<div class="rv-actions">' +
              '<button type="button" class="rv-btn is-primary" data-rv="show">Show answer <kbd>Space</kbd></button>' +
              '<button type="button" class="rv-btn" data-rv="again" hidden>Again <kbd>1</kbd></button>' +
              '<button type="button" class="rv-btn is-primary" data-rv="got" hidden>Got it <kbd>2</kbd></button>' +
            "</div>" +
          "</article>" +
        "</section>";
      TB.app.querySelector('[data-rv="show"]').addEventListener("click", flip);
      TB.app.querySelector('[data-rv="again"]').addEventListener("click", function () { answer(false); });
      TB.app.querySelector('[data-rv="got"]').addEventListener("click", function () { answer(true); });
    }
    function flip() {
      var back = TB.app.querySelector(".rv-back");
      if (!back || !back.hidden) return;
      back.hidden = false;
      TB.app.querySelector('[data-rv="show"]').hidden = true;
      TB.app.querySelector('[data-rv="again"]').hidden = false;
      TB.app.querySelector('[data-rv="got"]').hidden = false;
      TB.app.querySelector('[data-rv="got"]').focus();
    }
    function answer(ok) {
      var c = session[i];
      var s = rstate();
      var k = s.cards[c.id] || { box: 0 };
      if (ok) {
        // first success jumps to the next step after the card's age
        var age = daysBetween(c.date, today);
        var step = k.box ? STEPS[Math.min(k.box, STEPS.length - 1)] :
          (STEPS.filter(function (x) { return x > age; })[0] || 30) - age;
        k.box = (k.box || 0) + 1;
        k.due = addDays(today, Math.max(1, step));
        got++;
      } else {
        k.box = 0;
        k.due = addDays(today, 1);
      }
      s.cards[c.id] = k;
      s.reviewed++;
      if (s.streak.last !== today) {
        s.streak.count = s.streak.last === addDays(today, -1) ? s.streak.count + 1 : 1;
        s.streak.last = today;
      }
      TB.writeStore(REVIEW_KEY, s);
      i++;
      show();
    }
    function finish() {
      document.removeEventListener("keydown", onKey);
      var s = rstate();
      s.doneOn = today;
      TB.writeStore(REVIEW_KEY, s);
      keepGoing = false;
      TB.app.innerHTML = '<section class="rv-empty rv-done">' +
        '<div class="rv-big">' + got + "/" + session.length + "</div>" +
        "<h2>" + (got === session.length ? "Perfect recall." : got >= session.length * 0.7 ? "Solid session." : "Good work. The misses come back tomorrow.") + "</h2>" +
        "<p>" + s.streak.count + "-day streak. Your next cards arrive tomorrow.</p>" +
        '<div class="rv-end-actions"><a class="text-btn" href="#today">Back to today\'s brief</a>' +
        '<a class="text-btn" href="#library">Open the library</a></div></section>';
      TB.datelineEl.textContent = "Done for today";
      TB.metaEl.textContent = s.streak.count + "-day streak. See you tomorrow.";
    }
    function onKey(e) {
      if (location.hash !== "#review") { document.removeEventListener("keydown", onKey); return; }
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      var back = TB.app.querySelector(".rv-back");
      if (!back) return;
      if ((e.key === " " || e.key === "Enter") && back.hidden) { e.preventDefault(); flip(); }
      else if (!back.hidden && e.key === "1") answer(false);
      else if (!back.hidden && e.key === "2") answer(true);
    }
    document.addEventListener("keydown", onKey);
    show();
  }

  TB.views.review = function () {
    TB.showStatus("Shuffling your cards…");
    return load("data/review.json").then(renderReview).catch(function (e) { failed("the review deck", e); });
  };

  // ======================================================================
  // Watchlist editor and 14-day tracking, shown at the top of "This week"
  // ======================================================================
  TB.fillWatchWeek = function (el) {
    if (!el) return;
    load("data/stories.json").then(function (data) {
      drawWatch(el, data.stories || []);
    }).catch(function () { drawWatch(el, []); });
  };

  function drawWatch(el, stories) {
    var W = TB.watch, st = W.state(), active = W.active();
    var today = TB.todayIST(), from = addDays(today, -14);
    var recent = stories.filter(function (s) { return s.date >= from; });
    var tracks = active.map(function (t) {
      var hits = recent.filter(function (s) { return t.rx.test(s.title + " " + s.summary); });
      var days = {};
      hits.forEach(function (h) { days[h.date] = 1; });
      return { t: t, hits: hits, days: Object.keys(days).length };
    }).sort(function (a, b) { return b.hits.length - a.hits.length; });

    // a 14-day strip per topic: one cell per day, filled when the topic appeared
    function strip(hits) {
      var counts = {};
      hits.forEach(function (h) { counts[h.date] = (counts[h.date] || 0) + 1; });
      var cells = "";
      for (var k = 13; k >= 0; k--) {
        var d = addDays(today, -k), n = counts[d] || 0;
        cells += '<span class="wl-cell l' + Math.min(n, 3) + '" title="' + TB.esc(fmt(d)) + ": " + n + ' stor' + (n === 1 ? "y" : "ies") + '"></span>';
      }
      return '<div class="wl-strip" aria-hidden="true">' + cells + "</div>";
    }

    el.innerHTML =
      '<section class="wk-block wl" aria-labelledby="wl-h">' +
        '<h2 id="wl-h">Your watchlist</h2>' +
        '<p class="wk-sub">Topics you follow are tracked across the last 14 days and marked in each morning\'s brief. Tap a topic to follow or unfollow it.</p>' +
        '<div class="wl-chips">' + W.topics.map(function (t) {
          var on = st.topics.indexOf(t.id) !== -1;
          return '<button type="button" class="wl-chip' + (on ? " is-on" : "") + '" data-topic="' + t.id + '" aria-pressed="' + on + '">' + TB.esc(t.label) + "</button>";
        }).join("") +
        st.custom.map(function (w) {
          return '<button type="button" class="wl-chip is-on is-custom" data-custom="' + TB.esc(w) + '" title="Remove">' + TB.esc(w) + ' <span aria-hidden="true">&times;</span></button>';
        }).join("") + "</div>" +
        '<form class="wl-add" autocomplete="off"><label class="sr-only" for="wl-input">Follow a keyword</label>' +
          '<input id="wl-input" type="text" maxlength="30" placeholder="Follow a keyword, e.g. Adani or semiconductors">' +
          '<button class="text-btn" type="submit">Follow</button></form>' +
        (tracks.length
          ? '<div class="wl-tracks">' + tracks.map(function (r) {
              return "<details class=\"wl-track\">" +
                '<summary><span class="wl-name">' + TB.esc(r.t.label) + "</span>" + strip(r.hits) +
                  '<span class="wl-count">' + r.hits.length + " stor" + (r.hits.length === 1 ? "y" : "ies") + "</span></summary>" +
                (r.hits.length
                  ? "<ul>" + r.hits.slice(0, 6).map(function (h) {
                      var u = TB.safeUrl(h.url);
                      return "<li>" + (u ? '<a href="' + TB.esc(u) + '" target="_blank" rel="noopener noreferrer">' + TB.esc(h.title) + "</a>" : TB.esc(h.title)) +
                        '<span class="dim">' + TB.esc(h.source) + ", " + TB.esc(fmt(h.date)) + "</span></li>";
                    }).join("") + "</ul>"
                  : '<p class="dim">No stories in the last 14 days.</p>') +
              "</details>";
            }).join("") + "</div>"
          : '<p class="plain">Follow a topic above to start tracking it.</p>') +
      "</section>";

    el.querySelectorAll("[data-topic]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = W.state(), id = b.dataset.topic, at = s.topics.indexOf(id);
        if (at === -1) s.topics.push(id); else s.topics.splice(at, 1);
        W.save(s);
        drawWatch(el, stories);
      });
    });
    el.querySelectorAll("[data-custom]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = W.state();
        s.custom = s.custom.filter(function (w) { return w !== b.dataset.custom; });
        W.save(s);
        drawWatch(el, stories);
      });
    });
    el.querySelector(".wl-add").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = document.getElementById("wl-input").value.trim().replace(/\s+/g, " ");
      if (!v) return;
      var s = W.state();
      if (s.custom.map(function (w) { return w.toLowerCase(); }).indexOf(v.toLowerCase()) === -1) s.custom.push(v);
      s.custom = s.custom.slice(-6);
      W.save(s);
      drawWatch(el, stories);
    });
  }
})();
