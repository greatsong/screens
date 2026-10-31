"""AI 뉴스의 유효 기간과 교사가 저장한 숨김·문구 수정을 적용한다.

수집 원문과 관리 이력을 고치지 않는 순수 함수다. request는 교사의 요청 기록이며,
그 내용을 근거로 문구를 자동 생성하지 않는다.
"""
import datetime

KST = datetime.timezone(datetime.timedelta(hours=9))
HOURS = 72


def expires_at(item):
    """새 기사는 RSS 시각 + 72시간, 기존 기사는 기사 날짜의 한국 시각 자정 + 72시간."""
    until = item.get("until")
    if isinstance(until, str) and until:
        try:
            expiry = datetime.datetime.fromisoformat(until.replace("Z", "+00:00"))
            return expiry if expiry.tzinfo else expiry.replace(tzinfo=KST)
        except ValueError:
            pass
    try:
        day = datetime.date.fromisoformat(item.get("date", ""))
    except (TypeError, ValueError):
        return None
    return datetime.datetime.combine(day, datetime.time(), tzinfo=KST) + datetime.timedelta(hours=HOURS)


def apply_news_policy(items, control=None, now=None):
    """만료·숨김을 제외하고 제목·요약만 덮어쓴 새 목록을 반환한다."""
    now = now or datetime.datetime.now(KST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=KST)
    entries = (control or {}).get("entries", {})
    if not isinstance(entries, dict):
        entries = {}
    visible = []
    for item in items:
        expiry = expires_at(item)
        if expiry is None or expiry <= now:
            continue
        entry = entries.get(str(item.get("id", "")), {})
        if not isinstance(entry, dict):
            entry = {}
        if entry.get("hidden") is True:
            continue
        amended = {**item, "until": expiry.astimezone(KST).isoformat(timespec="seconds")}
        for field in ("title", "summary"):
            if isinstance(entry.get(field), str):
                amended[field] = entry[field]
        visible.append(amended)
    return visible
