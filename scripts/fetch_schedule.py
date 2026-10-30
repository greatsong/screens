#!/usr/bin/env python3
"""나이스 학사일정에서 앞으로 10주 동안의 행사를 받아 projects/schedule.json 에 쓴다. 편성이 content.json 의 schedule 로 합친다.

나이스는 인증키 없이 부르면 한 번에 5건만 주고 쪽 넘김도 되지 않는다. 토요휴업일이 자리를 차지하지 않게
월~금 한 주씩 나눠 부른다(한 주에 행사가 5건을 넘는 일은 드물다). 공개 저장소라 인증키는 쓰지 않는다.
여러 날 이어지는 같은 행사(지필평가, 방학 등)는 하나로 묶는다. 받지 못하면 이전 파일을 그대로 둔다.

  python3 scripts/fetch_schedule.py            → projects/schedule.json 갱신
  python3 scripts/fetch_schedule.py --dry-run  → 받은 행사만 출력
"""
import datetime
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "projects" / "schedule.json"
KST = datetime.timezone(datetime.timedelta(hours=9))
OFFICE, SCHOOL = "B10", "7010073"   # 서울특별시교육청 · 당곡고등학교
WEEKS = 10
SKIP = {"토요휴업일", "일요일"}          # 날마다 있는 휴업일은 보여 주지 않는다


def week(mon):
    fri = mon + datetime.timedelta(days=4)
    url = ("https://open.neis.go.kr/hub/SchoolSchedule?Type=json&pIndex=1&pSize=5"
           f"&ATPT_OFCDC_SC_CODE={OFFICE}&SD_SCHUL_CODE={SCHOOL}&AA_FROM_YMD={mon:%Y%m%d}&AA_TO_YMD={fri:%Y%m%d}")
    d = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "danggok-screens"}), timeout=20).read())
    box = d.get("SchoolSchedule")
    if not box:
        if d.get("RESULT", {}).get("CODE") == "INFO-200":   # 그 주에 행사 없음
            return []
        raise RuntimeError(d.get("RESULT", d))
    return box[1].get("row", [])


def grades(r):
    g = [str(i) for i, k in enumerate(("ONE", "TW", "THREE"), 1) if r.get(f"{k}_GRADE_EVENT_YN") == "Y"]
    return "" if len(g) in (0, 3) else "·".join(g) + "학년"


def main(dry):
    today = datetime.datetime.now(KST).date()
    mon = today - datetime.timedelta(days=today.weekday())
    rows = []
    try:
        for w in range(WEEKS):
            rows += week(mon + datetime.timedelta(weeks=w))
    except Exception as e:
        print(f"학사일정을 받지 못해 이전 파일을 그대로 둔다 ({e.__class__.__name__})")
        return
    events = []
    for r in sorted(rows, key=lambda r: r["AA_YMD"]):
        name = (r.get("EVENT_NM") or "").strip()
        day = datetime.datetime.strptime(r["AA_YMD"], "%Y%m%d").date()
        if not name or name in SKIP or day < today:
            continue
        g = grades(r)
        # 같은 이름·같은 학년 행사가 주말만 끼고 이어지면 하나로 묶는다(사이에 다른 행사가 있어도)
        same = next((e for e in reversed(events) if e["name"] == name and e["grades"] == g and 0 <= (day - e["_end"]).days <= 3), None)
        if same:
            same["_end"] = day
            continue
        events.append({"name": name, "grades": g, "holiday": r.get("SBTR_DD_SC_NM") == "휴업일", "_start": day, "_end": day})
    items = [{"name": e["name"], "start": e["_start"].isoformat(), "end": e["_end"].isoformat(), "grades": e["grades"], "holiday": e["holiday"]}
             for e in events]
    for e in items:
        print(f"  {e['start']} ~ {e['end']}  {e['name']}  {e['grades']}{' (휴업)' if e['holiday'] else ''}")
    if dry:
        return
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if old.get("events") == items:
        print("바뀐 학사일정 없음")
        return
    OUT.write_text(json.dumps({"updatedAt": datetime.datetime.now(KST).isoformat(timespec="seconds"), "events": items},
                              ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"학사일정 {len(items)}건 → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
