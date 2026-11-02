"""Network-free regression coverage for publication checks and news moderation."""
from contextlib import redirect_stdout
import datetime
import email.utils
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
import build_projects as builder
import check_projects as checker
import fetch_news as collector
from news_policy import KST, apply_news_policy, expires_at


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def project(**changes):
    return {"id": "demo", "title": "Demo", "summary": "Demo", "maker": "Demo",
            "url": "https://demo.example/", "target": "wide",
            "teacher": "approved", "makerConfirmed": True, **changes}


def result(**changes):
    return {"id": "demo", "url": "https://demo.example/", "status": "ok", "target": "wide",
            "checkedAt": checker.now_iso(), "fingerprint": "test",
            "frame": {"allowed": True}, "shots": {"wide": {"ok": True}}, **changes}


class CheckerTests(unittest.TestCase):
    def test_frame_restrictions_are_case_insensitive(self):
        for name, value in (("X-Frame-Options", "DENY"),
                            ("Content-Security-Policy", "frame-ancestors 'none'")):
            for spelling in (name, name.lower(), name.upper()):
                with self.subTest(header=spelling):
                    self.assertFalse(checker.frame_policy("https://external.example/", {spelling: value})[0])

    def test_csp_still_takes_precedence_over_xfo(self):
        headers = {"content-security-policy": "frame-ancestors https://greatsong.github.io", "x-frame-options": "DENY"}
        self.assertTrue(checker.frame_policy("https://external.example/", headers)[0])

    def test_cache_changes_when_target_changes_or_is_missing(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(checker, "OUT", Path(temporary)):
            check_file = checker.OUT / "demo" / "check.json"
            save(check_file, result())
            self.assertFalse(checker.needs_check(project(), 20, False))
            self.assertTrue(checker.needs_check(project(target="both"), 20, False))
            legacy = result()
            legacy.pop("target")
            save(check_file, legacy)
            self.assertTrue(checker.needs_check(project(), 20, False))

    def test_capture_records_the_checked_target(self):
        headers = {"http": 200, "finalUrl": "https://demo.example/", "headers": {}, "fingerprint": "test", "ms": 0}
        def capture(browser, url, kind, destination):
            return {"ok": kind == "mobile", "image": None, "errors": [] if kind == "mobile" else ["blank desktop"]}
        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.object(checker, "OUT", Path(temporary)), \
                mock.patch.object(checker, "fetch_headers", return_value=headers), \
                mock.patch.object(checker, "capture", side_effect=capture):
            checked = checker.check(None, project(target="mobile"))
            self.assertEqual(checked["target"], "mobile")
            self.assertEqual(checked["status"], "ok")
            self.assertFalse(checked["shots"]["wide"]["ok"])
            self.assertTrue(checker.needs_check(project(target="wide"), 20, False))


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.root = root
        paths = {"ROOT": root, "SITE": root / "site", "REG": root / "projects" / "registry.json",
                 "CONTROL": root / "projects" / "control.json", "NEWS": root / "projects" / "news.json",
                 "NEWS_CONTROL": root / "projects" / "news-control.json", "SCHEDULE": root / "projects" / "schedule.json",
                 "SCHEDULE_EXTRA": root / "projects" / "schedule-extra.json",
                 "ASSIGNED": root / "projects" / "assigned.json", "CONTENT": root / "site" / "content.json",
                 "INDEX": root / "site" / "projects" / "index.json"}
        patcher = mock.patch.multiple(builder, **paths)
        patcher.start()
        self.addCleanup(patcher.stop)
        save(builder.CONTENT, {"version": 1})
        save(builder.REG, {"projects": [project()]})
        self.check_file = builder.SITE / "projects" / "demo" / "check.json"
        save(self.check_file, result())

    def build(self):
        with redirect_stdout(io.StringIO()):
            builder.main()
        return json.loads(builder.CONTENT.read_text(encoding="utf-8"))

    def test_teacher_events_join_the_neis_schedule_in_date_order(self):
        save(builder.SCHEDULE, {"events": [{"name": "기말고사", "start": "2099-11-23", "end": "2099-11-27", "grades": "3학년", "holiday": False}]})
        save(builder.SCHEDULE_EXTRA, {"events": [
            {"name": "AI·SW교육의 날", "start": "2099-11-11", "end": "2099-11-12"},
            {"name": "끝난 행사", "start": "2000-01-01", "end": "2000-01-01"},
            {"name": "  ", "start": "2099-11-13", "end": "2099-11-13"},
            {"name": "날짜 틀림", "start": "2099-13-01"},
            {"name": "거꾸로", "start": "2099-11-20", "end": "2099-11-19"},
        ]})
        schedule = self.build()["schedule"]
        self.assertEqual([e["name"] for e in schedule], ["AI·SW교육의 날", "기말고사"])
        self.assertEqual(schedule[0], {"name": "AI·SW교육의 날", "start": "2099-11-11", "end": "2099-11-12", "grades": "", "holiday": False})

    def test_target_mismatch_is_unchecked(self):
        save(self.check_file, result(target="mobile"))
        self.assertEqual(self.build()["projects"], [])
        review = json.loads(builder.INDEX.read_text(encoding="utf-8"))["projects"][0]
        self.assertEqual(review["status"], "unchecked")

    def test_legacy_mobile_success_cannot_publish_failed_wide_capture(self):
        old = result(shots={"wide": {"ok": False}, "mobile": {"ok": True}})
        old.pop("target")
        save(self.check_file, old)
        self.assertEqual(self.build()["projects"], [])
        review = json.loads(builder.INDEX.read_text(encoding="utf-8"))["projects"][0]
        self.assertEqual(review["status"], "fail")

    def test_hidden_project_and_its_short_address_stay_removed(self):
        self.assertEqual(len(self.build()["projects"]), 1)
        self.assertTrue((builder.SITE / "p" / "1" / "index.html").exists())
        save(builder.REG, {"projects": [project(teacher="hidden")]})
        self.assertEqual(self.build()["projects"], [])
        self.assertFalse((builder.SITE / "p" / "1").exists())
        self.assertEqual(self.build()["projects"], [])

    def test_current_approved_fixtures_keep_publishing(self):
        for name in ("registry.json", "assigned.json", "control.json", "news.json", "schedule.json"):
            save(self.root / "projects" / name, json.loads((REPO / "projects" / name).read_text(encoding="utf-8")))
        registered = json.loads(builder.REG.read_text(encoding="utf-8"))["projects"]
        for entry in registered:
            relative = Path("site") / "projects" / entry["id"] / "check.json"
            save(self.root / relative, json.loads((REPO / relative).read_text(encoding="utf-8")))
        published = {entry["id"] for entry in self.build()["projects"]}
        self.assertEqual(published, {entry["id"] for entry in registered if entry["teacher"] == "approved" and entry["makerConfirmed"]})

    def test_news_moderation_and_expiry_survive_source_refresh(self):
        now = datetime.datetime.now(KST)
        fresh = {"id": "fresh", "title": "Source title", "summary": "Source summary",
                 "until": (now + datetime.timedelta(hours=1)).isoformat()}
        hidden = {**fresh, "id": "hidden"}
        stale = {**fresh, "id": "stale", "until": (now - datetime.timedelta(seconds=1)).isoformat()}
        controls = {"requestId": "manual-request", "updatedAt": now.isoformat(), "entries": {
            "fresh": {"hidden": False, "title": "Teacher title", "summary": "", "request": "manual wording"},
            "hidden": {"hidden": True}}}
        save(builder.NEWS_CONTROL, controls)
        for title in ("Source title", "Refetched title"):
            raw = {"items": [{**fresh, "title": title}, hidden, stale]}
            save(builder.NEWS, raw)
            content = self.build()
            self.assertEqual([item["id"] for item in content["news"]], ["fresh"])
            self.assertEqual(content["news"][0]["title"], "Teacher title")
            self.assertEqual(content["news"][0]["summary"], "")
            self.assertNotIn("request", content["news"][0])
            self.assertEqual(content["newsControlRequestId"], "manual-request")
            self.assertEqual(json.loads(builder.NEWS.read_text(encoding="utf-8")), raw)
            self.assertEqual(json.loads(builder.NEWS_CONTROL.read_text(encoding="utf-8")), controls)


class NewsTests(unittest.TestCase):
    def test_legacy_expiry_is_kst_midnight_plus_72_hours(self):
        item = {"id": "legacy", "date": "2026-10-28", "title": "Title"}
        expiry = datetime.datetime(2026, 10, 31, tzinfo=KST)
        self.assertEqual(expires_at(item), expiry)
        self.assertEqual(len(apply_news_policy([item], now=expiry - datetime.timedelta(seconds=1))), 1)
        self.assertEqual(apply_news_policy([item], now=expiry), [])

    def test_precise_until_accepts_z_timezone_and_drops_invalid_dates(self):
        item = {"id": "precise", "date": "2026-10-01", "until": "2026-10-31T00:00:00Z"}
        now = datetime.datetime(2026, 10, 31, 8, 59, 59, tzinfo=KST)
        self.assertEqual(len(apply_news_policy([item], now=now)), 1)
        self.assertEqual(apply_news_policy([item], now=now + datetime.timedelta(seconds=1)), [])
        self.assertEqual(apply_news_policy([{"id": "undated"}, {"date": "invalid"}], now=now), [])

    def test_request_text_does_not_generate_a_rewrite(self):
        item = {"id": "demo", "date": "2026-10-31", "title": "Source title", "summary": "Source summary"}
        controls = {"entries": {"demo": {"request": "Make up a replacement"}}}
        news = apply_news_policy([item], controls, now=datetime.datetime(2026, 10, 31, tzinfo=KST))
        self.assertEqual(news[0]["title"], item["title"])
        self.assertEqual(news[0]["summary"], item["summary"])
        self.assertNotIn("request", news[0])

    def test_collector_preserves_rss_time_in_expiry_without_network(self):
        published = datetime.datetime.now(KST).replace(microsecond=0) - datetime.timedelta(hours=1)
        rss = ("<rss><channel><item><title>GPT 모델 공개 벤치마크 성능 최고</title>"
               "<link>https://news.example/article</link><description>새로운 모델입니다.</description>"
               f"<pubDate>{email.utils.format_datetime(published)}</pubDate></item></channel></rss>")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "projects" / "news.json"
            output.parent.mkdir()
            with mock.patch.multiple(collector, ROOT=root, OUT=output, SOURCES=[("Test", "https://rss.example/")]), \
                    mock.patch.object(collector, "get", return_value=rss), redirect_stdout(io.StringIO()):
                collector.main(False)
            news = json.loads(output.read_text(encoding="utf-8"))["items"]
            self.assertEqual(len(news), 1)
            self.assertEqual(datetime.datetime.fromisoformat(news[0]["until"]), published + datetime.timedelta(hours=72))

    def test_collection_outage_does_not_keep_stale_news_visible(self):
        now = datetime.datetime.now(KST)
        stale = {"id": "stale", "title": "Old", "until": (now - datetime.timedelta(seconds=1)).isoformat()}
        raw = {"items": [stale]}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "news.json"
            save(output, raw)
            with mock.patch.object(collector, "OUT", output), \
                    mock.patch.object(collector, "SOURCES", [("Test", "https://rss.example/")]), \
                    mock.patch.object(collector, "get", side_effect=OSError("offline")), redirect_stdout(io.StringIO()):
                collector.main(False)
            retained = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(retained, raw)
            self.assertEqual(apply_news_policy(retained["items"], now=now), [])


if __name__ == "__main__":
    unittest.main()
