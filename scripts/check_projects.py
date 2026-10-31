#!/usr/bin/env python3
"""등록된 작품의 접속·체험 가능 여부를 검사하고 대표 화면을 캡처한다.

결과: site/projects/<id>/check.json, wide.jpg, mobile.jpg
  --plan            검사가 필요한 작품 수만 출력한다 (Playwright를 설치할지 정할 때 사용)
  --all             모든 작품을 다시 검사한다
  --max-age-hours   이 시간보다 오래된 검사 결과는 다시 검사한다 (기본 20)
  --registry        다른 등록부 파일로 시험할 때 사용
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "projects"
KST = datetime.timezone(datetime.timedelta(hours=9))
DISPLAY_ORIGIN = "https://greatsong.github.io"  # 스탠바이미 화면이 열리는 출처
UA = "Mozilla/5.0 (screens-checker; +https://github.com/greatsong/screens)"
VIEWPORTS = {
    "wide": {"viewport": {"width": 1600, "height": 900}, "device_scale_factor": 1, "is_mobile": False, "has_touch": True},
    "mobile": {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True},
}


def now_iso():
    return datetime.datetime.now(KST).isoformat(timespec="seconds")


def origin_of(url):
    u = urllib.parse.urlsplit(url)
    return f"{u.scheme}://{u.netloc}".lower()


def frame_policy(url, headers):
    """화면 페이지(DISPLAY_ORIGIN) 안의 iframe으로 열 수 있는지 응답 헤더로 판단한다."""
    headers = {key.lower(): value for key, value in headers.items()}
    same = origin_of(url) == DISPLAY_ORIGIN
    csp = headers.get("content-security-policy", "")
    m = re.search(r"frame-ancestors([^;]*)", csp, re.I)
    if m:  # frame-ancestors가 있으면 X-Frame-Options보다 우선한다
        srcs = m.group(1).split()
        if "*" in srcs or DISPLAY_ORIGIN in [s.rstrip("/").lower() for s in srcs] or "https:" in srcs:
            return True, "frame-ancestors 허용"
        if "'self'" in srcs and same:
            return True, "같은 출처라 허용"
        return False, f"frame-ancestors{m.group(1)}"
    xfo = headers.get("x-frame-options", "").strip().upper()
    if xfo == "DENY" or (xfo == "SAMEORIGIN" and not same):
        return False, f"X-Frame-Options: {xfo}"
    return True, "제한 없음"


def fetch_headers(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read(3_000_000)
            return {"http": r.status, "finalUrl": r.geturl(), "headers": dict(r.headers),
                    "fingerprint": hashlib.sha256(body).hexdigest()[:16], "ms": int((time.time() - t0) * 1000)}
    except urllib.error.HTTPError as e:
        return {"http": e.code, "finalUrl": url, "headers": dict(e.headers or {}), "fingerprint": "", "ms": 0, "error": str(e)}
    except Exception as e:  # 연결 실패, 시간 초과
        return {"http": 0, "finalUrl": url, "headers": {}, "fingerprint": "", "ms": 0, "error": str(e)}


def capture(browser, url, kind, dest):
    ctx = browser.new_context(locale="ko-KR", **VIEWPORTS[kind])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    t0 = time.time()
    result = {"ok": False, "image": None, "title": "", "loadMs": 0, "errors": []}
    try:
        page.goto(url, wait_until="load", timeout=30000)
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass  # 계속 통신하는 앱도 있으므로 기다리지 않고 진행한다
        page.wait_for_timeout(1500)  # 첫 애니메이션이 그려질 시간
        result["loadMs"] = int((time.time() - t0) * 1000)
        stats = page.evaluate("""() => ({
            text: document.body ? document.body.innerText.trim().length : 0,
            visual: document.querySelectorAll('canvas, svg, img, video').length })""")
        page.screenshot(path=str(dest), type="jpeg", quality=78)
        result.update(ok=stats["text"] > 0 or stats["visual"] > 0, image=dest.name, title=page.title()[:120], stats=stats)
        if not result["ok"]:
            errors.append("화면에 글자나 그림이 없습니다")
    except Exception as e:
        errors.append(f"페이지를 열지 못했습니다: {str(e).splitlines()[0][:160]}")
    finally:
        ctx.close()
    result["errors"] = errors[:5]
    return result


def run_url(p):
    """B 화면에서 실행할 주소. 버전 고정 주소 → 체험 전용 주소 → 실행 주소 순서."""
    return p.get("pinnedUrl") or p.get("tryUrl") or p["url"]


def target_of(p):
    target = p.get("target", "wide")
    return target if target in (*VIEWPORTS, "both") else "wide"


def needs_check(p, max_age_hours, force):
    f = OUT / p["id"] / "check.json"
    if force or not f.exists():
        return True
    old = json.loads(f.read_text(encoding="utf-8"))
    if old.get("url") != run_url(p) or old.get("target") != target_of(p):
        return True
    try:
        age = datetime.datetime.now(KST) - datetime.datetime.fromisoformat(old["checkedAt"])
    except (KeyError, TypeError, ValueError):
        return True
    return age.total_seconds() > max_age_hours * 3600


def check(browser, p):
    url = run_url(p)
    target = target_of(p)
    d = OUT / p["id"]
    d.mkdir(parents=True, exist_ok=True)
    h = fetch_headers(url)
    allowed, reason = frame_policy(h["finalUrl"], h["headers"])
    problems = []
    if h["http"] != 200:
        problems.append(f"주소에 접속하지 못했습니다 (HTTP {h['http'] or '연결 실패'})")
    if not allowed:
        problems.append(f"다른 사이트 안에서 실행할 수 없도록 막혀 있습니다 ({reason}). B 화면에서는 QR로 안내합니다.")
    shots = {}
    kinds = ["wide", "mobile"] if target == "both" else [target]
    for kind in ["wide", "mobile"]:
        if kind in kinds or kind == "wide":  # 소개 카드에는 가로 화면이 항상 필요하다
            shots[kind] = capture(browser, url, kind, d / f"{kind}.jpg")
    for kind in kinds:
        for e in shots[kind]["errors"]:
            problems.append(f"[{'큰 화면' if kind == 'wide' else '휴대폰'}] {e}")
    fatal = h["http"] != 200 or not all(shots[k]["ok"] for k in kinds)
    status = "fail" if fatal else ("warn" if problems else "ok")
    result = {
        "id": p["id"], "target": target, "checkedAt": now_iso(), "url": url, "finalUrl": h["finalUrl"], "http": h["http"],
        "responseMs": h["ms"], "fingerprint": h["fingerprint"],
        "frame": {"allowed": allowed, "reason": reason},
        "shots": shots, "status": status, "problems": problems,
    }
    (d / "check.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--max-age-hours", type=float, default=20)
    ap.add_argument("--registry", default=str(ROOT / "projects" / "registry.json"))
    args = ap.parse_args()

    projects = json.loads(pathlib.Path(args.registry).read_text(encoding="utf-8"))["projects"]
    todo = [p for p in projects if p.get("teacher") != "hidden" and needs_check(p, args.max_age_hours, args.all)]
    if args.plan:
        print(len(todo))
        return
    if not todo:
        print("검사할 작품 없음")
        return

    from playwright.sync_api import sync_playwright  # 검사할 때만 필요하다
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for p in todo:
            r = check(browser, p)
            print(f"{p['id']}: {r['status']} · HTTP {r['http']} · iframe {'가능' if r['frame']['allowed'] else '불가'}"
                  + "".join(f"\n  - {x}" for x in r["problems"]))
        browser.close()


if __name__ == "__main__":
    main()
