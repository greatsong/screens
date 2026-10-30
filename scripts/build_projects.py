#!/usr/bin/env python3
"""검사 결과와 승인 상태로 작품을 편성한다.

- 게시 조건: 제작자 확인 + 교사 승인 + 검사 실패 아님 + 숨김 아님
- site/content.json 의 projects 를 바꾸고, 바뀌었으면 버전과 게시 시각을 올린다
- site/p/<번호>/ 에 짧은 주소(이동 페이지)를 만든다. 게시하지 않는 작품의 짧은 주소는 지운다
- site/projects/index.json 에 등록된 작품 전체의 상태를 적는다 (검토 화면용)
- 승인된 작품은 처음 편성할 때의 화면 지문(fingerprint)을 등록부에 남겨, 승인 뒤 작품이 바뀌면 표시한다
"""
import datetime
import html
import json
import os
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
REG = ROOT / "projects" / "registry.json"
SITE = ROOT / "site"
CONTENT = SITE / "content.json"
KST = datetime.timezone(datetime.timedelta(hours=9))
BASE = os.environ.get("SITE_BASE", "https://greatsong.github.io/screens").rstrip("/")


def run_url(p):
    return p.get("pinnedUrl") or p.get("tryUrl") or p["url"]


def load(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def redirect_page(title, url):
    t, u = html.escape(title), html.escape(url, quote=True)
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title><meta http-equiv="refresh" content="0; url={u}"></head>
<body style="font-family:sans-serif;padding:24px"><p><a href="{u}">{t}</a> 작품으로 이동합니다.</p>
<script>location.replace({json.dumps(url)})</script></body></html>
"""


def main():
    reg = load(REG)
    projects = reg["projects"]
    today = datetime.datetime.now(KST).date()
    reg_changed = False

    nxt = max([p.get("no", 0) for p in projects] + [0]) + 1
    for p in projects:
        if "no" not in p:
            p["no"], nxt, reg_changed = nxt, nxt + 1, True

    review, published = [], []
    for p in projects:
        chk = load(SITE / "projects" / p["id"] / "check.json")
        status = chk["status"] if chk else "unchecked"
        fp = chk.get("fingerprint") if chk else ""
        if p.get("teacher") == "approved" and fp and not p.get("approvedFingerprint"):
            p["approvedFingerprint"], reg_changed = fp, True
        changed = bool(p.get("approvedFingerprint") and fp and fp != p["approvedFingerprint"])
        pinned = bool(p.get("pinUntil")) and today <= datetime.date.fromisoformat(p["pinUntil"])
        ver = (chk or {}).get("checkedAt", "")[:19].replace(":", "")  # 캡처가 바뀌면 이미지 캐시도 바뀌게
        shots = (chk or {}).get("shots", {})
        images = {k: f"projects/{p['id']}/{v['image']}?v={ver}" for k, v in shots.items() if v.get("image")}

        entry = {
            "id": p["id"], "no": p["no"], "title": p["title"], "summary": p["summary"], "maker": p["maker"],
            "target": p.get("target", "wide"), "howTo": p.get("howTo", ""), "run": run_url(p),
            "embed": bool(chk and chk["frame"]["allowed"]) and p.get("target") != "mobile",
            "short": f"{BASE.split('://', 1)[1]}/p/{p['no']}", "shortUrl": f"{BASE}/p/{p['no']}/",
            "images": images, "pinned": pinned,
        }
        reasons = []
        if not p.get("makerConfirmed"):
            reasons.append("제작자 확인 전")
        if p.get("teacher") == "hidden":
            reasons.append("숨김")
        elif p.get("teacher") != "approved":
            reasons.append("교사 승인 전")
        if status in ("fail", "unchecked"):
            reasons.append("검사 실패" if status == "fail" else "검사 전")
        if not reasons:
            published.append(entry)
        review.append({**entry, "status": status, "problems": (chk or {}).get("problems", []),
                       "checkedAt": (chk or {}).get("checkedAt", ""), "teacher": p.get("teacher", "pending"),
                       "makerConfirmed": bool(p.get("makerConfirmed")), "published": not reasons,
                       "reasons": reasons, "changedAfterApproval": changed, "demoSteps": p.get("demoSteps", [])})

    published.sort(key=lambda e: (not e["pinned"], e["no"]))

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

    stamp = datetime.datetime.now(KST).isoformat(timespec="seconds")
    (SITE / "projects").mkdir(exist_ok=True)
    idx_path = SITE / "projects" / "index.json"
    old_idx = load(idx_path, {}).get("projects")
    if old_idx != review:
        idx_path.write_text(json.dumps({"generatedAt": stamp, "projects": review}, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")

    content = load(CONTENT)
    if content.get("projects") != published:
        content["projects"] = published
        content["version"] = int(content.get("version", 0)) + 1
        content["publishedAt"] = stamp
        CONTENT.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"편성 변경 → 콘텐츠 v{content['version']}")
    if reg_changed:
        REG.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for r in review:
        mark = "게시" if r["published"] else "대기(" + ", ".join(r["reasons"]) + ")"
        flag = " · 승인 후 변경됨" if r["changedAfterApproval"] else ""
        print(f"{r['no']:>3} {r['id']}: {mark} · 검사 {r['status']} · {'이 화면 실행' if r['embed'] else 'QR 안내'}{flag}")


if __name__ == "__main__":
    main()
