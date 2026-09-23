#!/usr/bin/env python3
"""Daily GD Brief — build script (v2).

Fetches RSS feeds, picks at most MAX_STORIES_PER_DAY stories, asks Gemini for
GD-oriented commentary, and writes data/latest.json + data/archive/<date>.json.

Design rules that matter:
  * The brief is NEVER larger than MAX_STORIES_PER_DAY (25) stories.
  * The script writes a publishable brief BEFORE calling Gemini, then rewrites
    it with commentary. A killed or timed-out run still leaves a valid brief.
  * The whole Gemini phase is bounded by AI_DEADLINE_SECONDS, so the job can
    never sit in retry loops until GitHub cancels it.

Environment:
  GEMINI_API_KEY   optional; without it the brief is headlines + RSS text
  GEMINI_MODEL     optional; forces one model instead of auto-discovery
  SKIP_AI=1        skip Gemini entirely (fast local runs)
  SKIP_SNIPPETS=1  skip fetching article snippets
  AI_DEADLINE      optional override (seconds) for the Gemini phase
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
MAX_STORIES_PER_DAY = 25        # HARD CAP on the whole brief
MIN_PER_CATEGORY = 3            # every category gets at least this many
MAX_PER_CATEGORY = 6            # ... and never more than this
MIN_EXTRA_SCORE = 4.0           # a story needs this score to win a bonus slot
MAX_PER_SOURCE = 2              # source diversity inside a category
MAX_PER_SOURCE_GLOBAL = 5       # ... and across the whole brief
CROSS_DAY_LOOKBACK = 3          # don't repeat stories from the last N briefs
FETCH_TIMEOUT = 20              # seconds per feed
SNIPPET_TIMEOUT = 6             # seconds per article snippet
REQUIRE_DATE = True             # drop entries with no usable publish date

# --- Gemini budget ---------------------------------------------------------
# The free tier is small and slow. Everything below exists so that a bad quota
# day costs a few minutes, not a cancelled job.
GEMINI_FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"]
GEMINI_DELAY_SECONDS = 6        # free tier allows ~10 requests/minute
GEMINI_MAX_RETRIES = 2
GEMINI_TIMEOUT = 60             # seconds per request
GEMINI_MAX_MODELS = 4           # candidates to try before giving up
MAX_RATE_LIMIT_HITS = 3         # after this many 429s, stop using AI at all
AI_DEADLINE_SECONDS = int(os.environ.get("AI_DEADLINE", "480"))  # 8 minutes
CURATION_SHORTLIST = 12         # stories per category sent to the AI curator
ENRICH_BATCH_SIZE = 9           # stories per enrichment call

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

# Headlines containing these words are usually not GD material.
# (Education, jobs, health and city governance are deliberately NOT filtered:
# they are classic GD topics.)
JUNK_PATTERNS = re.compile(
    r"\b(horoscope|wordle|quiz|crossword|podcast|live updates?|live blog|live streaming|"
    r"watch:|in pics|in photos|photos:|video:|recipe|box office|celebrity|"
    r"bollywood|astrology|the download:|gmp|price band|allotment|subscription status|"
    r"save up to|% off|discount code|webinar|sponsored|"
    r"cricket|ipl|football|tennis|kabaddi|olympics?|movie review|film review|"
    r"campus connect|obituary|daily digest|top headlines)\b",
    re.I,
)
# URL paths that signal sport / entertainment / promo pages.
JUNK_URL = re.compile(
    r"/(sport|sports|cricket|entertainment|lifestyle|videos?|photos?|gallery|"
    r"astrology|horoscope|podcasts?|about|premium|bollywood|hollywood|recipes?|travel|"
    r"fashion|food|web-?stories)/",
    re.I,
)

# Headlines that suggest a genuinely NEW development, so it is fine to run a
# story again even if we covered the same subject a day or two ago.
DEVELOPMENT_RE = re.compile(
    r"\b(passes|passed|approves?|approved|ratified|signed|clears?|cleared|rejects?|"
    r"verdict|ruling|resigns?|quits|announces?|announced|launches?|launched|cuts?|hikes?|"
    r"raises?|bans?|banned|strikes?|deal|agreement|results?|wins?|dies|killed|record)\b",
    re.I,
)

# Phrases that make a headline more GD-worthy per category. These are matched
# as PHRASES (so "sri lanka" and "net zero" work), not split into words.
RELEVANCE_PHRASES = {
    "geopolitics": """china united states u.s. trump russia ukraine israel iran gaza pakistan
        taiwan tariff tariffs sanction sanctions nato united nations summit election war
        ceasefire brics quad g20 border diplomacy modi jaishankar european union japan
        bangladesh sri lanka nepal maldives myanmar middle east west asia treaty
        indo-pacific defence deal foreign policy visa immigration""",
    "economy": """rbi gdp inflation repo rate budget fiscal deficit gst tax rupee fdi exports
        imports trade fta tariff cpi wpi iip pmi sebi msme unemployment employment subsidy
        niti aayog finance ministry sitharaman growth upi banks credit bond yields monetary
        policy forex reserves manufacturing agriculture farm income poverty per capita
        interest rates disinvestment privatisation""",
    "business": """ipo acquisition acquires merger stake funding valuation earnings profit
        revenue quarterly results ceo chairman managing director resigns appoints startup
        unicorn tata reliance adani infosys tcs hdfc jio airtel layoffs expansion factory
        investment listing market cap antitrust cci regulator monopoly consumer""",
    "technology": """artificial intelligence ai chip semiconductor openai google microsoft
        nvidia apple meta amazon quantum robot data centre data center 5g 6g cyber hack
        data breach privacy electric vehicle battery isro space drone gpu digital platform
        regulation deepfake social media algorithm automation jobs open source""",
    "science": """climate change emissions carbon renewable solar wind heatwave monsoon flood
        cyclone cop30 net zero biodiversity forest pollution air quality groundwater glacier
        research study scientists vaccine antibiotic isro nasa species plastic energy
        transition global warming el nino drought wildlife ocean genome""",
    "india": """parliament bill act ordinance supreme court high court judgment election
        commission governance policy scheme welfare subsidy reservation caste women safety
        education policy nep school university health care hospital insurance ayushman
        farmers labour code migration urban municipal census aadhaar right to information
        pollution delhi water crisis judiciary police reform federalism state government""",
}


# Multi-word phrases have to be listed explicitly so they are matched as a unit.
MULTIWORD = [
    "united states", "sri lanka", "middle east", "west asia", "european union",
    "net zero", "air quality", "data centre", "data center", "artificial intelligence",
    "climate change", "global warming", "el nino", "quarterly results", "market cap",
    "repo rate", "fiscal deficit", "interest rates", "foreign policy", "data breach",
    "electric vehicle", "social media", "open source", "supreme court", "high court",
    "election commission", "education policy", "health care", "right to information",
    "water crisis", "state government", "labour code", "per capita", "managing director",
    "energy transition", "indo-pacific", "u.s.",
]


def _build_relevance() -> dict[str, re.Pattern]:
    out = {}
    for cat, blob in RELEVANCE_PHRASES.items():
        text = " ".join(blob.split())
        terms = []
        remaining = text
        for phrase in MULTIWORD:
            if phrase in remaining:
                terms.append(phrase)
                remaining = remaining.replace(phrase, " ")
        terms.extend(t for t in remaining.split() if len(t) > 2)
        terms = sorted(set(terms), key=len, reverse=True)
        pattern = "|".join(re.escape(t) for t in terms)
        out[cat] = re.compile(r"(?<![a-z])(" + pattern + r")(?![a-z])", re.I)
    return out


RELEVANCE = _build_relevance()

# A small bonus for India relevance in the globally focused categories.
INDIA_RE = re.compile(
    r"\b(india|indian|delhi|mumbai|bengaluru|rbi|modi|rupee|sebi|niti|isro|upi)\b", re.I
)

# ---------------------------------------------------------------------------
# Feeds
# ---------------------------------------------------------------------------


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
    {
        # NEW in v2: the category most GD topics actually come from.
        "key": "india",
        "title": "India: Governance & Society",
        "feeds": [
            {"name": "The Hindu", "url": "https://www.thehindu.com/news/national/feeder/default.rss",
             "gnews": "site:thehindu.com/news/national", "weight": 3},
            {"name": "Indian Express", "url": "https://indianexpress.com/section/india/feed/",
             "gnews": "site:indianexpress.com/article/india", "weight": 3},
            {"name": "The Print", "url": "https://theprint.in/feed/", "weight": 2},
            {"name": "Scroll.in", "url": "https://scroll.in/feed", "weight": 2},
            {"name": "Mint Politics", "url": "https://www.livemint.com/rss/politics",
             "gnews": "site:livemint.com/politics", "weight": 2},
            {"name": "BBC India", "url": gnews("site:bbc.com/news/world-asia-india"), "weight": 2},
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
    base_score: float = 0.0
    ai_score: float | None = None
    snippet: str = ""
    # filled by Gemini (or fallback)
    summary: str = ""
    why_it_matters: str = ""
    gd_for: list[str] = field(default_factory=list)
    gd_against: list[str] = field(default_factory=list)
    key_fact: str = ""
    ai: bool = False

    @property
    def context(self) -> str:
        """Text given to the model: RSS description plus any fetched snippet."""
        parts = [self.description]
        if self.snippet and self.snippet[:60].lower() not in self.description.lower():
            parts.append(self.snippet)
        return " ".join(p for p in parts if p)[:700]

    def to_json(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "source": self.source,
            "published": self.published.astimezone(IST).isoformat() if self.published else None,
            "sources_count": self.cluster_size,
            "summary": self.summary,
            "why_it_matters": self.why_it_matters,
            "gd_for": self.gd_for,
            "gd_against": self.gd_against,
            "key_fact": self.key_fact,
            "fact_is_context": self.key_fact.strip().lower().startswith("context"),
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
    title = re.sub(r"\s+-\s+[^-]{2,40}$", "", title)   # Google News " - Publisher"
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
    """True if two headlines are about the same story.

    v2 adds an overlap check against the SHORTER headline, which catches the
    common case of a long, detail-packed headline and a short one describing
    the same event (e.g. the two India-New Zealand FTA headlines).
    """
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return False
    if SequenceMatcher(None, na, nb).ratio() >= 0.62:
        return True
    sa, sb = set(na.split()), set(nb.split())
    shared = len(sa & sb)
    if shared >= 3 and shared / min(len(sa), len(sb)) >= 0.6:
        return True
    return shared / max(1, len(sa | sb)) >= 0.5


def entry_datetime(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        tp = entry.get(key)
        if tp:
            try:
                return datetime(*tp[:6], tzinfo=timezone.utc)
            except Exception:  # noqa: BLE001
                pass
    return None


def safe_url(url: str) -> bool:
    return bool(re.match(r"https?://", (url or "").strip(), re.I))


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
            f"https://news.google.com/rss/articles/{art_id}", headers=BROWSER_HEADERS, timeout=8
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
            timeout=8,
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
# Article snippets — better input means better summaries
# ---------------------------------------------------------------------------

META_DESC = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:description|description)["\'][^>]+content=["\']([^"\']{40,600})',
    re.I,
)
META_DESC_ALT = re.compile(
    r'<meta[^>]+content=["\']([^"\']{40,600})["\'][^>]+(?:property|name)=["\'](?:og:description|description)["\']',
    re.I,
)


def fetch_snippet(url: str) -> str:
    if not safe_url(url):
        return ""
    try:
        r = requests.get(url, headers=BROWSER_HEADERS, timeout=SNIPPET_TIMEOUT, stream=True)
        if r.status_code != 200:
            return ""
        chunk = r.raw.read(180_000, decode_content=True) or b""
        text = chunk.decode("utf-8", errors="ignore")
        for rx in (META_DESC, META_DESC_ALT):
            m = rx.search(text)
            if m:
                return strip_html(m.group(1))[:400]
    except Exception:  # noqa: BLE001
        return ""
    return ""


def add_snippets(stories: list[Story]) -> int:
    if os.environ.get("SKIP_SNIPPETS") == "1":
        return 0
    got = 0
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for s, snip in zip(stories, ex.map(lambda x: fetch_snippet(x.url), stories)):
            if snip:
                s.snippet = snip
                got += 1
    return got


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
        if not title or not safe_url(link) or len(title) < 25:
            continue
        if JUNK_PATTERNS.search(title) or JUNK_URL.search(link):
            continue
        published = entry_datetime(e)
        if published is None and REQUIRE_DATE:
            continue
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
        for (cat_key, feed), (stories, name, err) in zip(jobs, ex.map(lambda j: fetch_feed(*j), jobs)):
            if err:
                failed.append(f"{name} ({err})")
                log(f"  {name:22} FAILED: {err}")
            else:
                ok.append(name)
                by_cat[cat_key].extend(stories)
                log(f"  {name:22} {len(stories):3} fresh stories")
    return by_cat, sorted(set(ok)), sorted(set(failed))


# ---------------------------------------------------------------------------
# Ranking, deduplication and the 25-story budget
# ---------------------------------------------------------------------------


def recency_score(s: Story, now: datetime) -> float:
    if not s.published:
        return 0.3
    age_h = max(0.0, (now - s.published).total_seconds() / 3600)
    return max(0.0, 1.0 - age_h / MAX_STORY_AGE_HOURS)


def relevance_score(s: Story) -> float:
    text = f"{s.title} {s.description[:250]}"
    rx = RELEVANCE.get(s.category)
    hits = len({m.group(0).lower() for m in rx.finditer(text)}) if rx else 0
    score = min(2.0, 0.6 * hits)
    if s.category in ("geopolitics", "technology", "science", "business") and INDIA_RE.search(text):
        score += 0.5
    return score


def rank_category(stories: list[Story], now: datetime) -> list[Story]:
    """Cluster near-duplicates, score the representatives, best first."""
    clusters: list[list[Story]] = []
    for s in sorted(stories, key=lambda x: (x.weight, recency_score(x, now)), reverse=True):
        for cl in clusters:
            if similar(cl[0].title, s.title):
                cl.append(s)
                break
        else:
            clusters.append([s])

    ranked: list[Story] = []
    for cl in clusters:
        rep = max(cl, key=lambda x: (not x.via_gnews, x.weight, len(x.description)))
        rep.cluster_size = len(cl)
        rep.base_score = (
            rep.weight
            + 1.0 * (len(cl) - 1)              # covered by several sources = important
            + 1.0 * recency_score(rep, now)
            + relevance_score(rep)
            + (0.3 if rep.description else 0)
        )
        rep.score = rep.base_score
        ranked.append(rep)
    ranked.sort(key=lambda s: s.score, reverse=True)
    return ranked


def recent_titles(days: int, skip_date: str) -> list[str]:
    """Headlines from the last few briefs, so we do not repeat ourselves."""
    titles: list[str] = []
    if not ARCHIVE_DIR.exists():
        return titles
    files = sorted(ARCHIVE_DIR.glob("*.json"), reverse=True)
    used = 0
    for path in files:
        if path.name == "index.json" or path.stem == skip_date:
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        for cat in data.get("categories", []):
            for s in cat.get("stories", []):
                if s.get("title"):
                    titles.append(s["title"])
        used += 1
        if used >= days:
            break
    return titles


def is_repeat(story: Story, previous: list[str]) -> bool:
    """True if we already ran this story on a recent day.

    A near-identical headline is always a repeat. A related-but-different
    headline is allowed back only when it signals a new development
    ("passes", "verdict", "resigns", ...).
    """
    if not previous:
        return False
    for old in previous:
        if not similar(story.title, old):
            continue
        ratio = SequenceMatcher(None, normalize(story.title), normalize(old)).ratio()
        if ratio >= 0.85:
            return True                      # same headline, no second airing
        return not DEVELOPMENT_RE.search(story.title)
    return False


def build_shortlist(
    ranked_by_cat: dict[str, list[Story]], previous: list[str]
) -> dict[str, list[Story]]:
    """Filter cross-category duplicates, repeats and source floods."""
    shortlist: dict[str, list[Story]] = {}
    chosen: list[Story] = []
    for cat in CATEGORIES:
        key = cat["key"]
        picks: list[Story] = []
        per_source: dict[str, int] = {}
        for s in ranked_by_cat.get(key, []):
            if any(s.url == c.url or similar(s.title, c.title) for c in chosen + picks):
                continue
            if is_repeat(s, previous):
                continue
            if per_source.get(s.source, 0) >= MAX_PER_SOURCE:
                continue
            picks.append(s)
            per_source[s.source] = per_source.get(s.source, 0) + 1
            if len(picks) >= CURATION_SHORTLIST:
                break
        chosen.extend(picks)
        shortlist[key] = picks
    return shortlist


def allocate(shortlist: dict[str, list[Story]]) -> dict[str, list[Story]]:
    """Guaranteed minimum per category, bonus slots to the best stories, hard cap.

    Also enforces MAX_PER_SOURCE_GLOBAL so one publisher cannot fill the brief.
    """
    order = [c["key"] for c in CATEGORIES if c["key"] in shortlist]
    chosen: dict[str, list[Story]] = {k: [] for k in shortlist}
    per_source: dict[str, int] = {}
    total = 0

    def take(story: Story) -> bool:
        nonlocal total
        if total >= MAX_STORIES_PER_DAY:
            return False
        if per_source.get(story.source, 0) >= MAX_PER_SOURCE_GLOBAL:
            return False
        chosen[story.category].append(story)
        per_source[story.source] = per_source.get(story.source, 0) + 1
        total += 1
        return True

    # Pass 1: the guaranteed minimum for every category.
    for key in order:
        for s in shortlist[key]:
            if len(chosen[key]) >= MIN_PER_CATEGORY:
                break
            take(s)

    # Pass 2: bonus slots, strongest stories first, wherever they come from.
    extras = [
        s
        for key in order
        for s in shortlist[key]
        if s not in chosen[key] and s.score >= MIN_EXTRA_SCORE
    ]
    extras.sort(key=lambda s: s.score, reverse=True)
    for s in extras:
        if total >= MAX_STORIES_PER_DAY:
            break
        if len(chosen[s.category]) >= MAX_PER_CATEGORY:
            continue
        take(s)

    # Keep each category in score order for display.
    for key in chosen:
        chosen[key].sort(key=lambda s: s.score, reverse=True)
    return chosen


# ---------------------------------------------------------------------------
# Gemini — bounded, batched, deadline-aware
# ---------------------------------------------------------------------------


class GeminiClient:
    def __init__(self, api_key: str | None):
        self.api_key = api_key
        self.model_used: str | None = None
        self.candidates: list[str] | None = None
        self.calls = 0
        self.rate_limited = 0
        self.errors: list[str] = []
        self.deadline = time.monotonic() + AI_DEADLINE_SECONDS
        self.stopped = False

    @property
    def enabled(self) -> bool:
        return bool(self.api_key) and os.environ.get("SKIP_AI") != "1"

    @property
    def budget_left(self) -> float:
        return self.deadline - time.monotonic()

    def _stop(self, reason: str) -> None:
        if not self.stopped:
            self.stopped = True
            self.errors.append(reason)
            log(f"  AI budget spent: {reason}")

    # -- model discovery ---------------------------------------------------
    @staticmethod
    def _version(name: str) -> float:
        m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
        return float(m.group(1)) if m else 0.0

    def discover_models(self) -> list[str]:
        forced = os.environ.get("GEMINI_MODEL", "").strip()
        if forced:
            log(f"  Gemini model forced by GEMINI_MODEL: {forced}")
        available: list[str] = []
        try:
            r = requests.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                headers={"x-goog-api-key": self.api_key or ""},
                params={"pageSize": 200},
                timeout=20,
            )
            if r.status_code == 200:
                for m in r.json().get("models", []):
                    name = m.get("name", "").replace("models/", "")
                    if "generateContent" not in m.get("supportedGenerationMethods", []):
                        continue
                    low = name.lower()
                    if "flash" not in low or not low.startswith("gemini-"):
                        continue
                    if re.search(r"live|tts|image|audio|omni|native|thinking|embedding|computer|robotics", low):
                        continue
                    available.append(name)
            else:
                self.errors.append(f"model list HTTP {r.status_code}")
                log(f"  Could not list Gemini models (HTTP {r.status_code}): {r.text[:120]}")
        except Exception as exc:  # noqa: BLE001
            self.errors.append(f"model list {type(exc).__name__}")
            log(f"  Could not list Gemini models ({type(exc).__name__})")

        def rank(name: str):
            low = name.lower()
            return (
                "preview" in low or "exp" in low,
                "lite" in low,
                -self._version(low),
                bool(re.search(r"-\d{2,}$", low)),
                len(name),
            )

        available.sort(key=rank)
        ordered = ([forced] if forced else []) + available + GEMINI_FALLBACK_MODELS
        ordered = list(dict.fromkeys(ordered))
        if available:
            log(f"  Gemini models available: {', '.join(available[:6])}{' ...' if len(available) > 6 else ''}")
        return ordered[:GEMINI_MAX_MODELS]

    # -- the one call ------------------------------------------------------
    def generate_json(self, prompt: str, label: str = "call"):
        if not self.enabled or self.stopped:
            return None
        if self.budget_left <= 10:
            self._stop("time budget exhausted")
            return None
        if self.candidates is None:
            self.candidates = self.discover_models()

        models = list(dict.fromkeys(([self.model_used] if self.model_used else []) + self.candidates))
        for model in models:
            for attempt in range(GEMINI_MAX_RETRIES):
                if self.budget_left <= 10:
                    self._stop("time budget exhausted")
                    return None
                if self.rate_limited >= MAX_RATE_LIMIT_HITS:
                    self._stop(f"rate limited {self.rate_limited} times (free-tier quota)")
                    return None
                if self.calls:
                    time.sleep(min(GEMINI_DELAY_SECONDS, max(0.0, self.budget_left - 5)))
                self.calls += 1
                try:
                    r = requests.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                        headers={"x-goog-api-key": self.api_key or ""},
                        json={
                            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                            "generationConfig": {"responseMimeType": "application/json"},
                        },
                        timeout=GEMINI_TIMEOUT,
                    )
                except Exception as exc:  # noqa: BLE001
                    log(f"  Gemini {model}: network error ({type(exc).__name__})")
                    self.errors.append(f"{label}: network {type(exc).__name__}")
                    continue

                if r.status_code == 200:
                    try:
                        parts = r.json()["candidates"][0]["content"]["parts"]
                        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
                        self.model_used = model
                        return json.loads(text)
                    except Exception as exc:  # noqa: BLE001
                        log(f"  Gemini returned unparseable output ({type(exc).__name__}), retrying")
                        self.errors.append(f"{label}: unparseable output")
                        continue

                if r.status_code == 429:
                    self.rate_limited += 1
                    wait = min(15 * (attempt + 1), max(0, self.budget_left - 20))
                    log(f"  Gemini rate limit on {model} ({self.rate_limited}/{MAX_RATE_LIMIT_HITS});"
                        f" waiting {wait:.0f}s")
                    self.errors.append(f"{label}: rate limited on {model}")
                    if wait > 0:
                        time.sleep(wait)
                    continue

                if r.status_code >= 500:
                    log(f"  Gemini {model}: HTTP {r.status_code} (overloaded)")
                    self.errors.append(f"{label}: HTTP {r.status_code} on {model}")
                    break

                if r.status_code in (400, 403, 404):
                    detail = ""
                    try:
                        detail = ": " + r.json()["error"]["message"][:140]
                    except Exception:  # noqa: BLE001
                        pass
                    log(f"  Gemini {model} unavailable (HTTP {r.status_code}){detail}; trying next model")
                    self.errors.append(f"{label}: HTTP {r.status_code} on {model}")
                    break

                log(f"  Gemini {model}: HTTP {r.status_code}; retrying")
        self.errors.append(f"{label}: all models failed")
        return None


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------


def curate(client: GeminiClient, shortlist: dict[str, list[Story]]) -> None:
    """Ask the model to score the shortlist for GD-worthiness (one call)."""
    flat: list[Story] = [s for cat in CATEGORIES for s in shortlist.get(cat["key"], [])]
    if not flat or not client.enabled:
        return
    lines = []
    for i, s in enumerate(flat):
        lines.append(f"[{i}] ({s.category}) {s.title}")
    prompt = f"""You are selecting news stories for a daily brief used by Indian MBA students
preparing for placement group discussions (GDs) and interviews.

Score EACH headline from 1 to 10 on how useful it is for GD/interview preparation:
10 = debatable, big-picture, India-relevant, likely to be a GD topic or an interview question.
1  = routine, purely local, celebrity/sport/markets-ticker noise, or not debatable at all.

Also mark duplicates: if a headline covers the same event as an EARLIER-numbered headline,
set "duplicate_of" to that number; otherwise omit the field.

Return ONLY a JSON array: [{{"index": 0, "score": 7}}, {{"index": 1, "score": 4, "duplicate_of": 0}}]

Headlines:
{chr(10).join(lines)}
"""
    result = client.generate_json(prompt, label="curation")
    if not isinstance(result, list):
        log("  Curation unavailable — using heuristic ranking only")
        return
    dupes = 0
    scored = 0
    for item in result:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index"))
            story = flat[idx]
        except (TypeError, ValueError, IndexError):
            continue
        dup = item.get("duplicate_of")
        if dup is not None:
            try:
                if int(dup) != idx:
                    story.score = -1.0     # pushed out of the shortlist entirely
                    story.ai_score = 0.0
                    dupes += 1
                    continue
            except (TypeError, ValueError):
                pass
        try:
            ai_score = float(item.get("score"))
        except (TypeError, ValueError):
            continue
        story.ai_score = max(0.0, min(10.0, ai_score))
        # Blend: heuristics know about source weight and multi-source coverage,
        # the model knows what a GD topic looks like.
        story.score = 0.4 * story.base_score + 0.6 * (story.ai_score * 0.8)
        scored += 1
    # Duplicates and low scorers drop to the bottom, then each list is re-sorted.
    for key in shortlist:
        shortlist[key] = [s for s in sorted(shortlist[key], key=lambda x: x.score, reverse=True)
                          if s.score >= 0]
    log(f"  Curation done: {scored} stories scored, {dupes} duplicates dropped")


def story_block(stories: list[Story], with_category: bool = False) -> str:
    lines = []
    for i, s in enumerate(stories):
        tag = f" [{s.category}]" if with_category else ""
        lines.append(f"[{i}]{tag} {s.title} (Source: {s.source})")
        if s.context:
            lines.append(f"    Details: {s.context[:450]}")
    return "\n".join(lines)


def enrich_batch(client: GeminiClient, stories: list[Story], label: str) -> int:
    if not stories:
        return 0
    prompt = f"""You are a coach preparing an Indian MBA student for placement group discussions (GDs) and interviews.
Today's date: {datetime.now(IST).strftime('%d %B %Y')}.

For EACH story below, write:
- "summary": 2-3 short sentences in simple English explaining what happened. Use ONLY the
  information given. Never invent numbers, dates or names.
- "why_it_matters": 1-2 sentences, with an India angle where relevant.
- "gd_for": exactly 2 short points supporting the development / the "pro" side.
- "gd_against": exactly 2 short points opposing it, or alternative perspectives / risks.
- "key_fact": ONE quotable fact or number taken from the story text above. If the story text
  contains no usable number, give a well-known background statistic and START the string with
  "Context: " so the student knows to verify it.

Return ONLY a JSON array with one object per story, in the same order, each with an "index"
field matching the story number.

Stories:
{story_block(stories, with_category=True)}
"""
    result = client.generate_json(prompt, label=label)
    if not isinstance(result, list):
        log(f"  {label}: enrichment unavailable, keeping RSS text")
        return 0
    by_index: dict[int, dict] = {}
    for item in result:
        if isinstance(item, dict) and "index" in item:
            try:
                by_index[int(item["index"])] = item
            except (TypeError, ValueError):
                pass
    done = 0
    for i, s in enumerate(stories):
        item = by_index.get(i) if by_index else (result[i] if i < len(result) and isinstance(result[i], dict) else None)
        if not item:
            continue
        summary = str(item.get("summary", "")).strip()
        if not summary:
            continue
        s.summary = summary
        s.why_it_matters = str(item.get("why_it_matters", "")).strip()
        s.gd_for = [str(x).strip() for x in item.get("gd_for", []) if str(x).strip()][:2]
        s.gd_against = [str(x).strip() for x in item.get("gd_against", []) if str(x).strip()][:2]
        s.key_fact = str(item.get("key_fact", "")).strip()
        s.ai = True
        done += 1
    log(f"  {label}: {done}/{len(stories)} stories enriched")
    return done


def enrich_all(client: GeminiClient, stories: list[Story]) -> None:
    """Enrich every chosen story in batches, then one retry pass for the gaps."""
    batches = [stories[i:i + ENRICH_BATCH_SIZE] for i in range(0, len(stories), ENRICH_BATCH_SIZE)]
    for n, batch in enumerate(batches, 1):
        if client.stopped:
            break
        enrich_batch(client, batch, f"batch {n}/{len(batches)}")
    missing = [s for s in stories if not s.ai]
    if missing and not client.stopped and client.budget_left > 60:
        log(f"  Retrying {len(missing)} story(ies) that came back empty")
        enrich_batch(client, missing[:ENRICH_BATCH_SIZE], "retry")


def generate_topic_and_concept(client: GeminiClient, all_stories: list[Story], recent_concepts: list[str]):
    headlines = "\n".join(f"- {s.title} ({s.source})" for s in all_stories)
    avoid = ", ".join(recent_concepts) if recent_concepts else "none"
    prompt = f"""You are a coach preparing an Indian MBA student for placement group discussions (GDs).
Today's date: {datetime.now(IST).strftime('%d %B %Y')}.

Today's headlines:
{headlines}

Task 1 — Pick the ONE topic from these headlines most likely to be given as a GD topic in Indian
B-school placements. It must be debatable, big-picture and relevant to an Indian audience; prefer
policy, economy, technology-and-society or India-facing global stories over routine corporate news.
Provide:
- "topic": the GD topic phrased as B-schools phrase it (a statement or question, under 15 words)
- "why_now": 1-2 sentences on why this is topical
- "opening_line": a confident 2-sentence opening a student can say to start the GD (frame the topic, give one fact)
- "closing_line": a strong 2-sentence closing that summarises and takes a balanced stand
- "perspectives": 3 short bullet points giving different stakeholder perspectives (government, industry, citizens, global)

Task 2 — "Concept of the Day": pick one business / economics / strategy / finance concept that helps
in GDs and interviews, ideally connected to today's news. Do NOT use these recently covered
concepts: {avoid}. Provide:
- "name": concept name
- "explanation": 3-4 simple sentences explaining it as if to a smart friend
- "indian_example": a concrete Indian company, policy or market example (2-3 sentences)
- "use_in_gd": 1-2 sentences on how to drop this concept into a GD or interview answer

Return ONLY JSON: {{"gd_topic": {{...}}, "concept": {{...}}}}
"""
    result = client.generate_json(prompt, label="topic+concept")
    if not isinstance(result, dict):
        return None, None
    topic = result.get("gd_topic") if isinstance(result.get("gd_topic"), dict) else None
    concept = result.get("concept") if isinstance(result.get("concept"), dict) else None
    return topic, concept


# ---------------------------------------------------------------------------
# Fallbacks (used when Gemini is off or out of budget)
# ---------------------------------------------------------------------------


def apply_fallbacks(stories: list[Story]) -> None:
    for s in stories:
        if not s.summary:
            s.summary = s.snippet or s.description or "Open the source link to read the full story."
            s.ai = False


def fallback_topic(all_stories: list[Story]) -> dict:
    """Pick an India-relevant, debatable story when the AI topic is unavailable."""
    preferred = ("india", "economy", "geopolitics", "technology")

    def rank(s: Story):
        india = bool(INDIA_RE.search(s.title))
        pref = len(preferred) - preferred.index(s.category) if s.category in preferred else 0
        return (india, pref, s.cluster_size, s.score)

    pool = [s for s in all_stories if s.category in preferred] or all_stories
    top = max(pool, key=rank, default=None)
    title = top.title if top else "Today's biggest headline"
    return {
        "topic": title,
        "why_now": (
            "Chosen automatically from today's most-covered India-relevant stories, because AI "
            "commentary was unavailable for this brief."
        ),
        "opening_line": (
            "Let me frame the discussion. This issue matters because it affects policy, industry "
            "and ordinary citizens at the same time, so it is worth separating the short-term "
            "impact from the long-term implications before we take sides."
        ),
        "closing_line": (
            "To sum up, the group has surfaced both the opportunities and the risks. A balanced "
            "view would be to support the direction while insisting on safeguards, clear timelines "
            "and accountability."
        ),
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
    merged = {e["date"]: e for e in entries if isinstance(e, dict) and e.get("date")}
    ordered = sorted(merged.values(), key=lambda e: e["date"], reverse=True)
    (ARCHIVE_DIR / "index.json").write_text(
        json.dumps(ordered, indent=2, ensure_ascii=False), encoding="utf-8"
    )


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
# Output
# ---------------------------------------------------------------------------


def build_payload(
    today: datetime,
    selected: dict[str, list[Story]],
    chosen_all: list[Story],
    topic: dict | None,
    concept: dict | None,
    client: GeminiClient,
    ok_sources: list[str],
    failed_sources: list[str],
) -> dict:
    ai_stories = sum(1 for s in chosen_all if s.ai)
    brief = {
        "date": today.strftime("%Y-%m-%d"),
        "date_label": today.strftime("%A, %d %B %Y"),
        "generated_at": today.isoformat(),
        "ai_enabled": client.enabled,
        "ai_model": client.model_used,
        "ai_story_count": ai_stories,
        "ai_errors": sorted(set(client.errors))[:10],
        "story_count": len(chosen_all),
        "story_cap": MAX_STORIES_PER_DAY,
        "gd_topic": topic,
        "concept": concept,
        "categories": [
            {
                "key": c["key"],
                "title": c["title"],
                "stories": [s.to_json() for s in selected.get(c["key"], [])],
            }
            for c in CATEGORIES
        ],
        "sources_ok": ok_sources,
        "sources_failed": failed_sources,
    }
    brief["reading_time_min"] = reading_time_minutes(brief)
    return brief


def write_files(brief: dict) -> None:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(brief, indent=2, ensure_ascii=False)
    (DATA_DIR / "latest.json").write_text(payload, encoding="utf-8")
    (ARCHIVE_DIR / f"{brief['date']}.json").write_text(payload, encoding="utf-8")
    index = load_index()
    index.append(
        {
            "date": brief["date"],
            "label": brief["date_label"],
            "gd_topic": (brief.get("gd_topic") or {}).get("topic", ""),
            "concept": (brief.get("concept") or {}).get("name", ""),
            "story_count": brief["story_count"],
            "ai": bool(brief["ai_enabled"] and brief["ai_story_count"]),
        }
    )
    save_index(index)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    started = time.time()
    today = datetime.now(IST)
    date_str = today.strftime("%Y-%m-%d")
    now_utc = datetime.now(timezone.utc)
    log(f"Daily GD Brief — building for {date_str} ({today.strftime('%A, %d %B %Y %H:%M IST')})")
    log(f"Budget: max {MAX_STORIES_PER_DAY} stories, AI phase capped at {AI_DEADLINE_SECONDS}s")

    log("\n1) Fetching feeds")
    by_cat, ok_sources, failed_sources = fetch_all()

    log("\n2) Ranking and deduplicating")
    previous = recent_titles(CROSS_DAY_LOOKBACK, date_str)
    log(f"  {len(previous)} headlines from the last {CROSS_DAY_LOOKBACK} brief(s) will not repeat")
    ranked = {c["key"]: rank_category(by_cat[c["key"]], now_utc) for c in CATEGORIES}
    shortlist = build_shortlist(ranked, previous)
    for c in CATEGORIES:
        log(f"  {c['title']:42} {len(by_cat[c['key']]):3} candidates -> {len(shortlist[c['key']])} shortlisted")

    client = GeminiClient(os.environ.get("GEMINI_API_KEY", "").strip() or None)

    if client.enabled:
        log("\n3) Curating the shortlist with Gemini")
        curate(client, shortlist)
    else:
        log("\n3) Gemini disabled (no GEMINI_API_KEY or SKIP_AI=1) — heuristic ranking only")

    selected = allocate(shortlist)
    chosen_all = [s for c in CATEGORIES for s in selected.get(c["key"], [])]
    if not chosen_all:
        log("\nNo stories fetched at all. Keeping the previous brief untouched.")
        return 1
    log(f"  Final selection: {len(chosen_all)} stories "
        + ", ".join(f"{c['key']}={len(selected[c['key']])}" for c in CATEGORIES))

    log("\n4) Resolving Google News links and fetching article snippets")
    gnews_stories = [s for s in chosen_all if s.via_gnews]
    if gnews_stories:
        with cf.ThreadPoolExecutor(max_workers=6) as ex:
            for s, url in zip(gnews_stories, ex.map(lambda x: decode_gnews_link(x.url), gnews_stories)):
                if safe_url(url):
                    s.url = url
    log(f"  {len(gnews_stories)} Google News link(s) resolved; "
        f"{add_snippets(chosen_all)} article snippet(s) fetched")

    # --- publish early: a valid brief exists before any slow AI work --------
    log("\n5) Writing a first version (so a timeout still publishes something)")
    for stories in selected.values():
        apply_fallbacks(stories)
    brief = build_payload(today, selected, chosen_all, fallback_topic(chosen_all), None,
                          client, ok_sources, failed_sources)
    write_files(brief)
    log("  data/latest.json written (headlines + RSS text)")

    topic = concept = None
    if client.enabled:
        log("\n6) Writing the GD topic and concept of the day")
        recent_concepts = [e.get("concept") for e in load_index()[:14] if e.get("concept")]
        topic, concept = generate_topic_and_concept(client, chosen_all, recent_concepts)
        if topic:
            log(f"  Topic: {topic.get('topic', '')[:90]}")
        else:
            log("  GD topic unavailable — keeping the automatic fallback")

        log("\n7) Writing story commentary")
        enrich_all(client, chosen_all)

    for stories in selected.values():
        apply_fallbacks(stories)
    if not topic:
        topic = fallback_topic(chosen_all)

    log("\n8) Writing final files")
    brief = build_payload(today, selected, chosen_all, topic, concept,
                          client, ok_sources, failed_sources)
    write_files(brief)

    ai_stories = brief["ai_story_count"]
    log(f"  data/latest.json and data/archive/{date_str}.json written")
    log(f"\nDone in {time.time() - started:.0f}s — {len(chosen_all)} stories "
        f"(cap {MAX_STORIES_PER_DAY}), {ai_stories} with AI commentary, "
        f"{client.calls} Gemini call(s), reading time ~{brief['reading_time_min']} min, "
        f"{len(failed_sources)} feed(s) failed.")
    if brief["ai_errors"]:
        log("  AI notes: " + "; ".join(brief["ai_errors"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
