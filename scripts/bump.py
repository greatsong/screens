#!/usr/bin/env python3
"""시험용: site/content.json의 버전과 게시 시각을 올리고 화면 상태·공지·원격 시연을 바꾼다.

GitHub Actions 「화면 배포」를 수동 실행하면 이 스크립트가 돈다.
게시 시각(publishedAt)과 화면에 표시된 시각의 차이로 반영 지연을 잰다.
"""
import argparse
import datetime
import json
import pathlib

CONTENT = pathlib.Path(__file__).resolve().parent.parent / "site" / "content.json"
KST = datetime.timezone(datetime.timedelta(hours=9))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["normal", "stop"], default="normal")
    p.add_argument("--notice", default="")
    p.add_argument("--showcase-url", default="")
    p.add_argument("--showcase-title", default="")
    args = p.parse_args()

    data = json.loads(CONTENT.read_text(encoding="utf-8"))
    data["version"] = int(data.get("version", 0)) + 1
    data["publishedAt"] = datetime.datetime.now(KST).isoformat(timespec="seconds")
    data["mode"] = args.mode
    data["notice"] = args.notice.strip()

    url = args.showcase_url.strip()
    showcase = data.setdefault("showcase", {})
    showcase["now"] = {"title": args.showcase_title.strip() or url, "url": url} if url else None

    CONTENT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"v{data['version']} · {data['publishedAt']} · mode={data['mode']} · "
          f"notice={'있음' if data['notice'] else '없음'} · 원격 시연={'켬' if url else '끔'}")


if __name__ == "__main__":
    main()
