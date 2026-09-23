#!/usr/bin/env python3
"""Tests for build_brief.py. Run with:  python scripts/test_build_brief.py

No pytest needed — these run in the GitHub Actions job before the real build,
so a broken selection rule fails fast instead of producing a bad brief.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_brief as bb  # noqa: E402


def make(title: str, category: str = "economy", source: str = "The Hindu",
         score: float = 5.0, hours_old: float = 2.0) -> bb.Story:
    return bb.Story(
        title=title,
        url=f"https://example.com/{abs(hash(title))}",
        source=source,
        category=category,
        published=datetime.now(timezone.utc) - timedelta(hours=hours_old),
        description="",
        weight=3,
        score=score,
        base_score=score,
    )


class TestSimilar(unittest.TestCase):
    def test_catches_the_fta_duplicate(self):
        a = ("India-New Zealand FTA kicks in from October 20: Indian exporters get duty-free "
             "access from day one as both nations target Rs 35,000 crore trade by 2030")
        b = "India-New Zealand FTA ratified, to come into effect on October 20"
        self.assertTrue(bb.similar(a, b))

    def test_does_not_merge_unrelated_headlines(self):
        pairs = [
            ("RBI holds repo rate at 5.5% for the third straight meeting",
             "India-New Zealand FTA ratified, to come into effect on October 20"),
            ("Infosys announces Rs 18,000 crore share buyback",
             "TCS wins multi-year deal with European retailer"),
            ("Supreme Court reserves verdict on electoral bonds review",
             "Parliament passes new labour codes after long debate"),
        ]
        for a, b in pairs:
            self.assertFalse(bb.similar(a, b), f"wrongly merged: {a!r} / {b!r}")

    def test_empty_titles(self):
        self.assertFalse(bb.similar("", "anything at all here"))


class TestRepeats(unittest.TestCase):
    def test_repeat_is_skipped(self):
        previous = ["India-New Zealand FTA ratified, to come into effect on October 20"]
        story = make("India-New Zealand FTA ratified, to come into effect on October 20")
        self.assertTrue(bb.is_repeat(story, previous))

    def test_new_development_is_allowed_back(self):
        previous = ["Parliament debates the new labour codes for a second day"]
        story = make("Parliament passes the new labour codes after a second day of debate")
        self.assertFalse(bb.is_repeat(story, previous))

    def test_nothing_previous(self):
        self.assertFalse(bb.is_repeat(make("Anything happens somewhere today"), []))


class TestAllocate(unittest.TestCase):
    def build(self, per_cat: int = 10, score: float = 9.0):
        shortlist = {}
        for c in bb.CATEGORIES:
            shortlist[c["key"]] = [
                make(f"{c['key']} story number {i} about something", c["key"],
                     source=f"src{i}", score=score - i * 0.1)
                for i in range(per_cat)
            ]
        return shortlist

    def test_never_exceeds_the_daily_cap(self):
        chosen = bb.allocate(self.build())
        total = sum(len(v) for v in chosen.values())
        self.assertLessEqual(total, bb.MAX_STORIES_PER_DAY)

    def test_every_category_gets_its_minimum(self):
        chosen = bb.allocate(self.build())
        for key, stories in chosen.items():
            self.assertGreaterEqual(len(stories), bb.MIN_PER_CATEGORY, key)
            self.assertLessEqual(len(stories), bb.MAX_PER_CATEGORY, key)

    def test_weak_stories_do_not_win_bonus_slots(self):
        chosen = bb.allocate(self.build(score=bb.MIN_EXTRA_SCORE - 1))
        total = sum(len(v) for v in chosen.values())
        self.assertEqual(total, bb.MIN_PER_CATEGORY * len(bb.CATEGORIES))

    def test_one_publisher_cannot_flood_the_brief(self):
        shortlist = {}
        for c in bb.CATEGORIES:
            shortlist[c["key"]] = [
                make(f"{c['key']} story number {i} about something", c["key"],
                     source="Economic Times", score=9.0)
                for i in range(10)
            ]
        chosen = bb.allocate(shortlist)
        used = sum(1 for v in chosen.values() for s in v if s.source == "Economic Times")
        self.assertLessEqual(used, bb.MAX_PER_SOURCE_GLOBAL)

    def test_empty_category_is_handled(self):
        shortlist = self.build()
        shortlist[bb.CATEGORIES[0]["key"]] = []
        chosen = bb.allocate(shortlist)
        self.assertEqual(chosen[bb.CATEGORIES[0]["key"]], [])
        self.assertLessEqual(sum(len(v) for v in chosen.values()), bb.MAX_STORIES_PER_DAY)


class TestRelevance(unittest.TestCase):
    def test_phrases_match_as_phrases(self):
        strong = make("Repo rate cut expected as inflation falls to a four-year low", "economy")
        weak = make("Local club celebrates its silver jubilee with a small function", "economy")
        self.assertGreater(bb.relevance_score(strong), bb.relevance_score(weak))

    def test_pronoun_us_does_not_score(self):
        story = make("Tell us what you think about the weekend plans", "geopolitics")
        self.assertEqual(bb.relevance_score(story), 0.0)

    def test_india_bonus_in_global_categories(self):
        india = make("OpenAI opens its first India office in Bengaluru", "technology")
        other = make("OpenAI opens its first office in Dublin", "technology")
        self.assertGreater(bb.relevance_score(india), bb.relevance_score(other))


class TestFallbackTopic(unittest.TestCase):
    def test_prefers_an_india_relevant_story(self):
        stories = [
            make("US press bodies sue the White House over access rules", "geopolitics", score=9),
            make("India unveils new semiconductor policy with Rs 40,000 crore outlay", "economy", score=7),
        ]
        topic = bb.fallback_topic(stories)
        self.assertIn("India", topic["topic"])
        self.assertTrue(topic["fallback"])


class TestMisc(unittest.TestCase):
    def test_safe_url(self):
        self.assertTrue(bb.safe_url("https://example.com/a"))
        self.assertFalse(bb.safe_url("javascript:alert(1)"))
        self.assertFalse(bb.safe_url(""))

    def test_key_fact_context_flag(self):
        s = make("Some headline that is definitely long enough")
        s.key_fact = "Context: India's GDP is about $4 trillion."
        self.assertTrue(s.to_json()["fact_is_context"])
        s.key_fact = "Exports rose 12% in August."
        self.assertFalse(s.to_json()["fact_is_context"])

    def test_junk_filter_keeps_gd_worthy_sections(self):
        self.assertIsNone(bb.JUNK_URL.search("https://indianexpress.com/article/education/nep-2020/"))
        self.assertIsNone(bb.JUNK_URL.search("https://www.thehindu.com/news/cities/delhi-air/"))
        self.assertIsNotNone(bb.JUNK_URL.search("https://indianexpress.com/section/sports/ipl/"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
