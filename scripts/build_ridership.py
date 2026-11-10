"""하교 버스 카드의 시간대별 승차 인원(site/bus/ridership.json)을 만든다.

서울 열린데이터광장 「버스노선별 정류장별 시간대별 승하차 인원 정보」(OA-12913)의 가장 최근 월 파일을 받아
content.json 의 bus.stops 에 적힌 정류장·노선만 뽑는다. 월 합계를 그 달의 평일 수로 나눠 하루 평균으로 적는다
(주말 이용분이 섞여 있어 실제 평일 평균보다 조금 크다). 매월 5일쯤 전월 자료가 올라온다.
일별 자료(OA-12912, CardBusStatisticsServiceNew)의 인증키가 있으면 최근 한 달의 날짜별 승차 인원도 받아
평일만의 하루 평균과 요일별 평균을 구하고, 시간대별 값을 평일 평균에 맞춰 다시 계산한다(시간대 분포는 월 자료 그대로).
키는 환경변수 SEOUL_OPENAPI_KEY 또는 .local/seoul-openapi.env(저장소에 올라가지 않음)에서 읽는다. 키가 없으면 월 자료만 쓴다.
사용법: python3 scripts/build_ridership.py            (최근 월 파일을 받는다)
        python3 scripts/build_ridership.py 파일.csv   (받아 둔 파일을 사용한다)
"""
import datetime
import os
import statistics
import calendar
import csv
import io
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = "https://data.seoul.go.kr/dataList/OA-12913/F/1/datasetView.do"
DOWN = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false"
UA = {"User-Agent": "Mozilla/5.0 (school-signage ridership build)"}


def download():
    html = urllib.request.urlopen(urllib.request.Request(PAGE, headers=UA), timeout=40).read().decode("utf-8", "replace")
    seq = max(int(x) for x in re.findall(r"downloadFile\('(\d+)'\)", html))   # 번호가 가장 큰 것이 가장 최근 월
    body = urllib.parse.urlencode({"infId": "OA-12913", "seqNo": "", "seq": seq, "infSeq": "3"}).encode()
    req = urllib.request.Request(DOWN, data=body, headers={**UA, "Referer": PAGE})
    return urllib.request.urlopen(req, timeout=300).read()


def api_key():
    key = os.environ.get("SEOUL_OPENAPI_KEY", "")
    env = ROOT / ".local" / "seoul-openapi.env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("SEOUL_OPENAPI_KEY="):
                key = line.split("=", 1)[1].strip()
    return key


def daily_boardings(key, route, ars, today):
    """최근 33일(자료는 사흘 전까지 올라온다)의 날짜별 승차 인원 {date: 명}. 자료가 없는 날은 뺀다."""
    out = {}
    for back in range(3, 36):
        day = today - datetime.timedelta(days=back)
        url = (f"http://openapi.seoul.go.kr:8088/{key}/json/CardBusStatisticsServiceNew/1/100/"
               f"{day:%Y%m%d}/{urllib.parse.quote(route)}/")
        try:
            data = json.loads(urllib.request.urlopen(url, timeout=30).read())
        except Exception:
            continue
        rows = (data.get("CardBusStatisticsServiceNew") or {}).get("row") or []
        mine = [float(r["GTON_TNOPE"]) for r in rows if r.get("STOPS_ARS_NO") == ars]
        if mine:
            out[day] = max(mine)
    return out


def weekday_stats(per_day):
    """평일만의 하루 평균과 요일별 평균. 평일인데 평일 중앙값의 절반에 못 미치는 날은 공휴일·휴업일로 보고 뺀다."""
    week = {d: v for d, v in per_day.items() if d.weekday() < 5}
    if len(week) < 8:   # 일별 자료가 없거나 너무 적으면 월 자료만 쓴다
        return None
    mid = statistics.median(week.values())
    school = {d: v for d, v in week.items() if v >= mid * 0.5}
    by = {}
    for d, v in school.items():
        by.setdefault(d.weekday(), []).append(v)
    return {"avg": sum(school.values()) / len(school), "days": len(school), "skipped": sorted(f"{d:%m/%d}" for d in week if d not in school),
            "by": {"월화수목금"[w]: round(sum(v) / len(v), 1) for w, v in sorted(by.items())},
            "from": f"{min(per_day):%Y-%m-%d}", "until": f"{max(per_day):%Y-%m-%d}"}


def main():
    raw = pathlib.Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else download()
    rows = list(csv.reader(io.StringIO(raw.decode("cp949"))))
    head, rows = rows[0], rows[1:]
    if head[:6] != ["사용년월", "노선번호", "노선명", "표준버스정류장ID", "버스정류장ARS번호", "역명"] or "승차" not in head[6]:
        raise SystemExit("파일 형식이 바뀌었습니다: " + ", ".join(head[:8]))
    ym = rows[0][0]
    year, month = int(ym[:4]), int(ym[4:6])
    weekdays = sum(1 for d in range(1, calendar.monthrange(year, month)[1] + 1) if calendar.weekday(year, month, d) < 5)
    content = json.loads((ROOT / "site" / "content.json").read_text(encoding="utf-8"))
    key = api_key()
    print("일별 자료:", "인증키로 받는다" if key else "인증키가 없어 월 자료만 쓴다")
    out = {"month": f"{year}-{month:02d}", "weekdays": weekdays, "source": "서울 열린데이터광장 OA-12913", "stops": {}}
    for stop in content.get("bus", {}).get("stops", []):
        for route in stop.get("routes", []):
            mine = [r for r in rows if r[1] == route and r[4] == str(stop["id"])]
            if not mine:
                print(f"없음: {route} {stop['id']}")
                continue
            # 같은 정류장이 출발·도착으로 두 번 나오면 타는 사람이 많은 쪽(출발)을 쓴다
            row = max(mine, key=lambda r: sum(float(r[6 + 2 * h]) for h in range(24)))
            name = f"{stop['id']}|{route}"
            month_total = sum(float(row[6 + 2 * h]) for h in range(24)) or 1
            per = daily_boardings(key, route, str(stop["id"]), datetime.date.today()) if key else {}
            stats = weekday_stats(per)
            if per:   # 최근 2주의 날짜별 실제 승차 인원(화면의 "지난주 같은 요일" 문장에 쓴다)
                out.setdefault("recent", {})[name] = {f"{d:%Y%m%d}": round(v) for d, v in sorted(per.items())[-14:]}
            # 일별 자료가 있으면 평일 하루 평균에 월 자료의 시간대 비율을 곱하고, 없으면 월 합계를 평일 수로 나눈다
            per_day = stats["avg"] if stats else month_total / weekdays
            out["stops"][name] = {str(h): round(float(row[6 + 2 * h]) / month_total * per_day, 1) for h in range(6, 23)}
            if stats:
                out.setdefault("week", {})[name] = stats["by"]
                out["daily"] = {"from": stats["from"], "until": stats["until"]}
                print(f"  평일 {stats['days']}일 평균 {stats['avg']:.1f}명, 제외한 날 {stats['skipped']}, 요일별 {stats['by']}")
            print(f"{route} {row[5]}: 15시 {out['stops'][name]['15']}명, 16시 {out['stops'][name]['16']}명")
    path = ROOT / "site" / "bus" / "ridership.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(path, out["month"], "평일", weekdays, "일")


if __name__ == "__main__":
    main()
