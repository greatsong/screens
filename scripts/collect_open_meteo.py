"""기상청 예보와 비교할 Open-Meteo 예보를 날마다 쌓는다.

Open-Meteo 예보(api.open-meteo.com, 키 없음, 학교 좌표)를 실행한 시각의 예보 그대로
data/open-meteo/forecast/YYYY-MM.csv 에 덧붙인다(YYYY-MM 은 받은 시각의 달).
Open-Meteo 는 여러 나라의 수치 예보 모델을 전달하는 서비스다. 화면의 날씨 카드가 사용하는 기본값(best_match)과 함께
모델을 지정한 예보(MODELS)도 받아 model 열로 구분한다. 모델별 강점·약점과 여러 예보를 합친 예보를 살펴보는 데 사용한다.
Open-Meteo 는 지난 예보의 기온·강수량은 나중에도 돌려주지만(previous-runs-api) 강수 확률은 돌려주지 않는다.
그래서 강수 확률을 비교하려면 그때그때 받아 두어야 한다. 실행이 빠진 회차의 예보는 다시 받을 수 없다.
행의 모양은 기상청 예보 파일과 같게 맞췄다(받은 시각, 대상 시각, 선행 시간). 실제 관측은 data/kma/observed/ 를 함께 사용한다.
받지 못하거나 응답 형식이 잘못되면 건너뛰고 data/open-meteo/collect_log.csv 에 기록한다.
사용법: python3 scripts/collect_open_meteo.py
"""
import datetime
import json
import sys
import urllib.request

import collect_kma as base

LAT, LON = 37.4917, 126.9347    # site/content.json 의 bus.rain 과 같은 곳
FORECAST_DAYS = 5               # 오늘부터 닷새. 기상청 단기예보의 범위와 맞춘다
MAX_LEAD_HOURS = 96
URL = ("https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
       "&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m"
       "&wind_speed_unit=ms&timezone=Asia%2FSeoul&forecast_days={days}&models={models}")
# best_match 기본값(화면과 같음) · ecmwf_ifs025 유럽 · gfs_seamless 미국 · icon_seamless 독일 · jma_seamless 일본
MODELS = ["best_match", "ecmwf_ifs025", "gfs_seamless", "icon_seamless", "jma_seamless"]
FIELDS = ["temperature_2m", "precipitation_probability", "precipitation", "weather_code", "wind_speed_10m"]
COLUMNS = ["issued_at", "target_at", "lead_hours", "model", "temp_c", "pop_pct", "precip_mm", "weather_code", "wind_ms"]


def fetch():
    """한 번 요청한다. (hourly 자료, 설명)을 돌려준다. 실패하면 자료는 None."""
    url = URL.format(lat=LAT, lon=LON, days=FORECAST_DAYS, models=",".join(MODELS))
    try:
        raw = urllib.request.urlopen(url, timeout=40).read().decode("utf-8", "replace")
    except Exception as err:
        return None, "연결 실패 " + type(err).__name__ + (f" {err.code}" if hasattr(err, "code") else "")
    try:
        hourly = json.loads(raw)["hourly"]
        times = hourly["time"]
        if not isinstance(times, list) or any(len(hourly[f"{f}_{m}"]) != len(times) for f in FIELDS for m in MODELS):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        return None, "응답 형식 오류"
    return hourly, ""


def parse(hourly, issued):
    """hourly 자료를 대상 시각·모델별 행으로. 받은 시각 이후 96시간까지만. (행 목록, 건너뛴 이유 목록)
    값의 이름은 temperature_2m_ecmwf_ifs025 처럼 항목_모델이다. 기온이 없는 모델·시각은 건너뛴다."""
    rows = []
    broken = 0
    for i, stamp in enumerate(hourly["time"]):
        try:
            target = datetime.datetime.strptime(stamp, base.STAMP)
        except (TypeError, ValueError):
            broken += 1
            continue
        lead = (target - issued).total_seconds() / 3600
        if lead <= 0 or lead > MAX_LEAD_HOURS:
            continue
        for model in MODELS:
            values = [base.number(hourly[f"{f}_{model}"][i]) for f in FIELDS]
            if values[0] is None:
                broken += 1
                continue
            rows.append([issued.strftime(base.STAMP), target.strftime(base.STAMP), base.text(lead), model] + [base.text(v) for v in values])
    return rows, ([f"기온이 없거나 시각이 잘못된 {broken}건 건너뜀"] if broken else [])


def collect(now, root=base.ROOT, fetch=fetch):
    """지금 예보를 한 번 저장한다. 같은 시(時)에 이미 받았으면 다시 받지 않는다. 요약 {rows, failed, logs}"""
    issued = now.replace(minute=0, second=0, microsecond=0)
    path = root / "data" / "open-meteo" / "forecast" / f"{issued:%Y-%m}.csv"
    summary = {"rows": 0, "failed": 0, "logs": 0}
    if path.exists() and issued.strftime(base.STAMP) in base.first_column(path):
        return summary
    hourly, message = fetch()
    logs = []
    if hourly is None:
        summary["failed"] = 1
        logs.append(message)
    else:
        rows, logs = parse(hourly, issued)
        if rows:
            base.append(path, COLUMNS, rows)
            summary["rows"] = len(rows)
        else:
            summary["failed"] = 1
            logs.append("저장할 행이 없음")
    if logs:
        stamp = now.strftime(base.STAMP)
        base.append(root / "data" / "open-meteo" / "collect_log.csv", base.LOG_COLUMNS,
                    [[stamp, "forecast", issued.strftime(base.STAMP), n] for n in logs])
    summary["logs"] = len(logs)
    return summary


def main():
    s = collect(base.now_kst())
    print(f"Open-Meteo 예보 {s['rows']}행 저장, 실패 {s['failed']}건, 기록 {s['logs']}줄")
    return 1 if s["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
