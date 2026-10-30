#!/usr/bin/env python3
"""AI 뉴스를 받아 학생에게 보여 줄 기사 몇 건을 고른다. 결과는 projects/news.json 에 쓰고, 편성(build_projects.py)이 화면 내용에 합친다.

고르는 기준(교사 요청 2026-10-30)
- 새 모델 발표, 벤치마크·성능 비교, 새로 발견한 문제, 문제를 해결한 기술처럼 유익한 기사
- 매출·투자·주가·인수 같은 돈 이야기와 사망·소송·스파이 같은 자극적인 기사는 뺀다
- 신뢰할 수 있는 매체만 쓴다(AI 전문지 AI타임스, 통신사 연합뉴스, 전자신문, ZDNet Korea, 한겨레 과학)

기사 본문은 옮기지 않는다. 제목, 매체가 RSS로 내보낸 요약의 첫 문장(짧게), 출처, 기사 주소만 쓴다.
네트워크가 안 되거나 고를 기사가 없으면 이전 파일을 그대로 둔다.

  python3 scripts/fetch_news.py            → projects/news.json 갱신
  python3 scripts/fetch_news.py --dry-run  → 후보와 점수만 출력
"""
import datetime
import email.utils
import hashlib
import html
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "projects" / "news.json"
KST = datetime.timezone(datetime.timedelta(hours=9))
PICK = 5                 # 화면에 내보낼 기사 수
MIN_SCORE = 4            # 이 점수보다 낮으면 내보내지 않는다
HOURS = 72               # 이 시간 안에 나온 기사만(주말을 넘겨도 비지 않게)

SOURCES = [
    ("AI타임스", "https://www.aitimes.com/rss/allArticle.xml"),
    ("연합뉴스", "https://www.yna.co.kr/rss/industry.xml"),
    ("연합뉴스", "https://www.yna.co.kr/rss/international.xml"),
    ("전자신문", "https://rss.etnews.com/Section901.xml"),
    ("ZDNet Korea", "https://feeds.feedburner.com/zdkorea"),
    ("한겨레", "https://www.hani.co.kr/rss/science/"),
]

# 제목에 이것이 있어야 AI 기사로 본다
AI = re.compile(r"AI|인공지능|LLM|GPT|생성형|머신러닝|딥러닝|에이전트|챗봇|오픈AI|앤트로픽|클로드|제미나이|딥시크|라마|미스트랄|큐원|그록|엑사원|하이퍼클로바|코파일럿|파운데이션 모델|언어 ?모델")
# 제목에 이것이 있으면 뺀다: 돈 이야기, 자극적인 사건, 광고·칼럼·인사 같은 형식
DROP = re.compile(
    r"매출|영업익|영업이익|순이익|실적|흑자|적자|투자|시드|시리즈 ?[A-F]\b|기업가치|밸류|주가|증시|시총|시가총액|급락|급등|상장|IPO|"
    r"인수|합병|M&A|수주|억원|조원|억 ?달러|만 ?달러|감원|해고|구조조정|연봉|성장률|GDP|관세|지분|주주|"
    r"밀수|스파이|제소|소송|고소|고발|사망|숨져|숨진|범죄|살인|자살|전쟁|선거|대통령|탄핵|논란|충격|경악|"
    r"\[.*?(서가|칼럼|기고|인터뷰|인사|부고|게시판|포토|광고).*?\]|^\[\d+월 ?\d+일\]")
SCORE = [
    (3, re.compile(r"공개|출시|발표|선보|내놓|론칭|새 모델|신모델|오픈소스|오픈 모델|가중치|버전|업데이트|기능|통합|제공|탑재")),   # 새 모델·새 기능
    (5, re.compile(r"벤치마크|성능|정확도|1위|순위|최고|능가|앞질|점수|평가|리더보드|SOTA|약진")),                              # 벤치마크
    (2, re.compile(r"발견|밝혀|연구|논문|분석|원리|문제|한계|취약|위험|오류|환각|편향|안전|탐지|보안|증류")),                   # 새로 발견한 문제
    (2, re.compile(r"해결|개선|막는|막아|방지|돕|진단|치료|신약|예측|줄여|줄인|높여|높인")),                                    # 문제 해결
    (2, re.compile(r"학생|교육|학교|수업|과학|우주|기후|날씨|의료|로봇|음성|번역|이미지|영상|음악|게임|스마트폰|딥페이크|저작권|코딩|수학|스포츠")),
    (2, re.compile(r"GPT|챗GPT|클로드|Claude|제미나이|Gemini|라마|Llama|딥시크|DeepSeek|미스트랄|큐원|Qwen|그록|Grok|엑사원|EXAONE|하이퍼클로바|소라|Sora|코파일럿|알파")),
    (1, re.compile(r"오픈AI|앤트로픽|구글|메타|엔비디아|마이크로소프트|MS|네이버|카카오|LG|삼성|애플|아마존|허깅페이스")),       # 주요 연구 기관
    (1, re.compile(r"모델")),
    (-3, re.compile(r"솔루션|B2B|고객사|기업용|비용|인재 선발|마케팅|영업|유통|협약|MOU|점유율|사업|수성|동맹|컨콜|계약서")),                                    # 기업 업무 이야기는 낮게
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (danggok-screens news)"})
    return urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")


def text(it, tag):
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", it, re.S)
    v = re.sub(r"<!\[CDATA\[|\]\]>", "", m.group(1)) if m else ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(html.unescape(v)))).strip()


def when(s):
    """RSS 날짜(RFC 822 또는 '2026-10-30 12:47:16')를 시각으로. 모르면 None."""
    try:
        d = email.utils.parsedate_to_datetime(s)
        return d if d.tzinfo else d.replace(tzinfo=KST)
    except (TypeError, ValueError):
        pass
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", s or "")
    return datetime.datetime(*map(int, m.groups()), tzinfo=KST) if m else None


def first_sentence(desc, title):
    """요약 첫 문장을 짧게. 기자 이름·괄호 설명은 뺀다."""
    s = re.sub(r"\([^)]{0,30}\)", "", desc)
    s = re.sub(r"^\[[^\]]*\]\s*|^.{0,20}기자\s*=\s*", "", s).strip()
    m = re.match(r"(.+?(?:다|요)\.)", s)
    s = (m.group(1) if m else s).strip()
    if not s or s[:12] == title[:12]:
        return ""
    return s if len(s) <= 90 else s[:88].rstrip() + "…"


def tokens(t):
    return set(re.findall(r"[A-Za-z0-9]+|[가-힣]{2,}", t))


def main(dry):
    now = datetime.datetime.now(KST)
    seen, cands = set(), []
    for name, url in SOURCES:
        try:
            x = get(url)
        except Exception as e:  # 한 매체가 안 돼도 나머지로 고른다
            print(f"  {name}: 받지 못함 ({e.__class__.__name__})")
            continue
        for it in re.findall(r"<item[ >].*?</item>", x, re.S):
            title, link = text(it, "title"), text(it, "link")
            if not title or not link or link in seen:
                continue
            seen.add(link)
            d = when(text(it, "pubDate") or text(it, "dc:date"))
            if not d or (now - d).total_seconds() > HOURS * 3600:
                continue
            if not AI.search(title) or DROP.search(title):
                continue
            score = sum(w for w, r in SCORE if r.search(title))
            cands.append({"title": title, "link": link, "source": name, "at": d,
                          "summary": first_sentence(text(it, "description"), title), "score": score})
    # 점수 높은 순, 같으면 최신 순. 같은 소식(제목 낱말이 절반 넘게 겹침)은 하나만
    cands.sort(key=lambda c: (-c["score"], -c["at"].timestamp()))
    picked = []
    for c in cands:
        if c["score"] < MIN_SCORE:
            break
        tc = tokens(c["title"])
        if any(len(tc & tokens(p["title"])) / max(1, min(len(tc), len(tokens(p["title"])))) > 0.5 for p in picked):
            continue
        picked.append(c)
        if len(picked) == PICK:
            break
    for c in cands[:20] if dry else picked:
        mark = "★" if c in picked else " "
        print(f"{mark} {c['score']:>2} {c['source']:<10} {c['at']:%m-%d %H:%M} {c['title'][:60]}")
    if dry:
        return
    if not picked:
        print("고를 기사가 없어 이전 목록을 그대로 둔다")
        return
    items = [{"id": hashlib.sha1(c["link"].encode()).hexdigest()[:10], "title": c["title"], "summary": c["summary"],
              "source": c["source"], "date": c["at"].astimezone(KST).strftime("%Y-%m-%d"), "link": c["link"]} for c in picked]
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if old.get("items") == items:
        print("바뀐 기사 없음")
        return
    OUT.write_text(json.dumps({"updatedAt": now.isoformat(timespec="seconds"), "items": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"AI 뉴스 {len(items)}건 → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
