"""기상청 예보·관측 수집(scripts/collect_kma.py) 검사. 실제 기상청에는 연결하지 않는다."""
import csv
import datetime
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import collect_kma as kma  # noqa: E402

NOW = datetime.datetime(2026, 11, 11, 5, 30)


def forecast_items(issued, hours=(1, 2, 3), **override):
    items = []
    for lead in hours:
        t = issued + datetime.timedelta(hours=lead)
        values = {"TMP": "6", "POP": "20", "PTY": "0", "SKY": "3", "WSD": "0.4", "PCP": "강수없음", "REH": "85"}
        values.update(override)
        for category, value in values.items():
            items.append({"category": category, "fcstDate": t.strftime("%Y%m%d"), "fcstTime": t.strftime("%H%M"), "fcstValue": value})
    return items


def observed_items(**override):
    values = {"T1H": "6.6", "RN1": "0", "PTY": "0", "WSD": "0.2", "REH": "79"}
    values.update(override)
    return [{"category": c, "obsrValue": v} for c, v in values.items()]


def read(path):
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


class Times(unittest.TestCase):
    def test_release_times_cover_window(self):
        times = kma.release_times(NOW)
        self.assertEqual(times[-1], datetime.datetime(2026, 11, 11, 5, 0))
        self.assertEqual(times[0], datetime.datetime(2026, 11, 8, 14, 0))   # 66시간 전(11:30) 이후 첫 발표
        self.assertTrue(all(t.hour in kma.ISSUE_HOURS for t in times))
        self.assertEqual(times, sorted(times))

    def test_release_waits_until_ready(self):
        times = kma.release_times(datetime.datetime(2026, 11, 11, 5, 10))
        self.assertEqual(times[-1], datetime.datetime(2026, 11, 11, 2, 0))

    def test_nowcast_times(self):
        times = kma.nowcast_times(NOW)                                   # 05:30 발표분은 05:45부터 요청한다
        self.assertEqual(times[-1], datetime.datetime(2026, 11, 11, 4, 30))
        self.assertEqual(len(times), kma.OBSERVED_KEEP_HOURS)
        self.assertEqual(kma.nowcast_times(datetime.datetime(2026, 11, 11, 5, 50))[-1], datetime.datetime(2026, 11, 11, 5, 30))

    def test_observation_times(self):
        hours = kma.observation_times(NOW)
        self.assertEqual(len(hours), kma.OBSERVED_KEEP_HOURS)
        self.assertEqual(hours[-1], datetime.datetime(2026, 11, 11, 5, 0))
        self.assertEqual(hours[0], datetime.datetime(2026, 11, 10, 7, 0))


class Parse(unittest.TestCase):
    def test_forecast_rows_and_lead(self):
        issued = datetime.datetime(2026, 11, 10, 23, 0)
        rows, notes = kma.parse_forecast(forecast_items(issued, hours=(1, 27)), issued)
        self.assertEqual(notes, [])
        self.assertEqual(rows[0], ["2026-11-10T23:00", "2026-11-11T00:00", "1", "6", "20", "0", "3", "0.4", "강수없음"])
        self.assertEqual(rows[1][1:3], ["2026-11-12T02:00", "27"])

    def test_nowcast_uses_its_own_categories(self):
        issued = datetime.datetime(2026, 11, 11, 5, 30)
        t = "0600"
        items = [{"category": c, "fcstDate": "20261111", "fcstTime": t, "fcstValue": v}
                 for c, v in {"T1H": "5", "RN1": "강수없음", "PTY": "0", "SKY": "1", "WSD": "1", "POP": "0", "LGT": "0"}.items()]
        rows, notes = kma.parse_forecast(items, issued, "T1H", "RN1")
        self.assertEqual((rows, notes), ([["2026-11-11T05:30", "2026-11-11T06:00", "0.5", "5", "0", "0", "1", "1", "강수없음"]], []))

    def test_forecast_skips_broken_items_and_missing_temp(self):
        issued = datetime.datetime(2026, 11, 11, 2, 0)
        items = forecast_items(issued, hours=(1,)) + forecast_items(issued, hours=(2,), TMP="-999")
        items += [{"category": "TMP"}, {"category": "TMN", "fcstDate": "20261112", "fcstTime": "0600", "fcstValue": "3.0"}]
        rows, notes = kma.parse_forecast(items, issued)
        self.assertEqual(len(rows), 1)
        self.assertEqual(notes, ["형식이 잘못된 항목 1개 건너뜀", "기온이 없는 대상 시각 1개 건너뜀"])

    def test_observation_rained(self):
        at = datetime.datetime(2026, 11, 11, 3, 0)
        self.assertEqual(kma.parse_observation(observed_items(), at), ["2026-11-11T03:00", "6.6", "0", "0", "0.2", "0"])
        self.assertEqual(kma.parse_observation(observed_items(RN1="1.5", PTY="1"), at)[-1], "1")
        self.assertEqual(kma.parse_observation(observed_items(RN1="0", PTY="3"), at)[-1], "1")      # 눈이 쌓이지 않아도 내린 것
        self.assertEqual(kma.parse_observation(observed_items(RN1="-998.9", PTY="-999"), at)[-1], "")  # 알 수 없음
        self.assertIsNone(kma.parse_observation(observed_items(T1H="-998.9"), at))
        self.assertIsNone(kma.parse_observation([{"wrong": 1}], at))


class Collect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def fake(self, bad=None):
        bad = bad or {}

        def fetch(function, base, key):
            self.calls.append((function, base))
            if (function, base) in bad:
                return bad[(function, base)]
            if function == "getVilageFcst":
                return forecast_items(base), "00", ""
            if function == "getUltraSrtFcst":
                items = forecast_items(base.replace(minute=0), hours=range(1, 7), RN1="강수없음")
                return [dict(it, category="T1H") if it["category"] == "TMP" else it for it in items], "00", ""
            return observed_items(), "00", ""
        return fetch

    def test_fills_everything_then_nothing(self):
        s = kma.collect(NOW, "k", self.root, self.fake())
        self.assertEqual(s["releases"], len(kma.release_times(NOW)))
        self.assertEqual(s["observed"], kma.OBSERVED_KEEP_HOURS)
        self.assertEqual(s["failed"], 0)
        self.assertFalse((self.root / "data/kma/collect_log.csv").exists())
        rows = read(self.root / "data/kma/forecast/2026-11.csv")
        self.assertEqual(list(rows[0]), kma.FORECAST_COLUMNS)
        self.assertEqual(len(rows), s["forecast"])
        self.assertEqual(list(read(self.root / "data/kma/observed/2026-11.csv")[0]), kma.OBSERVED_COLUMNS)
        nowcast = read(self.root / "data/kma/nowcast/2026-11.csv")
        self.assertEqual(len(nowcast), kma.OBSERVED_KEEP_HOURS * 6)
        self.assertEqual((nowcast[0]["lead_hours"], nowcast[0]["precip_text"]), ("0.5", "강수없음"))
        # 다시 실행하면 요청도 행도 늘지 않는다
        self.calls.clear()
        again = kma.collect(NOW, "k", self.root, self.fake())
        self.assertEqual((again["requests"], self.calls), (0, []))
        self.assertEqual(len(read(self.root / "data/kma/forecast/2026-11.csv")), len(rows))

    def test_next_run_adds_only_new(self):
        kma.collect(NOW, "k", self.root, self.fake())
        self.calls.clear()
        s = kma.collect(NOW + datetime.timedelta(hours=6), "k", self.root, self.fake())
        self.assertEqual((s["releases"], s["observed"], s["nowcast"]), (2, 6, 36))   # 08시·11시 발표분, 관측 6시간, 초단기예보 6회

    def test_same_target_gets_several_leads(self):
        kma.collect(NOW, "k", self.root, self.fake())
        fake = lambda function, base, key: (forecast_items(base, hours=range(1, 40)), "00", "") if function == "getVilageFcst" else (observed_items(), "00", "")
        root2 = self.root / "second"
        kma.collect(NOW, "k", root2, fake)
        rows = [r for r in read(root2 / "data/kma/forecast/2026-11.csv") if r["target_at"] == "2026-11-11T06:00"]
        leads = sorted(int(r["lead_hours"]) for r in rows)
        self.assertEqual(leads[0], 1)
        self.assertIn(31, leads)
        self.assertGreater(len(leads), 8)

    def test_failures_are_skipped_and_logged(self):
        old_release = datetime.datetime(2026, 11, 10, 2, 0)
        old_hour = datetime.datetime(2026, 11, 10, 20, 0)
        new_hour = datetime.datetime(2026, 11, 11, 5, 0)
        bad = {
            ("getVilageFcst", old_release): (None, "형식", "응답 형식 오류"),
            ("getUltraSrtNcst", old_hour): (None, "03", "NO_DATA"),
            ("getUltraSrtNcst", new_hour): (None, "03", "NO_DATA"),   # 방금 지난 시각은 기록하지 않는다
        }
        s = kma.collect(NOW, "k", self.root, self.fake(bad))
        self.assertEqual(s["failed"], 2)
        log = read(self.root / "data/kma/collect_log.csv")
        self.assertEqual([(r["kind"], r["base_at"], r["note"]) for r in log],
                         [("forecast", "2026-11-10T02:00", "응답 형식 오류"), ("observed", "2026-11-10T20:00", "NO_DATA")])
        issued = {r["issued_at"] for r in read(self.root / "data/kma/forecast/2026-11.csv")}
        self.assertNotIn("2026-11-10T02:00", issued)
        # 다음 실행에서 빠진 것만 다시 요청해 채운다
        self.calls.clear()
        s = kma.collect(NOW, "k", self.root, self.fake())
        self.assertEqual((s["releases"], s["observed"]), (1, 2))

    def test_month_boundary(self):
        now = datetime.datetime(2026, 12, 1, 5, 30)
        kma.collect(now, "k", self.root, self.fake())
        self.assertTrue((self.root / "data/kma/forecast/2026-11.csv").exists())
        self.assertTrue((self.root / "data/kma/forecast/2026-12.csv").exists())
        self.calls.clear()
        self.assertEqual(kma.collect(now, "k", self.root, self.fake())["requests"], 0)


class Fetch(unittest.TestCase):
    def run_with(self, body=None, error=None):
        class Reply:
            def read(self):
                return body

        def urlopen(url, timeout=0):
            if error:
                raise error
            return Reply()
        original = kma.urllib.request.urlopen
        kma.urllib.request.urlopen = urlopen
        try:
            return kma.fetch("getVilageFcst", NOW, "SECRET-KEY")
        finally:
            kma.urllib.request.urlopen = original

    def test_bad_shapes(self):
        self.assertEqual(self.run_with(b"<html>error</html>")[1:], ("형식", "응답 형식 오류"))
        self.assertEqual(self.run_with(b'{"response": {"header": {"resultCode": "00"}, "body": {"items": ""}}}')[1], "형식")
        items, code, message = self.run_with('{"response": {"header": {"resultCode": "03", "resultMsg": "NO_DATA"}}}'.encode())
        self.assertEqual((items, code, message), (None, "03", "NO_DATA"))

    def test_error_never_carries_key(self):
        items, code, message = self.run_with(error=OSError("failed https://x?authKey=SECRET-KEY"))
        self.assertIsNone(items)
        self.assertNotIn("SECRET-KEY", message)


class OpenMeteo(unittest.TestCase):
    """Open-Meteo 예보 수집(scripts/collect_open_meteo.py)"""

    def setUp(self):
        import collect_open_meteo
        self.om = collect_open_meteo
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def hourly(self, hours=120, **override):
        start = datetime.datetime(2026, 11, 11, 0, 0)
        data = {"time": [(start + datetime.timedelta(hours=i)).strftime(kma.STAMP) for i in range(hours)]}
        defaults = {"temperature_2m": 8.7, "precipitation_probability": 30, "precipitation": 0.0, "weather_code": 3, "wind_speed_10m": 1.51}
        for field in self.om.FIELDS:
            for model in self.om.MODELS:
                data[f"{field}_{model}"] = [override.get(field, defaults[field])] * hours
        data.update({name: [value] * hours for name, value in override.items() if name not in defaults})
        return data

    def test_rows_start_after_now_and_stop_at_96_hours(self):
        s = self.om.collect(NOW, self.root, lambda: (self.hourly(), ""))
        rows = read(self.root / "data/open-meteo/forecast/2026-11.csv")
        self.assertEqual(s, {"rows": 96 * len(self.om.MODELS), "failed": 0, "logs": 0})
        self.assertEqual(list(rows[0]), self.om.COLUMNS)
        self.assertEqual(list(rows[0].values()), ["2026-11-11T05:00", "2026-11-11T06:00", "1", "best_match", "8.7", "30", "0", "3", "1.5"])
        self.assertEqual({r["model"] for r in rows}, set(self.om.MODELS))
        self.assertEqual((rows[-1]["target_at"], rows[-1]["lead_hours"]), ("2026-11-15T05:00", "96"))

    def test_same_hour_is_not_fetched_twice(self):
        calls = []

        def fetch():
            calls.append(1)
            return self.hourly(), ""
        self.om.collect(NOW, self.root, fetch)
        self.om.collect(NOW + datetime.timedelta(minutes=20), self.root, fetch)
        self.assertEqual(len(calls), 1)
        self.om.collect(NOW + datetime.timedelta(hours=6), self.root, fetch)
        self.assertEqual(len(calls), 2)
        leads = [r["lead_hours"] for r in read(self.root / "data/open-meteo/forecast/2026-11.csv") if r["target_at"] == "2026-11-11T12:00" and r["model"] == "best_match"]
        self.assertEqual(leads, ["7", "1"])

    def test_missing_probability_stays_blank(self):
        self.om.collect(NOW, self.root, lambda: (self.hourly(precipitation_probability=None), ""))
        self.assertEqual(read(self.root / "data/open-meteo/forecast/2026-11.csv")[0]["pop_pct"], "")

    def test_model_without_temperature_is_skipped_and_logged(self):
        s = self.om.collect(NOW, self.root, lambda: (self.hourly(temperature_2m_jma_seamless=None), ""))
        rows = read(self.root / "data/open-meteo/forecast/2026-11.csv")
        self.assertEqual(s["rows"], 96 * (len(self.om.MODELS) - 1))
        self.assertNotIn("jma_seamless", {r["model"] for r in rows})
        self.assertEqual(s["logs"], 1)

    def test_failure_is_logged(self):
        s = self.om.collect(NOW, self.root, lambda: (None, "응답 형식 오류"))
        self.assertEqual(s["failed"], 1)
        self.assertFalse((self.root / "data/open-meteo/forecast/2026-11.csv").exists())
        self.assertEqual(read(self.root / "data/open-meteo/collect_log.csv")[0]["note"], "응답 형식 오류")
        s = self.om.collect(NOW, self.root, lambda: (self.hourly(temperature_2m=None), ""))
        self.assertEqual((s["rows"], s["failed"]), (0, 1))

    def test_fetch_rejects_bad_shape(self):
        class Reply:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body
        original = self.om.urllib.request.urlopen
        try:
            self.om.urllib.request.urlopen = lambda url, timeout=0: Reply(b"<html>")
            self.assertEqual(self.om.fetch(), (None, "응답 형식 오류"))
            self.om.urllib.request.urlopen = lambda url, timeout=0: Reply(b'{"hourly": {"time": ["2026-11-11T00:00"], "temperature_2m_best_match": []}}')
            self.assertEqual(self.om.fetch(), (None, "응답 형식 오류"))
        finally:
            self.om.urllib.request.urlopen = original


if __name__ == "__main__":
    unittest.main()
