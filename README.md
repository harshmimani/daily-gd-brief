# Daily GD Brief

A free, self-updating website that gives you a curated news brief every morning at
about 6:30 AM IST, with "why it matters", GD angles (for / against), a quotable fact
per story, today's likely GD topic, and a concept of the day.

- Hosted for free on **GitHub Pages**
- Refreshed for free by **GitHub Actions** (a scheduled job)
- Written for free by the **Google Gemini API** (free tier). If Gemini is unavailable,
  the site still publishes headlines, links and summaries from the feeds, so it never breaks.

---

## 1. Folder structure

```
daily-gd-brief/
├── .github/
│   └── workflows/
│       └── daily-brief.yml     # the scheduled job (6:30 AM IST daily + manual button)
├── .nojekyll                   # tells GitHub Pages to serve files exactly as they are
├── index.html                  # the web page
├── style.css                   # design (mobile-first, light + dark mode)
├── app.js                      # loads the JSON and draws the page; date picker; theme toggle
├── requirements.txt            # Python packages the script needs
├── scripts/
│   └── build_brief.py          # fetches RSS, dedupes, ranks, calls Gemini, writes JSON
├── data/
│   ├── latest.json             # today's brief (written by the script)
│   └── archive/
│       ├── index.json          # list of all past days (feeds the date picker)
│       └── 2026-09-22.json     # one file per day
└── README.md                   # this file
```

The `data/` folder in this download contains a real brief generated during testing
(without an API key) so the site works the moment you upload it.

---

## 2. Setup, step by step (no command line needed)

You need: a free GitHub account and a free Google account. About 20 minutes.

### Step A. Get a free Gemini API key

1. Open **https://aistudio.google.com/apikey** and sign in with your Google account.
2. Click **Create API key**. If it asks for a project, choose **Create a new project**.
3. Copy the key (it starts with `AIza…`). Keep it private; treat it like a password.

### Step B. Create the repository on GitHub

1. Open **https://github.com/signup** and create an account (or sign in).
2. Click the **+** icon at the top right, then **New repository**.
3. Repository name: `daily-gd-brief` (any name works, but the site address uses it).
4. Keep it **Public** (GitHub Pages is free only for public repositories on free accounts).
5. Tick **Add a README file**. Click **Create repository**.

### Step C. Upload the files

Do this in two parts, because the GitHub uploader ignores hidden folders such as `.github`.

**Part 1: the normal files**

1. Unzip the download on your computer.
2. In your repository page, click **Add file** (top right) then **Upload files**.
3. From the unzipped folder, drag these into the upload box **all at once**:
   `index.html`, `style.css`, `app.js`, `requirements.txt`, and the two **folders**
   `scripts` and `data`. (Drag the folders themselves; GitHub keeps the folder structure.)
4. Scroll down and click **Commit changes**. Wait until the upload finishes.
5. Repeat **Add file → Upload files** for `README.md` (it will replace the auto-created one).

**Part 2: the two hidden files (typed by hand)**

1. Click **Add file → Create new file**.
2. In the file name box type exactly: `.github/workflows/daily-brief.yml`
   (as you type each `/`, GitHub turns it into a folder).
3. Open `daily-brief.yml` from the download in any text editor, copy everything, paste it
   into the big editor box on GitHub. Click **Commit changes**.
4. Again **Add file → Create new file**, name it `.nojekyll`, leave the contents empty,
   click **Commit changes**.

Check: your repository's front page should now show `.github`, `data`, `scripts`,
`.nojekyll`, `app.js`, `index.html`, `requirements.txt`, `style.css`, `README.md`.

### Step D. Add your API key as a secret

1. In the repository, click **Settings** (the tab on the right of the top row).
2. In the left menu: **Secrets and variables → Actions**.
3. Click **New repository secret**.
4. Name: `GEMINI_API_KEY` (exactly this, capital letters). Secret: paste your key.
5. Click **Add secret**.

### Step E. Allow the workflow to write to the repository

1. Still in **Settings**, left menu: **Actions → General**.
2. Scroll to **Workflow permissions**. Select **Read and write permissions**.
3. Click **Save**.

### Step F. Turn on GitHub Pages

1. **Settings → Pages** (left menu).
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)**. Click **Save**.
4. After a minute, refresh the page. A box at the top shows your site address, like
   `https://YOUR-USERNAME.github.io/daily-gd-brief/`. Bookmark it on your phone
   (in Chrome or Safari, use "Add to Home Screen" so it opens like an app).

### Step G. Run it for the first time

1. Click the **Actions** tab at the top of the repository.
2. If GitHub asks you to enable workflows, click **I understand my workflows, go ahead and enable them**.
3. In the left list click **Build Daily GD Brief**.
4. On the right click **Run workflow**, then the green **Run workflow** button.
5. A run appears in the list. Click it to watch. It takes about 2–3 minutes
   (Gemini calls are paced to stay inside the free limit).
6. When it shows a green tick, wait one more minute for Pages to publish, then open
   your site. You should see today's date and AI commentary.

From now on it runs automatically every day at 01:00 UTC (6:30 AM IST). GitHub's
scheduler is sometimes 5–20 minutes late at busy hours; if you want it earlier, change
the `cron` line in `daily-brief.yml` (for example `"30 0 * * *"` is 6:00 AM IST).

---

## 3. Everyday use

- Open the site each morning. The first category is expanded, the rest are collapsed.
  Use **Expand all** to read everything.
- The **date dropdown** in the top bar opens any previous day.
- The sun/moon button switches light and dark mode (remembered on your phone).
- The **Copy** buttons on the opening and closing lines copy them to your clipboard.
- **Sources checked** at the bottom shows which feeds worked that day.

---

## 4. Customising

Everything is at the top of `scripts/build_brief.py`:

| Setting | What it does |
|---|---|
| `STORIES_PER_CATEGORY` | stories per category (default 4) |
| `MAX_STORY_AGE_HOURS` | how old a story may be (default 36) |
| `CATEGORIES` | the feed list. Add a line like `{"name": "...", "url": "...", "weight": 2}` |
| `JUNK_PATTERNS` | words that get a headline dropped (sport, horoscope, promos…) |
| `RELEVANCE` | keywords that push a story up the ranking |
| `GEMINI_MODELS` | model order to try. Or set a repository **variable** `GEMINI_MODEL` |

Some Indian sites (The Hindu, Mint, Economic Times, Indian Express) block feed
downloads from cloud servers. The script notices this and automatically pulls the same
publisher's stories through Google News, then decodes the links back to the original
article, so you always land on the publisher's page. Reuters no longer offers public
RSS, so it is fetched through Google News as well.

To edit a file on GitHub: open it, click the pencil icon, change, **Commit changes**.
Then run the workflow again from the Actions tab to see the effect.

---

## 5. Troubleshooting

**The site shows "Could not load the brief".**
The `data/latest.json` file is missing. Check the `data` folder was uploaded, then run
the workflow once from the Actions tab and wait two minutes. Also make sure Pages is set
to branch `main`, folder `/ (root)`.

**The site is a blank GitHub 404 page.**
Pages is not enabled, or you enabled it before `index.html` existed. Go to
Settings → Pages, set branch `main` / root, save, wait two minutes. The address must end
with your repository name and a slash.

**The workflow fails at "Commit and push" with "Permission denied" or "403".**
Step E was skipped. Settings → Actions → General → Workflow permissions → **Read and
write** → Save. Run again.

**The page says "AI commentary off for this day (no API key)".**
The secret name is wrong or missing. It must be exactly `GEMINI_API_KEY` under
Settings → Secrets and variables → Actions (Secrets tab, not Variables).

**The page says "AI commentary unavailable (quota or error)".**
Gemini refused. Open the failed/finished run in Actions and read the "Build today's
brief" step. Common messages:
- `HTTP 429` / rate limit: the free daily quota is used up. It resets at midnight
  Pacific time (12:30 PM IST). Do not click "Run workflow" many times in a row.
- `HTTP 400` or `403` with "API key not valid": the key was copied incompletely, or the
  key was deleted in AI Studio. Create a new key and update the secret.
- `HTTP 404` on a model name: Google retired that model. Set a repository **variable**
  (not secret) named `GEMINI_MODEL` to a current model such as `gemini-2.5-flash`, or
  edit `GEMINI_MODELS` in the script.
The site keeps working in fallback mode meanwhile.

**Many sources show under "Could not fetch".**
Publishers change feed URLs. One or two failures are normal and harmless. If a
source fails for days, open the feed URL in your browser to check it still exists, then
update or delete that line in `CATEGORIES`.

**The workflow did not run at 6:30 AM.**
GitHub's scheduler can be delayed, and it pauses schedules on repositories with no
activity for 60 days (open the Actions tab and click **Enable workflow** if you see a
notice). The manual **Run workflow** button always works.

**I edited files but the site looks the same.**
Your phone cached the old page. Pull down to refresh, or add `?refresh=1` to the URL.
GitHub Pages itself can take 1–3 minutes to publish after a commit.

**The workflow fails at "Install dependencies".**
`requirements.txt` was not uploaded to the root of the repository (next to `index.html`).

**Two yellow "AI" badges or weird duplicate stories.**
Run the workflow again; a partial Gemini outage can leave a few stories without
commentary. Near-duplicates across categories are removed automatically, but different
publishers phrasing the same story very differently can occasionally slip through.

---

## 6. Running on your own computer (optional)

```
pip install -r requirements.txt
set GEMINI_API_KEY=your_key        (Windows)   /   export GEMINI_API_KEY=your_key (Mac/Linux)
python scripts/build_brief.py
```
Then open `index.html` through any local web server (for example
`python -m http.server` and visit http://localhost:8000). Opening the file directly
from the disk will not load the JSON because browsers block it.
