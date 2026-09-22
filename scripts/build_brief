#!/usr/bin/env python3
"""
Daily GD Brief — build script
=============================
Pulls news from free RSS feeds, removes duplicate stories, picks the most
important ones per category, asks Google Gemini (free tier) to write
summaries / "why it matters" / GD angles / a GD topic / a concept of the day,
and writes a JSON file that the static site (index.html + app.js) reads.

If Gemini is unavailable (no key, quota exhausted, network error), the script
still publishes headlines + links + RSS descriptions, so the site never breaks.

Run locally:  python scripts/build_brief.py
Environment:  GEMINI_API_KEY   (optional — without it, fallback mode is used)
              GEMINI_MODEL     (optional — force a model; otherwise auto-detected)
              SKIP_AI=1        (optional — force fallback mode for testing)
"""

from __future__ import annotations

import concurrent.futures as cf
import html
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from zoneinfo import ZoneInfo

import feedparser
import requests

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

IST = ZoneInfo("Asia/Kolkata")
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ARCHIVE_DIR = DATA_DIR / "archive"

MAX_STORY_AGE_HOURS = 36        # ignore anything older than this
STORIES_PER_CATEGORY = 4        # final stories shown per category
MAX_PER_SOURCE = 2              # source diversity inside a category
FETCH_TIMEOUT = 20              # seconds per feed
# Model choice: the script asks Google for the live list of models each run and
# picks the newest Flash model automatically (Google retires model names every
# few months). Set a GEMINI_MODEL repository variable to force a specific one.
# These names are only a last resort if the model list cannot be fetched.
GEMINI_FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.1-flash-lite"]
GEMINI_DELAY_SECONDS = 7        # free tier allows ~10 requests/minute
GEMINI_MAX_RETRIES = 3

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

# Headlines containing these words are usually not GD material.
JUNK_PATTERNS = re.compile(
    r"\b(horoscope|wordle|quiz|crossword|podcast|live updates?|live blog|live streaming|"
    r"watch:|in pics|in photos|photos:|video:|video\b|recipe|box office|celebrity|"
    r"bollywood|astrology|the download:|gmp|price band|allotment|subscription status|"
    r"tickets?|save up to|% off|discount code|webinar|sponsored|"
    r"cricket|ipl|football|tennis|kabaddi|olympic|movie|film review|"
    r"campus connect|obituary)\b",
    re.I,
)
# URL paths that signal sport / entertainment / promo pages.
JUNK_URL = re.compile(
    r"/(sport|sports|cricket|entertainment|lifestyle|videos?|photos?|gallery|"
    r"astrology|horoscope|events?|podcasts?|about|premium|cities|city|"
    r"education/|jobs/|bollywood|hollywood|recipes?|travel)/",
    re.I,
)

# Words that make a headline more GD-worthy for each category (used only for
# ranking; each match adds a little to the story's score).
RELEVANCE = {
    "geopolitics": (
        "china us united states trump russia ukraine israel iran gaza pakistan taiwan "
        "tariff tariffs sanction sanctions nato un summit election war ceasefire brics "
        "quad g20 border diplomacy modi jaishankar europe eu japan bangladesh sri lanka "
        "nepal maldives middle east west asia treaty"
    ),
    "economy": (
        "rbi gdp inflation repo rate budget fiscal gst tax rupee fdi exports imports "
        "trade fta tariff cpi wpi iip pmi deficit sebi msme jobs employment subsidy policy "
        "niti aayog finance ministry sitharaman growth upi banks credit bond yields "
        "monetary reserve forex crore lakh"
    ),
    "business": (
        "ipo acquisition acquires merger deal stake funding raises valuation earnings "
        "profit revenue quarter q1 q2 q3 q4 ceo chairman md resigns appoints startup "
        "unicorn tata reliance adani infosys tcs hdfc jio airtel layoffs expansion plant "
        "investment listing shares market cap"
    ),
    "technology": (
        "ai artificial intelligence chip chips semiconductor openai google microsoft "
        "nvidia apple meta amazon quantum robot robots data centre data center 5g 6g "
        "launch launches cyber hack breach ev battery isro space drone model gpu app "
        "digital platform regulation"
    ),
    "science": (
        "climate emissions carbon renewable solar wind heatwave monsoon flood cyclone cop "
        "net zero biodiversity forest pollution air quality water glacier research study "
        "scientists vaccine isro nasa species plastic energy warming el nino drought "
        "wildlife ocean discovery"
    ),
}
RELEVANCE = {k: set(v.split()) for k, v in RELEVANCE.items()}

# ---------------------------------------------------------------------------
# Feeds
# ---------------------------------------------------------------------------
# Each feed has:
#   name    - shown on the site as the source
#   url     - the RSS/Atom URL (fetched directly first)
#   gnews   - optional Google News search query used automatically if the
#             direct feed is blocked (many Indian sites block cloud servers).
#             Google News links are decoded back to the original article.
#   weight  - editorial importance (higher = more likely to be selected)


def gnews(query: str) -> str:
    q = requests.utils.quote(query)
    return f"https://news.google.com/rss/search?q={q}+when:2d&hl=en-IN&gl=IN&ceid=IN:en"


CATEGORIES = [
    {
        "key": "geopolitics",
        "title": "Geopolitics & International Relations",
        "feeds": [
            {"name": "BBC World", "url": "https://feeds.bbci.co.uk/news/world/rss.xml", "weight": 3},
            {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml", "weight": 2},
            {"name": "Reuters", "url": gnews("site:reuters.com/world"), "weight": 3},
            {"name": "The Hindu", "url": "https://www.thehindu.com/news/international/feeder/default.rss",
             "gnews": "site:thehindu.com/news/international", "weight": 3},
            {"name": "Indian Express", "url": "https://indianexpress.com/section/world/feed/",
             "gnews": "site:indianexpress.com/article/world", "weight": 2},
            {"name": "The Diplomat", "url": "https://thediplomat.com/feed/", "weight": 2},
        ],
    },
    {
        "key": "economy",
        "title": "Indian Economy, Policy, Budget & RBI",
        "feeds": [
            {"name": "Mint", "url": "https://www.livemint.com/rss/economy",
             "gnews": "site:livemint.com/economy", "weight": 3},
            {"name": "Economic Times", "url": "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms",
             "gnews": "site:economictimes.indiatimes.com/news/economy", "weight": 3},
            {"name": "Business Standard", "url": "https://www.business-standard.com/rss/economy-102.rss",
             "gnews": "site:business-standard.com/economy", "weight": 3},
            {"name": "The Hindu", "url": "https://www.thehindu.com/business/Economy/feeder/default.rss",
             "gnews": "site:thehindu.com/business/Economy", "weight": 3},
            {"name": "PIB", "url": "https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3",
             "gnews": "site:pib.gov.in", "weight": 2},
            {"name": "RBI", "url": "https://www.rbi.org.in/pressreleases_rss.xml", "weight": 2},
            {"name": "Indian Express", "url": "https://indianexpress.com/section/business/economy/feed/",
             "gnews": "site:indianexpress.com/article/business/economy", "weight": 2},
        ],
    },
    {
        "key": "business",
        "title": "Business & Corporate",
        "feeds": [
            {"name": "Mint", "url": "https://www.livemint.com/rss/companies",
             "gnews": "site:livemint.com/companies", "weight": 3},
            {"name": "Economic Times", "url": "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms",
             "gnews": "site:economictimes.indiatimes.com/industry", "weight": 3},
            {"name": "Business Standard", "url": "https://www.business-standard.com/rss/companies-101.rss",
             "gnews": "site:business-standard.com/companies", "weight": 3},
            {"name": "The Hindu", "url": "https://www.thehindu.com/business/feeder/default.rss",
             "gnews": "site:thehindu.com/business", "weight": 2},
            {"name": "Inc42", "url": "https://inc42.com/feed/", "weight": 2},
            {"name": "YourStory", "url": "https://yourstory.com/feed", "weight": 1},
        ],
    },
    {
        "key": "technology",
        "title": "Technology, AI & Innovation",
        "feeds": [
            {"name": "TechCrunch", "url": "https://techcrunch.com/feed/", "weight": 2},
            {"name": "MIT Technology Review", "url": "https://www.technologyreview.com/feed/", "weight": 3},
            {"name": "BBC Technology", "url": "https://feeds.bbci.co.uk/news/technology/rss.xml", "weight": 2},
            {"name": "Economic Times", "url": "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms",
             "gnews": "site:economictimes.indiatimes.com/tech", "weight": 3},
            {"name": "Mint", "url": "https://www.livemint.com/rss/technology",
             "gnews": "site:livemint.com/technology", "weight": 2},
            {"name": "Indian Express", "url": "https://indianexpress.com/section/technology/feed/",
             "gnews": "site:indianexpress.com/article/technology", "weight": 2},
        ],
    },
    {
        "key": "science",
        "title": "Science, Climate & Sustainability",
        "feeds": [
            {"name": "Down To Earth", "url": gnews("site:downtoearth.org.in"), "weight": 3},
            {"name": "BBC Science", "url": "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", "weight": 3},
            {"name": "Carbon Brief", "url": "https://www.carbonbrief.org/feed/", "weight": 2},
            {"name": "Mongabay India", "url": "https://india.mongabay.com/feed/", "weight": 2},
            {"name": "Science Daily", "url": "https://www.sciencedaily.com/rss/top/science.xml", "weight": 1},
            {"name": "Nature", "url": "https://www.nature.com/nature.rss", "weight": 1},
            {"name": "The Hindu", "url": "https://www.thehindu.com/sci-tech/feeder/default.rss",
             "gnews": "site:thehindu.com/sci-tech", "weight": 2},
        ],
    },
]

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Story:
    title: str
    url: str
    source: str
    category: str
    published: datetime | None
    description: str
    weight: int
    via_gnews: bool = False
    cluster_size: int = 1
    score: float = 0.0
    # filled by Gemini (or fallback)
    summary: str = ""
    why_it_matters: str = ""
    gd_for: list[str] = field(default_factory=list)
    gd_against: list[str] = field(default_factory=list)
    key_fact: str = ""
    ai: bool = False

    def to_json(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "source": self.source,
            "published": self.published.astimezone(IST).isoformat() if self.published else None,
            "summary": self.summary,
            "why_it_matters": self.why_it_matters,
            "gd_for": self.gd_for,
            "gd_against": self.gd_against,
            "key_fact": self.key_fact,
            "ai": self.ai,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def log(msg: str) -> None:
    print(msg, flush=True)


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def clean_title(title: str) -> str:
    title = strip_html(title)
    # Google News appends " - Publisher"; drop it.
    title = re.sub(r"\s+-\s+[^-]{2,40}$", "", title)
    return title.strip()


STOPWORDS = set(
    "a an the of to in on for and or at by with from as is are was were be been "
    "this that these those it its into over after amid says say said will has have "
    "had not no new up out about than vs via how why what who".split()
)


def normalize(title: str) -> str:
    words = re.findall(r"[a-z0-9]+", title.lower())
    return " ".join(w for w in words if w not in STOPWORDS)


def similar(a: str, b: str) -> bool:
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return False
    if SequenceMatcher(None, na, nb).ratio() >= 0.62:
        return True
    sa, sb = set(na.split()), set(nb.split())
    jacc = len(sa & sb) / max(1, len(sa | sb))
    return jacc >= 0.5


def entry_datetime(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        tp = entry.get(key)
        if tp:
            try:
                return datetime(*tp[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return None


# ---------------------------------------------------------------------------
# Google News link decoding (best effort — falls back to the Google link)
# ---------------------------------------------------------------------------


def decode_gnews_link(url: str) -> str:
    m = re.search(r"news\.google\.com/rss/articles/([^/?]+)", url)
    if not m:
        return url
    art_id = m.group(1)
    try:
        page = requests.get(
            f"https://news.google.com/rss/articles/{art_id}", headers=BROWSER_HEADERS, timeout=15
        ).text
        sig = re.search(r'data-n-a-sg="([^"]+)"', page)
        ts = re.search(r'data-n-a-ts="([^"]+)"', page)
        if not (sig and ts):
            return url
        inner = (
            '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],'
            f'"X","X",1,[1,1,1],1,1,null,0,0,null,0],"{art_id}",{ts.group(1)},"{sig.group(1)}"]'
        )
        body = {"f.req": json.dumps([[["Fbv4je", inner]]])}
        r = requests.post(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute",
            data=body,
            headers={**BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
            timeout=15,
        )
        txt = r.text.split("\n\n", 1)[1] if "\n\n" in r.text else r.text
        data = json.loads(txt)
        decoded = json.loads(data[0][2])[1]
        if isinstance(decoded, str) and decoded.startswith("http"):
            return decoded
    except Exception as exc:  # noqa: BLE001
        log(f"    (could not decode Google News link: {type(exc).__name__})")
    return url


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def fetch_feed_url(url: str):
    """Return (entries, error). Empty entries counts as failure."""
    try:
        r = requests.get(url, headers=BROWSER_HEADERS, timeout=FETCH_TIMEOUT)
        if r.status_code != 200:
            return [], f"HTTP {r.status_code}"
        parsed = feedparser.parse(r.content)
        if not parsed.entries:
            return [], "no entries"
        return parsed.entries, None
    except Exception as exc:  # noqa: BLE001
        return [], f"{type(exc).__name__}"


def fetch_feed(cat_key: str, feed: dict) -> tuple[list[Story], str, str | None]:
    """Fetch one feed (with Google News fallback). Returns (stories, name, error)."""
    name = feed["name"]
    entries, err = fetch_feed_url(feed["url"])
    via_gnews = "news.google.com" in feed["url"]
    if not entries and feed.get("gnews"):
        entries, err2 = fetch_feed_url(gnews(feed["gnews"]))
        if entries:
            via_gnews = True
            log(f"  {name:22} direct feed failed ({err}); using Google News fallback")
        else:
            err = f"{err}; fallback {err2}"
    if not entries:
        return [], name, err

    cutoff = datetime.now(timezone.utc) - timedelta(hours=MAX_STORY_AGE_HOURS)
    stories: list[Story] = []
    for e in entries[:60]:
        title = clean_title(e.get("title", ""))
        link = (e.get("link") or "").strip()
        if not title or not link or len(title) < 25:
            continue
        if JUNK_PATTERNS.search(title) or JUNK_URL.search(link):
            continue
        published = entry_datetime(e)
        if published and published < cutoff:
            continue
        desc = strip_html(e.get("summary") or e.get("description") or "")
        if via_gnews and desc.lower().startswith(title.lower()[:30]):
            desc = ""  # Google News "descriptions" are just the headline again
        stories.append(
            Story(
                title=title,
                url=link,
                source=name,
                category=cat_key,
                published=published,
                description=desc[:500],
                weight=feed.get("weight", 1),
                via_gnews=via_gnews,
            )
        )
    return stories, name, None


def fetch_all() -> tuple[dict[str, list[Story]], list[str], list[str]]:
    jobs = [(c["key"], f) for c in CATEGORIES for f in c["feeds"]]
    by_cat: dict[str, list[Story]] = {c["key"]: [] for c in CATEGORIES}
    ok, failed = [], []
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        for stories, name, err in ex.map(lambda j: fetch_feed(*j), jobs):
            if err:
                failed.append(f"{name} ({err})")
                log(f"  {name:22} FAILED: {err}")
            else:
                ok.append(name)
                if stories:
                    by_cat[stories[0].category].extend(stories)
                log(f"  {name:22} {len(stories):3} fresh stories")
    return by_cat, sorted(set(ok)), sorted(set(failed))


# ---------------------------------------------------------------------------
# Deduplicate and rank
# ---------------------------------------------------------------------------


def select_stories(stories: list[Story], already_chosen: list[Story]) -> list[Story]:
    now = datetime.now(timezone.utc)

    def recency(s: Story) -> float:
        if not s.published:
            return 0.3
        age_h = max(0.0, (now - s.published).total_seconds() / 3600)
        return max(0.0, 1.0 - age_h / MAX_STORY_AGE_HOURS)

    # Cluster near-duplicate headlines; the cluster keeps the best representative.
    clusters: list[list[Story]] = []
    for s in sorted(stories, key=lambda x: (x.weight, recency(x)), reverse=True):
        for cl in clusters:
            if similar(cl[0].title, s.title):
                cl.append(s)
                break
        else:
            clusters.append([s])

    def relevance(s: Story) -> float:
        words = set(re.findall(r"[a-z0-9]+", (s.title + " " + s.description[:200]).lower()))
        hits = len(words & RELEVANCE.get(s.category, set()))
        return min(2.0, 0.6 * hits)

    ranked = []
    for cl in clusters:
        rep = max(cl, key=lambda x: (not x.via_gnews, x.weight, len(x.description)))
        rep.cluster_size = len(cl)
        rep.score = (
            rep.weight
            + 1.0 * (len(cl) - 1)          # covered by several sources = important
            + 1.0 * recency(rep)
            + relevance(rep)
            + (0.3 if rep.description else 0)
        )
        ranked.append((rep.score, rep))
    ranked.sort(key=lambda t: t[0], reverse=True)

    chosen: list[Story] = []
    per_source: dict[str, int] = {}
    for _, s in ranked:
        if any(similar(s.title, c.title) or s.url == c.url for c in already_chosen + chosen):
            continue
        if per_source.get(s.source, 0) >= MAX_PER_SOURCE:
            continue
        chosen.append(s)
        per_source[s.source] = per_source.get(s.source, 0) + 1
        if len(chosen) >= STORIES_PER_CATEGORY:
            break
    return chosen


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------


class GeminiClient:
    def __init__(self, api_key: str | None):
        self.api_key = api_key
        self.model_used: str | None = None
        self.candidates: list[str] | None = None
        self.calls = 0
        self.failures = 0

    @property
    def enabled(self) -> bool:
        return bool(self.api_key) and os.environ.get("SKIP_AI") != "1"

    # -- model discovery ---------------------------------------------------
    @staticmethod
    def _version(name: str) -> float:
        m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
        return float(m.group(1)) if m else 0.0

    def discover_models(self) -> list[str]:
        """Return model names to try, best first. Uses Google's live model list."""
        forced = os.environ.get("GEMINI_MODEL", "").strip()
        available: list[str] = []
        try:
            r = requests.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": self.api_key, "pageSize": 200},
                timeout=30,
            )
            if r.status_code == 200:
                for m in r.json().get("models", []):
                    name = m.get("name", "").replace("models/", "")
                    methods = m.get("supportedGenerationMethods", [])
                    if "generateContent" not in methods:
                        continue
                    low = name.lower()
                    if "flash" not in low or not low.startswith("gemini-"):
                        continue
                    # skip speciality variants that are not plain text models
                    if re.search(r"live|tts|image|audio|omni|native|thinking|embedding|computer|robotics", low):
                        continue
                    available.append(name)
            else:
                log(f"  Could not list Gemini models (HTTP {r.status_code}): {r.text[:120]}")
        except Exception as exc:  # noqa: BLE001
            log(f"  Could not list Gemini models ({type(exc).__name__})")

        def rank(name: str):
            low = name.lower()
            return (
                "preview" in low or "exp" in low,   # stable first
                "lite" in low,                     # full Flash before Flash-Lite
                -self._version(low),               # newest version first
                bool(re.search(r"-\d{2,}$", low)),  # generic alias before dated snapshot
                len(name),
            )

        available.sort(key=rank)
        ordered = ([forced] if forced else []) + available + GEMINI_FALLBACK_MODELS
        ordered = list(dict.fromkeys(ordered))
        if available:
            log(f"  Gemini models available: {', '.join(available[:6])}{' ...' if len(available) > 6 else ''}")
        return ordered[:6]

    def generate_json(self, prompt: str):
        """Ask Gemini for a JSON response. Returns parsed JSON or None."""
        if not self.enabled:
            return None
        if self.candidates is None:
            self.candidates = self.discover_models()
        models = [self.model_used] if self.model_used else self.candidates
        for model in models:
            for attempt in range(GEMINI_MAX_RETRIES):
                if self.calls:
                    time.sleep(GEMINI_DELAY_SECONDS)
                self.calls += 1
                try:
                    r = requests.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                        params={"key": self.api_key},
                        json={
                            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                            "generationConfig": {
                                "responseMimeType": "application/json",
                            },
                        },
                        timeout=90,
                    )
                except Exception as exc:  # noqa: BLE001
                    log(f"  Gemini network error ({type(exc).__name__}), retrying")
                    continue
                if r.status_code == 200:
                    try:
                        parts = r.json()["candidates"][0]["content"]["parts"]
                        # Gemini 3 models can return "thought" parts; keep only the answer.
                        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
                        self.model_used = model
                        return json.loads(text)
                    except Exception as exc:  # noqa: BLE001
                        log(f"  Gemini returned unparseable output ({type(exc).__name__}), retrying")
                        continue
                if r.status_code == 429:
                    wait = 30 * (attempt + 1)
                    log(f"  Gemini rate limit on {model}; waiting {wait}s")
                    time.sleep(wait)
                    continue
                if r.status_code in (404, 400, 403):
                    detail = ""
                    try:
                        detail = ": " + r.json()["error"]["message"][:140]
                    except Exception:  # noqa: BLE001
                        pass
                    log(f"  Gemini {model} unavailable (HTTP {r.status_code}){detail}; trying next model")
                    break
                log(f"  Gemini HTTP {r.status_code}; retrying")
            if self.model_used == model:
                break
        self.failures += 1
        return None


def story_block(stories: list[Story]) -> str:
    lines = []
    for i, s in enumerate(stories):
        lines.append(f"[{i}] {s.title} (Source: {s.source})")
        if s.description:
            lines.append(f"    Details: {s.description[:350]}")
    return "\n".join(lines)


def enrich_category(client: GeminiClient, cat_title: str, stories: list[Story]) -> None:
    if not stories:
        return
    prompt = f"""You are a coach preparing an Indian MBA student for placement group discussions (GDs) and interviews.
Today's date: {datetime.now(IST).strftime('%d %B %Y')}. Category: {cat_title}.

For EACH story below, write:
- "summary": 2-3 short sentences in simple English explaining what happened. Use only the information given plus widely known background; do not invent numbers.
- "why_it_matters": 1-2 sentences, with an India angle where relevant.
- "gd_for": exactly 2 short points supporting the development / the "pro" side.
- "gd_against": exactly 2 short points opposing it, or alternative perspectives / risks.
- "key_fact": ONE quotable fact or number from the story (or well-known context). If none is available, give a relevant well-known statistic and mark it as context, e.g. "Context: ...".

Return ONLY a JSON array with one object per story, in the same order, each with an "index" field matching the story number.

Stories:
{story_block(stories)}
"""
    result = client.generate_json(prompt)
    if not isinstance(result, list):
        log(f"  {cat_title}: AI enrichment unavailable, using RSS fallback")
        return
    by_index = {}
    for item in result:
        if isinstance(item, dict) and "index" in item:
            try:
                by_index[int(item["index"])] = item
            except (TypeError, ValueError):
                pass
    for i, s in enumerate(stories):
        if by_index:
            item = by_index.get(i)
        else:  # model forgot the index field: assume same order
            item = result[i] if i < len(result) and isinstance(result[i], dict) else None
        if not item:
            continue
        s.summary = str(item.get("summary", "")).strip() or s.summary
        s.why_it_matters = str(item.get("why_it_matters", "")).strip()
        s.gd_for = [str(x).strip() for x in item.get("gd_for", []) if str(x).strip()][:2]
        s.gd_against = [str(x).strip() for x in item.get("gd_against", []) if str(x).strip()][:2]
        s.key_fact = str(item.get("key_fact", "")).strip()
        s.ai = bool(s.summary)
    log(f"  {cat_title}: AI enrichment done ({len(by_index)} stories)")


def generate_topic_and_concept(client: GeminiClient, all_stories: list[Story], recent_concepts: list[str]):
    headlines = "\n".join(f"- {s.title} ({s.source})" for s in all_stories)
    avoid = ", ".join(recent_concepts) if recent_concepts else "none"
    prompt = f"""You are a coach preparing an Indian MBA student for placement group discussions (GDs).
Today's date: {datetime.now(IST).strftime('%d %B %Y')}.

Today's headlines:
{headlines}

Task 1 — Pick the ONE topic from these headlines most likely to be given as a GD topic in Indian B-school placements (debatable, big-picture, India-relevant). Provide:
- "topic": the GD topic phrased as B-schools phrase it (e.g. a statement or question, under 15 words)
- "why_now": 1-2 sentences on why this is topical
- "opening_line": a confident 2-sentence opening a student can say to start the GD (frame the topic, give one fact)
- "closing_line": a strong 2-sentence closing that summarises and takes a balanced stand
- "perspectives": 3 short bullet points giving different stakeholder perspectives (e.g. government, industry, citizens, global)

Task 2 — "Concept of the Day": pick one business / economics / strategy / finance concept that helps in GDs and interviews, ideally connected to today's news. Do NOT use these recently covered concepts: {avoid}. Provide:
- "name": concept name
- "explanation": 3-4 simple sentences explaining it as if to a smart friend
- "indian_example": a concrete Indian company, policy or market example (2-3 sentences)
- "use_in_gd": 1-2 sentences on how to drop this concept into a GD or interview answer

Return ONLY JSON: {{"gd_topic": {{...}}, "concept": {{...}}}}
"""
    result = client.generate_json(prompt)
    if not isinstance(result, dict):
        return None, None
    topic = result.get("gd_topic") if isinstance(result.get("gd_topic"), dict) else None
    concept = result.get("concept") if isinstance(result.get("concept"), dict) else None
    return topic, concept


# ---------------------------------------------------------------------------
# Fallbacks (used when Gemini is off)
# ---------------------------------------------------------------------------


def apply_fallbacks(stories: list[Story]) -> None:
    for s in stories:
        if not s.summary:
            s.summary = s.description or "Open the source link to read the full story."
            s.ai = False


def fallback_topic(all_stories: list[Story]) -> dict:
    pool = [s for s in all_stories if s.category in ("geopolitics", "economy", "business")] or all_stories
    top = max(pool, key=lambda s: (s.cluster_size, s.score), default=None)
    title = top.title if top else "Today's biggest headline"
    return {
        "topic": title,
        "why_now": "Chosen automatically because several sources covered it today. AI commentary was unavailable for this brief.",
        "opening_line": f"Let me set the context: today's headlines are dominated by \"{title}\". Before we take sides, it is worth separating the short-term impact from the long-term implications.",
        "closing_line": "To sum up, the group has surfaced both the opportunities and the risks. A balanced view would be to support the direction while insisting on safeguards and clear accountability.",
        "perspectives": [],
        "fallback": True,
    }


# ---------------------------------------------------------------------------
# Archive helpers
# ---------------------------------------------------------------------------


def load_index() -> list[dict]:
    path = ARCHIVE_DIR / "index.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:  # noqa: BLE001
            pass
    return []


def save_index(entries: list[dict]) -> None:
    entries = {e["date"]: e for e in entries if isinstance(e, dict) and e.get("date")}
    ordered = sorted(entries.values(), key=lambda e: e["date"], reverse=True)
    (ARCHIVE_DIR / "index.json").write_text(json.dumps(ordered, indent=2, ensure_ascii=False), encoding="utf-8")


def reading_time_minutes(brief: dict) -> int:
    words = 0

    def count(x):
        nonlocal words
        if isinstance(x, str):
            words += len(x.split())
        elif isinstance(x, list):
            for i in x:
                count(i)
        elif isinstance(x, dict):
            for v in x.values():
                count(v)

    count(brief.get("gd_topic"))
    count(brief.get("concept"))
    for c in brief.get("categories", []):
        for s in c.get("stories", []):
            count({k: v for k, v in s.items() if k not in ("url", "published", "source")})
    return max(1, round(words / 200))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    started = time.time()
    today = datetime.now(IST)
    date_str = today.strftime("%Y-%m-%d")
    log(f"Daily GD Brief — building for {date_str} ({today.strftime('%A, %d %B %Y %H:%M IST')})")

    log("\n1) Fetching feeds")
    by_cat, ok_sources, failed_sources = fetch_all()

    log("\n2) Selecting stories")
    chosen_all: list[Story] = []
    selected: dict[str, list[Story]] = {}
    for cat in CATEGORIES:
        picks = select_stories(by_cat[cat["key"]], chosen_all)
        selected[cat["key"]] = picks
        chosen_all.extend(picks)
        log(f"  {cat['title']:40} {len(by_cat[cat['key']]):3} candidates -> {len(picks)} chosen")

    if not chosen_all:
        log("\nNo stories fetched at all. Keeping the previous brief untouched.")
        return 1

    log("\n3) Resolving Google News links to original articles")
    for s in chosen_all:
        if s.via_gnews:
            s.url = decode_gnews_link(s.url)

    client = GeminiClient(os.environ.get("GEMINI_API_KEY", "").strip() or None)
    if client.enabled:
        log("\n4) Writing summaries with Gemini")
        for cat in CATEGORIES:
            enrich_category(client, cat["title"], selected[cat["key"]])
    else:
        log("\n4) Gemini disabled (no GEMINI_API_KEY or SKIP_AI=1) — using RSS text")

    recent_concepts = [e.get("concept") for e in load_index()[:14] if e.get("concept")]
    topic, concept = (None, None)
    if client.enabled:
        topic, concept = generate_topic_and_concept(client, chosen_all, recent_concepts)
    if not topic:
        topic = fallback_topic(chosen_all)
    if concept is None:
        log("  Concept of the day unavailable (AI off or failed)")

    for stories in selected.values():
        apply_fallbacks(stories)

    ai_stories = sum(1 for s in chosen_all if s.ai)
    brief = {
        "date": date_str,
        "date_label": today.strftime("%A, %d %B %Y"),
        "generated_at": today.isoformat(),
        "ai_enabled": client.enabled,
        "ai_model": client.model_used,
        "ai_story_count": ai_stories,
        "story_count": len(chosen_all),
        "gd_topic": topic,
        "concept": concept,
        "categories": [
            {"key": c["key"], "title": c["title"], "stories": [s.to_json() for s in selected[c["key"]]]}
            for c in CATEGORIES
        ],
        "sources_ok": ok_sources,
        "sources_failed": failed_sources,
    }
    brief["reading_time_min"] = reading_time_minutes(brief)

    log("\n5) Writing files")
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(brief, indent=2, ensure_ascii=False)
    (DATA_DIR / "latest.json").write_text(payload, encoding="utf-8")
    (ARCHIVE_DIR / f"{date_str}.json").write_text(payload, encoding="utf-8")
    index = load_index()
    index.append(
        {
            "date": date_str,
            "label": brief["date_label"],
            "gd_topic": (topic or {}).get("topic", ""),
            "concept": (concept or {}).get("name", ""),
            "story_count": len(chosen_all),
            "ai": client.enabled and ai_stories > 0,
        }
    )
    save_index(index)

    log(f"  data/latest.json and data/archive/{date_str}.json written")
    log(f"\nDone in {time.time() - started:.0f}s — {len(chosen_all)} stories, "
        f"{ai_stories} with AI commentary, reading time ~{brief['reading_time_min']} min, "
        f"{len(failed_sources)} feed(s) failed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
