# Daily GD Brief — v2 upgrade

Everything in this upgrade is drop-in. No new dependencies, no change to
`requirements.txt`, and the JSON the site reads stays backwards compatible
(new fields are added, none removed).

## Files

| File | Action | What it does |
|---|---|---|
| `scripts/build_brief.py` | **replace** | Rewritten pipeline: 25-story cap, new category, better dedupe, AI time budget, publish-before-AI |
| `scripts/test_build_brief.py` | **new** | 18 unit tests; the workflow runs them before every build |
| `.github/workflows/daily-brief.yml` | **replace** | New cron time, 30-min timeout, test step, commits even if the build is cancelled |
| `app.js` | **replace** | Stale-brief warning, jump chips, save/read/share, archive search, link-scheme check |
| `index.html` | **replace** | Manifest, icons, service-worker registration |
| `style.css` | **replace** | Original stylesheet plus a v2 section at the end (notices, chips, actions, saved view, search, print) |
| `sw.js` | **new** | Offline reading |
| `manifest.webmanifest` | **new** | "Add to Home Screen" |
| `icon.svg`, `icon-maskable.svg` | **new** | App icons |

Nothing under `data/` changes. Old archived briefs still render; they simply
won't have the new fields.

## What changed, and why

### The 25-story budget
`STORIES_PER_CATEGORY = 4` is gone. The brief now works to a daily budget:

```
MAX_STORIES_PER_DAY = 25   # hard cap on the whole brief
MIN_PER_CATEGORY    = 3    # every category is guaranteed this many
MAX_PER_CATEGORY    = 6    # ... and never gets more
MIN_EXTRA_SCORE     = 4.0  # a story must earn a bonus slot
MAX_PER_SOURCE_GLOBAL = 5  # no publisher can fill the brief
```

Six categories × 3 = 18 guaranteed, and the remaining 7 slots go to the
strongest stories wherever they came from. A heavy economy day gets 5–6
economy stories; a quiet science day stays at 3. The cap is enforced twice,
so the brief can never exceed 25 even if every category is full.

### A sixth category: India — Governance & Society
The Hindu (national), Indian Express (India), The Print, Scroll.in, Mint
Politics and BBC India. This is where most real GD topics live: education
policy, courts, Parliament, welfare, urban issues, labour. Related fix: the
junk filter no longer throws away `/education/`, `/jobs/` and `/cities/` URLs.

### Story selection
- **Dedupe** now also compares against the *shorter* headline. This catches
  the India–New Zealand FTA duplicate in your 22 Sep brief, and the tests
  check it does not merge unrelated headlines.
- **No repeats across days.** The last 3 briefs are loaded and their headlines
  skipped, unless the new headline signals a real development ("passes",
  "verdict", "resigns", "cuts"…). A near-identical headline is always skipped.
- **Keyword relevance** matches phrases as phrases, so "sri lanka", "net zero"
  and "repo rate" work, and the pronoun "us" no longer scores as the USA.
  India mentions get a small bonus in the globally focused categories.
- **AI curation (new, 1 call).** The shortlist goes to Gemini with one
  question: how useful is each headline for a GD or an interview, 1 to 10?
  Final score = 40% heuristics + 60% model. It also flags duplicates the text
  matching missed. If the call fails, the heuristic ranking is used as before.
- Entries with no publish date are now dropped instead of bypassing the
  36-hour freshness cutoff.

### Why the 23 Sep run was cancelled, and the fix
The job hit `timeout-minutes: 20` inside the Gemini retry loops. Three changes
make that impossible:

1. **A hard AI deadline.** `AI_DEADLINE` (default 480s) bounds the entire
   Gemini phase. When it runs out, the script publishes what it has.
2. **A rate-limit circuit breaker.** After 3 HTTP 429s it stops calling the API
   instead of walking through every model with 30/60/90-second backoffs.
   Backoff is now 15/30s, request timeout 60s (was 120s), retries 2 (was 3).
3. **Publish before AI.** A full headlines-only brief is written to
   `data/latest.json` *before* the first Gemini call, then rewritten with
   commentary. Combined with `if: always()` on the commit step, a killed run
   still publishes something.

### Content quality
- The **GD topic and concept are generated first**, so the most valuable call
  happens while quota remains. That is why your 22 Sep hero fell back.
- The **fallback topic prefers India-relevant policy/economy stories** and no
  longer quotes a headline verbatim in the opening line.
- **Article snippets.** Before enrichment, the `og:description` of each chosen
  article is fetched (6-second timeout, failures ignored), so summaries are
  based on more than a one-line RSS blurb.
- **Honest facts.** The prompt requires `key_fact` to come from the supplied
  text; a general statistic must start with `Context: `. The site renders
  those differently, labelled "Background (verify before quoting)".
- **Batched enrichment**: 9 stories per call instead of one call per category,
  plus one retry pass for stories that came back empty. Typical run: 1
  curation + 1 topic + 3 enrichment = 5 Gemini calls for 25 stories (v1 used 6
  calls for 20).
- `ai_errors` is written into the JSON, so failures show on the site instead of
  hiding in the Actions log.

### The site
- **Stale-brief warning** when today's build hasn't published.
- **Jump chips** with per-category counts — faster than scrolling 25 stories.
- **Save / Mark read / Share** on every story. Saved stories persist across
  days in `localStorage` and have their own view; read stories dim.
- **Archive search** over past GD topics and concepts.
- **Offline + installable**: service worker caches the shell and today's brief;
  "Add to Home Screen" gives an app icon.
- **"3 sources" pill** when several publishers covered the same story.
- **Print stylesheet** for a clean revision one-pager.
- **Security**: only `http(s)` links are rendered.

## Installing

1. Copy the files in, keeping the same paths.
2. Commit and push to `main`.
3. Actions → "Build Daily GD Brief" → **Run workflow** to test immediately.
4. Check **Settings → Actions → General → Workflow permissions** is set to
   "Read and write permissions", otherwise the commit step cannot push.

Expected log for a healthy run:

```
Budget: max 25 stories, AI phase capped at 480s
1) Fetching feeds
2) Ranking and deduplicating
3) Curating the shortlist with Gemini
   Curation done: 48 stories scored, 3 duplicates dropped
   Final selection: 25 stories geopolitics=5, economy=5, ...
4) Resolving Google News links and fetching article snippets
5) Writing a first version (so a timeout still publishes something)
6) Writing the GD topic and concept of the day
7) Writing story commentary
8) Writing final files
Done in 210s — 25 stories (cap 25), 25 with AI commentary, 5 Gemini call(s)
```

## Knobs you may want to turn

All at the top of `scripts/build_brief.py`:

| Setting | Default | Try this |
|---|---|---|
| `MAX_STORIES_PER_DAY` | 25 | 15 for a shorter daily read |
| `MIN_PER_CATEGORY` / `MAX_PER_CATEGORY` | 3 / 6 | 2 / 8 to let big days breathe |
| `CROSS_DAY_LOOKBACK` | 3 | 1 if the brief feels too thin |
| `MAX_STORY_AGE_HOURS` | 36 | 48 if you build later in the day |
| `AI_DEADLINE` (env, in the workflow) | 480 | 300 on a tight quota |
| `ENRICH_BATCH_SIZE` | 9 | 6 if summaries get shallow |

Running locally:

```bash
pip install -r requirements.txt
python scripts/test_build_brief.py          # tests
SKIP_AI=1 python scripts/build_brief.py     # fast, no API key needed
SKIP_SNIPPETS=1 python scripts/build_brief.py
```

## Two small README edits

Your README still says 06:30 IST and 4 stories per category. Update those to
05:47 IST (the new cron) and "at most 25 stories a day, at least 3 per
category" so the docs match the code.

## If quota is still the problem

If the log shows the rate-limit breaker tripping every day, set a repository
variable `GEMINI_MODEL` to a stable model with a larger free-tier allowance
rather than letting auto-discovery pick the newest one. Check the limits for
your key in Google AI Studio. Failing that, drop `MAX_STORIES_PER_DAY` to 15,
which is 2 enrichment calls instead of 3.
