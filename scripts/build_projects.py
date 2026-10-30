#!/usr/bin/env python3
"""등록부, 검사 결과, 화면 제어를 합쳐 화면 내용을 만든다.

파일마다 쓰는 주체를 하나로 정해 동시에 고쳐도 충돌하지 않게 한다.
- projects/registry.json   등록부. 관리 시트(Apps Script)와 사람이 쓴다.
- projects/control.json    화면 제어(긴급 정지, 공지, 원격 시연). 관리 화면과 휴대폰 수동 실행이 쓴다.
- site/projects/<id>/      검사 결과와 캡처. 작품 검사(check_projects.py)가 쓴다.
- projects/assigned.json   짧은 주소 번호와 승인 시점 지문. 이 스크립트만 쓴다.
- site/content.json, site/projects/index.json, site/p/   이 스크립트가 만든다.

게시 조건: 제작자 확인 + 교사 승인 + 검사 실패 아님 + 숨김 아님
승인 버전: 승인할 때(approvedAt)의 화면 지문을 남기고, 그 뒤 작품이 바뀌면 표시한다. 다시 승인하면 새로 기록한다.
"""
import datetime
import html
import json
import os
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
REG = ROOT / "projects" / "registry.json"
CONTROL = ROOT / "projects" / "control.json"
ASSIGNED = ROOT / "projects" / "assigned.json"
SITE = ROOT / "site"
CONTENT = SITE / "content.json"
INDEX = SITE / "projects" / "index.json"
KST = datetime.timezone(datetime.timedelta(hours=9))
BASE = os.environ.get("SITE_BASE", "https://greatsong.github.io/screens").rstrip("/")


def run_url(p):
    return p.get("pinnedUrl") or p.get("tryUrl") or p["url"]


def load(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def redirect_page(title, url):
    t, u = html.escape(title), html.escape(url, quote=True)
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title><meta http-equiv="refresh" content="0; url={u}"></head>
<body style="font-family:sans-serif;padding:24px"><p><a href="{u}">{t}</a> 작품으로 이동합니다.</p>
<script>location.replace({json.dumps(url)})</script></body></html>
"""


def without(d, keys):
    return {k: v for k, v in d.items() if k not in keys}


def main():
    reg = load(REG)
    projects = reg["projects"]
    control = load(CONTROL, {})
    assigned = load(ASSIGNED, {"projects": {}})
    amap = assigned.setdefault("projects", {})
    a_before = json.dumps(assigned, sort_keys=True, ensure_ascii=False)
    today = datetime.datetime.now(KST).date()

    nxt = max([a.get("no", 0) for a in amap.values()] + [0]) + 1
    for p in projects:
        a = amap.setdefault(p["id"], {})
        if "no" not in a:
            a["no"], nxt = nxt, nxt + 1

    review, published = [], []
    for p in projects:
        a = amap[p["id"]]
        chk = load(SITE / "projects" / p["id"] / "check.json")
        if chk and chk.get("url") != run_url(p):
            chk = None  # 주소가 바뀌었으면 예전 주소의 검사 결과로 게시하지 않는다
        status = chk["status"] if chk else "unchecked"
        fp = chk.get("fingerprint") if chk else ""
        approved = p.get("teacher") == "approved"
        if approved and fp and (not a.get("fingerprint") or a.get("approvedAt", "") != p.get("approvedAt", "")):
            a["fingerprint"], a["approvedAt"] = fp, p.get("approvedAt", "")
        elif not approved:
            a.pop("fingerprint", None)
            a.pop("approvedAt", None)
        changed = bool(approved and a.get("fingerprint") and fp and fp != a["fingerprint"])
        pinned = bool(p.get("pinUntil")) and today <= datetime.date.fromisoformat(p["pinUntil"])
        ver = (chk or {}).get("checkedAt", "")[:19].replace(":", "")  # 캡처가 바뀌면 이미지 캐시도 바뀌게
        shots = (chk or {}).get("shots", {})
        images = {k: f"projects/{p['id']}/{v['image']}?v={ver}" for k, v in shots.items() if v.get("image")}

        entry = {
            "id": p["id"], "no": a["no"], "title": p["title"], "summary": p["summary"], "maker": p["maker"],
            "target": p.get("target", "wide"), "howTo": p.get("howTo", ""), "run": run_url(p),
            "embed": bool(chk and chk["frame"]["allowed"]) and p.get("target") != "mobile",
            "short": f"{BASE.split('://', 1)[1]}/p/{a['no']}", "shortUrl": f"{BASE}/p/{a['no']}/",
            "images": images, "pinned": pinned,
        }
        reasons = []
        if not p.get("makerConfirmed"):
            reasons.append("제작자 확인 전")
        if p.get("teacher") == "hidden":
            reasons.append("숨김")
        elif not approved:
            reasons.append("교사 승인 전")
        if status in ("fail", "unchecked"):
            reasons.append("검사 실패" if status == "fail" else "검사 전")
        if not reasons:
            published.append(entry)
        review.append({**entry, "source": p.get("source", "manual"), "status": status,
                       "problems": (chk or {}).get("problems", []), "checkedAt": (chk or {}).get("checkedAt", ""),
                       "fingerprint": fp, "teacher": p.get("teacher", "pending"),
                       "makerConfirmed": bool(p.get("makerConfirmed")), "published": not reasons,
                       "reasons": reasons, "changedAfterApproval": changed, "demoSteps": p.get("demoSteps", [])})

    published.sort(key=lambda e: (not e["pinned"], e["no"]))
    stamp = datetime.datetime.now(KST).isoformat(timespec="seconds")

    # 짧은 주소: 게시 중인 작품만 남긴다 (숨긴 작품은 짧은 주소로도 열리지 않게)
    pdir = SITE / "p"
    keep = {str(e["no"]) for e in published}
    if pdir.exists():
        for d in pdir.iterdir():
            if d.is_dir() and d.name not in keep:
                shutil.rmtree(d)
    for e in published:
        (pdir / str(e["no"])).mkdir(parents=True, exist_ok=True)
        (pdir / str(e["no"]) / "index.html").write_text(redirect_page(e["title"], e["run"]), encoding="utf-8")

    # 검토 화면과 관리 시트가 읽는 상태. syncId·requestId로 '배포 완료'를 확인한다.
    idx = {"registrySyncId": reg.get("syncId", ""), "controlRequestId": control.get("requestId", ""), "projects": review}
    old_idx = load(INDEX, {})
    if without(old_idx, {"generatedAt"}) != idx:
        INDEX.parent.mkdir(exist_ok=True)
        save(INDEX, {"generatedAt": stamp, **idx})

    content = load(CONTENT)
    before = without(content, {"version", "publishedAt"})
    content["projects"] = published
    content["mode"] = control.get("mode", "normal")
    content["notice"] = control.get("notice", "")
    content["noticeUntil"] = control.get("noticeUntil", "")
    content.setdefault("showcase", {})["now"] = control.get("showcase")
    content["controlRequestId"] = control.get("requestId", "")
    content["requestedAt"] = control.get("updatedAt", "")
    if without(content, {"version", "publishedAt"}) != before:
        content["version"] = int(content.get("version", 0)) + 1
        content["publishedAt"] = stamp
        save(CONTENT, content)
        print(f"편성 변경 → 콘텐츠 v{content['version']}")

    if json.dumps(assigned, sort_keys=True, ensure_ascii=False) != a_before:
        save(ASSIGNED, assigned)

    for r in review:
        mark = "게시" if r["published"] else "대기(" + ", ".join(r["reasons"]) + ")"
        flag = " · 승인 후 변경됨" if r["changedAfterApproval"] else ""
        print(f"{r['no']:>3} {r['id']}: {mark} · 검사 {r['status']} · {'이 화면 실행' if r['embed'] else 'QR 안내'}{flag}")


if __name__ == "__main__":
    main()
