"""기상청 예보의 정확도를 나중에 검증할 수 있도록 예보와 관측을 날마다 쌓는다.

기상청 API허브 동네예보의 단기예보(getVilageFcst)와 초단기실황(getUltraSrtNcst)을 학교 격자(nx=59, ny=125)로 받아
data/kma/forecast/YYYY-MM.csv 와 data/kma/observed/YYYY-MM.csv 에 덧붙인다(YYYY-MM 은 발표·관측 시각의 달).
기상청은 예보를 최근 3일, 관측을 최근 24시간 치만 돌려주므로 지나가면 다시 받을 수 없다.
그래서 실행할 때마다 그 기간 안에서 아직 저장하지 않은 발표분과 관측 시각을 모두 채운다. 실행이 몇 번 빠져도 누락되지 않는다.
응답 형식이 잘못되었거나 발표분이 없으면 그 행을 건너뛰고 data/kma/collect_log.csv 에 기록한다.
인증키는 환경변수 KMA_AUTH_KEY 또는 .local/kma-apihub.env(저장소에 올라가지 않음)에서 읽는다. 키는 화면과 기록에 적지 않는다.
사용법: python3 scripts/collect_kma.py
"""
import csv
import datetime
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/"
NX, NY = 59, 125
ISSUE_HOURS = (2, 5, 8, 11, 14, 17, 20, 23)   # 단기예보 발표 시각
FORECAST_KEEP_HOURS = 66    # 기상청은 72시간 전 발표분까지 돌려준다. 여유를 두고 66시간
OBSERVED_KEEP_HOURS = 23    # 관측은 24시간 전까지. 여유를 두고 23시간
READY_MINUTES = 15          # 발표·관측 시각에서 이만큼 지나야 요청한다
GRACE_HOURS = 2             # 이 시간 안의 "자료 없음"은 아직 올라오지 않은 것으로 보고 기록하지 않는다

FORECAST_COLUMNS = ["issued_at", "target_at", "lead_hours", "temp_c", "pop_pct", "pty", "sky", "wind_ms", "precip_text"]
OBSERVED_COLUMNS = ["observed_at", "temp_c", "rain_mm", "pty", "wind_ms", "rained"]
LOG_COLUMNS = ["logged_at", "kind", "base_at", "note"]
STAMP = "%Y-%m-%dT%H:%M"


def now_kst():
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)).replace(tzinfo=None)


def api_key():
    key = os.environ.get("KMA_AUTH_KEY", "")
    env = ROOT / ".local" / "kma-apihub.env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("KMA_AUTH_KEY="):
                key = line.split("=", 1)[1].strip()
    return key


def release_times(now):
    """지금 요청할 수 있는 단기예보 발표 시각을 오래된 것부터."""
    ready = now - datetime.timedelta(minutes=READY_MINUTES)
    oldest = now - datetime.timedelta(hours=FORECAST_KEEP_HOURS)
    out = []
    day = oldest.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= ready:
        for h in ISSUE_HOURS:
            t = day.replace(hour=h)
            if oldest <= t <= ready:
                out.append(t)
        day += datetime.timedelta(days=1)
    return out


def observation_times(now):
    """지금 요청할 수 있는 관측 시각(매시 정각)을 오래된 것부터."""
    ready = (now - datetime.timedelta(minutes=READY_MINUTES)).replace(minute=0, second=0, microsecond=0)
    return [ready - datetime.timedelta(hours=back) for back in range(OBSERVED_KEEP_HOURS - 1, -1, -1)]


def number(value):
    """숫자로 바꾼다. 숫자가 아니거나 기상청의 결측 표시(±900 이상)이면 None."""
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if x != x or abs(x) >= 900:
        return None
    return x


def text(x):
    """CSV에 적을 모양. None 은 빈칸, 정수로 떨어지면 소수점 없이."""
    if x is None:
        return ""
    return str(int(x)) if x == int(x) else str(round(x, 1))


def parse_forecast(items, issued):
    """단기예보 항목 목록을 대상 시각별 행으로. (행 목록, 건너뛴 이유 목록)을 돌려준다."""
    slots = {}
    notes = []
    broken = 0
    for it in items:
        try:
            target = datetime.datetime.strptime(str(it["fcstDate"]) + str(it["fcstTime"]), "%Y%m%d%H%M")
            category = it["category"]
            value = it["fcstValue"]
        except (KeyError, TypeError, ValueError):
            broken += 1
            continue
        slots.setdefault(target, {})[category] = value
    if broken:
        notes.append(f"형식이 잘못된 항목 {broken}개 건너뜀")
    rows = []
    no_temp = 0
    for target in sorted(slots):
        v = slots[target]
        temp = number(v.get("TMP"))
        lead = (target - issued).total_seconds() / 3600
        if temp is None:
            if set(v) - {"TMN", "TMX"}:      # 최저·최고 기온만 있는 시각은 원래 시간별 값이 없다
                no_temp += 1
            continue
        if lead <= 0:
            continue
        rows.append([issued.strftime(STAMP), target.strftime(STAMP), text(lead), text(temp), text(number(v.get("POP"))),
                     text(number(v.get("PTY"))), text(number(v.get("SKY"))), text(number(v.get("WSD"))), str(v.get("PCP", ""))])
    if no_temp:
        notes.append(f"기온이 없는 대상 시각 {no_temp}개 건너뜀")
    return rows, notes


def parse_observation(items, at):
    """초단기실황 항목 목록을 한 행으로. 기온이 없으면 None."""
    v = {}
    for it in items:
        try:
            v[it["category"]] = it["obsrValue"]
        except (KeyError, TypeError):
            continue
    temp = number(v.get("T1H"))
    if temp is None:
        return None
    rain = number(v.get("RN1"))
    pty = number(v.get("PTY"))
    if rain is None and pty is None:
        rained = ""
    else:
        rained = "1" if (rain or 0) > 0 or (pty or 0) > 0 else "0"
    return [at.strftime(STAMP), text(temp), text(rain), text(pty), text(number(v.get("WSD"))), rained]


def fetch(function, base, key):
    """한 번 요청한다. (항목 목록, 결과 코드, 설명)을 돌려준다. 실패하면 항목은 None."""
    url = (f"{BASE}{function}?pageNo=1&numOfRows=2000&dataType=JSON&base_date={base:%Y%m%d}&base_time={base:%H%M}"
           f"&nx={NX}&ny={NY}&authKey={urllib.parse.quote(key)}")
    try:
        raw = urllib.request.urlopen(url, timeout=40).read().decode("utf-8", "replace")
    except Exception as err:   # 주소에 인증키가 들어 있으므로 오류 내용은 종류만 남긴다
        return None, "연결", "연결 실패 " + type(err).__name__ + (f" {err.code}" if hasattr(err, "code") else "")
    try:
        response = json.loads(raw)["response"]
        header = response["header"]
        code = str(header["resultCode"])
    except (ValueError, KeyError, TypeError):
        return None, "형식", "응답 형식 오류"
    if code != "00":
        return None, code, str(header.get("resultMsg", ""))[:80]
    try:
        items = response["body"]["items"]["item"]
    except (KeyError, TypeError):
        return None, "형식", "응답 형식 오류"
    if not isinstance(items, list):
        return None, "형식", "응답 형식 오류"
    return items, "00", ""


def month_file(root, kind, at):
    return root / "data" / "kma" / kind / f"{at:%Y-%m}.csv"


def stored(root, kind, times):
    """times 가 들어갈 달 파일에 이미 적힌 첫 열(발표·관측 시각) 값들."""
    seen = set()
    for path in {month_file(root, kind, t) for t in times}:
        if path.exists():
            with path.open(encoding="utf-8", newline="") as f:
                seen.update(row[0] for row in csv.reader(f) if row)
    return seen


def append(path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if fresh:
            w.writerow(columns)
        w.writerows(rows)


def collect(now, key, root=ROOT, fetch=fetch):
    """빠진 발표분과 관측 시각을 채운다. 요약 {forecast, observed, failed, logs}를 돌려준다."""
    logs = []
    summary = {"forecast": 0, "releases": 0, "observed": 0, "requests": 0, "failed": 0}

    def note(kind, base, message):
        logs.append([now.strftime(STAMP), kind, base.strftime(STAMP), message])

    def missing(code, base):   # 방금 지난 시각의 "자료 없음"은 아직 올라오지 않은 것
        return code in ("03", "10") and now - base < datetime.timedelta(hours=GRACE_HOURS)

    releases = release_times(now)
    have = stored(root, "forecast", releases)
    for issued in releases:
        if issued.strftime(STAMP) in have:
            continue
        summary["requests"] += 1
        items, code, message = fetch("getVilageFcst", issued, key)
        if items is None:
            if not missing(code, issued):
                summary["failed"] += 1
                note("forecast", issued, message or "자료 없음")
            continue
        rows, notes = parse_forecast(items, issued)
        for n in notes:
            note("forecast", issued, n)
        if not rows:
            summary["failed"] += 1
            note("forecast", issued, "저장할 행이 없음")
            continue
        append(month_file(root, "forecast", issued), FORECAST_COLUMNS, rows)
        summary["forecast"] += len(rows)
        summary["releases"] += 1

    hours = observation_times(now)
    have = stored(root, "observed", hours)
    for at in hours:
        if at.strftime(STAMP) in have:
            continue
        summary["requests"] += 1
        items, code, message = fetch("getUltraSrtNcst", at, key)
        if items is None:
            if not missing(code, at):
                summary["failed"] += 1
                note("observed", at, message or "자료 없음")
            continue
        row = parse_observation(items, at)
        if row is None:
            summary["failed"] += 1
            note("observed", at, "기온이 없어 건너뜀")
            continue
        append(month_file(root, "observed", at), OBSERVED_COLUMNS, [row])
        summary["observed"] += 1

    if logs:
        append(root / "data" / "kma" / "collect_log.csv", LOG_COLUMNS, logs)
    summary["logs"] = len(logs)
    return summary


def main():
    key = api_key()
    if not key:
        print("인증키 KMA_AUTH_KEY 가 없습니다")
        return 1
    s = collect(now_kst(), key)
    print(f"요청 {s['requests']}건: 예보 {s['releases']}회 발표분 {s['forecast']}행, 관측 {s['observed']}행 저장, 실패 {s['failed']}건, 기록 {s['logs']}줄")
    # 요청이 모두 실패했으면(키 만료 등) 실행을 실패로 표시해 알림이 가게 한다
    return 1 if s["requests"] and s["failed"] == s["requests"] else 0


if __name__ == "__main__":
    sys.exit(main())
