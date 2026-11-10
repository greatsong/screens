"""하교 버스 카드의 시간대별 승차 인원(site/bus/ridership.json)을 만든다.

서울 열린데이터광장 「버스노선별 정류장별 시간대별 승하차 인원 정보」(OA-12913)의 가장 최근 월 파일을 받아
content.json 의 bus.stops 에 적힌 정류장·노선만 뽑는다. 월 합계를 그 달의 평일 수로 나눠 하루 평균으로 적는다
(주말 이용분이 섞여 있어 실제 평일 평균보다 조금 크다). 매월 5일쯤 전월 자료가 올라온다.
사용법: python3 scripts/build_ridership.py            (최근 월 파일을 받는다)
        python3 scripts/build_ridership.py 파일.csv   (받아 둔 파일을 사용한다)
"""
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
    out = {"month": f"{year}-{month:02d}", "weekdays": weekdays, "source": "서울 열린데이터광장 OA-12913", "stops": {}}
    for stop in content.get("bus", {}).get("stops", []):
        for route in stop.get("routes", []):
            mine = [r for r in rows if r[1] == route and r[4] == str(stop["id"])]
            if not mine:
                print(f"없음: {route} {stop['id']}")
                continue
            # 같은 정류장이 출발·도착으로 두 번 나오면 타는 사람이 많은 쪽(출발)을 쓴다
            row = max(mine, key=lambda r: sum(float(r[6 + 2 * h]) for h in range(24)))
            out["stops"][f"{stop['id']}|{route}"] = {str(h): round(float(row[6 + 2 * h]) / weekdays, 1) for h in range(6, 23)}
            print(f"{route} {row[5]}: 15시 {out['stops'][stop['id'] + '|' + route]['15']}명, 16시 {out['stops'][stop['id'] + '|' + route]['16']}명")
    path = ROOT / "site" / "bus" / "ridership.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(path, out["month"], "평일", weekdays, "일")


if __name__ == "__main__":
    main()
