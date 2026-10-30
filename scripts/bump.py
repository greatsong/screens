#!/usr/bin/env python3
"""휴대폰 수동 실행용: projects/control.json 의 화면 상태·공지·원격 시연을 바꾼다.

GitHub Actions 「화면 배포」를 수동 실행하면 이 스크립트가 돌고, 이어서 편성 스크립트가 content.json에 합친다.
관리 화면(Apps Script)을 사용할 수 없을 때의 예비 경로다. 입력값은 '원하는 최종 상태'로 다룬다.
"""
import argparse
import datetime
import json
import pathlib
import secrets

CONTROL = pathlib.Path(__file__).resolve().parent.parent / "projects" / "control.json"
KST = datetime.timezone(datetime.timedelta(hours=9))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["normal", "stop"], default="normal")
    p.add_argument("--notice", default="")
    p.add_argument("--showcase-url", default="")
    p.add_argument("--showcase-title", default="")
    args = p.parse_args()

    data = json.loads(CONTROL.read_text(encoding="utf-8")) if CONTROL.exists() else {}
    now = datetime.datetime.now(KST)
    data["mode"] = args.mode
    data["notice"] = args.notice.strip()
    data["noticeUntil"] = ""

    # 원격 시연: 주소를 넣으면 그 주소를, 작품 id나 번호(예: commit-galaxy, 2)를 넣으면 등록된 작품을 연다
    url = args.showcase_url.strip()
    if not url:
        data["showcase"] = None
    elif "://" in url or "/" in url:
        data["showcase"] = {"title": args.showcase_title.strip() or url, "url": url}
    else:
        data["showcase"] = {"project": url}

    # 요청 id는 시각으로 시작해 관리 시트의 요청 id와 순서를 비교할 수 있다
    data["requestId"] = now.strftime("%Y%m%d-%H%M%S") + "-p" + secrets.token_hex(2)
    data["updatedAt"] = now.isoformat(timespec="seconds")
    data["updatedBy"] = "phone"
    CONTROL.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{data['requestId']} · mode={data['mode']} · notice={'있음' if data['notice'] else '없음'} · "
          f"원격 시연={'켬' if data['showcase'] else '끔'}")


if __name__ == "__main__":
    main()
