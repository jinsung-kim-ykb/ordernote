"""구조화 단계: 주문 본문 → ExtractedOrder.

- LLMExtractor: LLM_API_KEY가 있으면 사용. 주문 1건당 호출 1회, pydantic 스키마로 검증.
- RuleExtractor: 키가 없을 때의 오프라인 폴백(데모·회귀 테스트용). 같은 스키마를 출력한다.
"""
from __future__ import annotations

import os
import re
from datetime import timedelta

from .match import Catalog, canonical_unit, strip_particle
from .models import ExtractedOrder, OrderLine, OrderMessage

HISTORY_MEMO = "직전 주문 참조"
HISTORY_CUES = re.compile(r"어제\s*(거|꺼|것)|평소|그대로|지난번|똑같이|늘\s*하던")


def delivery_date(order: OrderMessage) -> str:
    days = 2 if "모레" in order.본문 else 1
    return (order.수신시각.date() + timedelta(days=days)).isoformat()


def history_lines(order: OrderMessage, history: dict, catalog: Catalog) -> list[OrderLine]:
    hist = history.get(order.거래처)
    if not hist:
        return [OrderLine(품목명_원문="(직전 주문)", 메모="직전 주문 기록 없음", 확신도=0.0)]
    date = delivery_date(order)
    return [
        OrderLine(품목명_원문=catalog.by_code[c].품목명, 수량=q, 단위=catalog.by_code[c].단위,
                  납품일=date, 메모=HISTORY_MEMO, 확신도=0.95)
        for c, q in hist.items()
    ]


# ---------------------------------------------------------------- LLM

SYSTEM_PROMPT = """너는 식자재 유통사의 주문 접수 담당이다. 식당 사장님이 카카오톡으로 보낸 주문 메시지를 주문 라인으로 구조화한다.

규칙
- 품목 하나당 한 줄. 품목명_원문은 고객이 쓴 표현 그대로 적는다(사투리·약어 포함). 품목 마스터 이름으로 바꾸지 않는다. 매칭은 별도 시스템이 한다.
- 수량은 숫자로 적는다(한→1, 두→2, 열→10). '좀', '넉넉히'처럼 수량이 불명확하면 수량은 null, 확신도는 0.5 미만.
- 단위는 고객이 쓴 단위 그대로 적는다(키로·킬로만 kg로). 환산하지 않는다.
- "어제 거 그대로", "평소대로", "지난번처럼"처럼 직전 주문을 가리키면, 아래 [직전 주문]의 품목을 모두 넣는다. 이때 품목명_원문은 [직전 주문]에 적힌 품목명, 메모는 "직전 주문 참조". 같은 메시지 안의 수량 변경·추가·제외 지시를 반영한다. [직전 주문]이 없으면 품목명_원문 "(직전 주문)", 수량 null, 확신도 0 인 한 줄만 넣는다.
- "아까 거에 추가"처럼 당일 추가 주문이면 직전 주문을 복사하지 말고 추가 품목만 넣는다.
- 인사말, "~말고"처럼 부정된 품목은 넣지 않는다.
- 납품일: '모레'면 수신일+2일, 그 외('내일', '낼', 언급 없음)는 기본 납품일.
- 확신도: 품목과 수량이 명확하면 0.9 이상. 무엇을 가리키는지 애매하면 0.7 미만."""


class LLMExtractor:
    name = "LLM"

    def __init__(self, catalog: Catalog, history: dict):
        import anthropic

        self.client = anthropic.Anthropic(api_key=os.environ["LLM_API_KEY"], max_retries=2, timeout=25)
        self.model = os.environ.get("LLM_MODEL", "claude-opus-5-5")
        self.catalog = catalog
        self.history = history
        self.catalog_text = "\n".join(
            f"- {i.품목명} | 규격 {i.규격} | 단위 {i.단위}" + (f" | 별칭 {', '.join(i.별칭)}" if i.별칭 else "")
            for i in catalog.items
        )

    def _prompt(self, order: OrderMessage) -> str:
        hist = self.history.get(order.거래처)
        hist_text = "\n".join(
            f"- {self.catalog.by_code[c].품목명} {q:g}{self.catalog.by_code[c].단위}" for c, q in hist.items()
        ) if hist else "없음"
        return (
            f"거래처: {order.거래처}\n수신시각: {order.수신시각:%Y-%m-%d %H:%M}\n기본 납품일: {delivery_date(order)}\n\n"
            f"[직전 주문]\n{hist_text}\n\n[품목 마스터(참고용)]\n{self.catalog_text}\n\n[메시지]\n{order.본문}"
        )

    def extract(self, order: OrderMessage) -> ExtractedOrder:
        resp = self.client.beta.messages.parse(
            model=self.model,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": self._prompt(order)}],
            output_format=ExtractedOrder,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal" or resp.parsed_output is None:
            raise ValueError(f"LLM 응답 없음(stop_reason={resp.stop_reason})")
        # 파싱 헬퍼가 이미 검증했지만, 스키마 제약(확신도 0~1 등)을 한 번 더 강제한다.
        return ExtractedOrder.model_validate(resp.parsed_output.model_dump())


# ---------------------------------------------------------------- 규칙 엔진

NUM_WORDS = {"한": 1, "하나": 1, "두": 2, "둘": 2, "세": 3, "셋": 3, "석": 3, "네": 4, "넷": 4, "다섯": 5,
             "여섯": 6, "일곱": 7, "여덟": 8, "아홉": 9, "열": 10, "스무": 20}
UNITS = "kg|KG|Kg|키로그램|킬로그램|키로|킬로|근|포기|포대|포|단|망|박스|상자|빡스|판|말통|통|봉지|봉|개|마리|병|팩"
QTY_RE = re.compile(
    rf"(?P<name>[가-힣A-Za-z]+(?:\s+[가-힣A-Za-z]+)?)\s*"
    rf"(?P<num>\d+(?:\.\d+)?|{'|'.join(sorted(NUM_WORDS, key=len, reverse=True))})\s*(?P<unit>{UNITS})"
)
VAGUE_RE = re.compile(r"좀|넉넉히|적당히|조금|많이|약간")
SEGMENT_RE = re.compile(r"[,\n.]|그리고|근데")


class RuleExtractor:
    name = "기본(규칙)"

    def __init__(self, catalog: Catalog, history: dict):
        self.catalog = catalog
        self.history = history

    def _name(self, raw: str) -> str:
        words = raw.split()
        if len(words) == 2 and self.catalog.lookup_exact("".join(words)):
            return "".join(words)
        return words[-1]

    def extract(self, order: OrderMessage) -> ExtractedOrder:
        date = delivery_date(order)
        memo = "; ".join(re.findall(r"\(([^)]*)\)", order.본문)) or None
        body = re.sub(r"\([^)]*\)", " ", order.본문)

        lines: dict[str, OrderLine] = {}
        if HISTORY_CUES.search(body):
            for l in history_lines(order, self.history, self.catalog):
                item = self.catalog.lookup_exact(l.품목명_원문)
                lines[item.품목코드 if item else l.품목명_원문] = l

        for seg in (s.strip() for s in SEGMENT_RE.split(body)):
            if not seg:
                continue
            matches = list(QTY_RE.finditer(seg))
            for m in matches:
                name = self._name(m["name"])
                num = m["num"]
                qty = float(num) if num[0].isdigit() else float(NUM_WORDS[num])
                item = self.catalog.lookup_exact(name)
                key = item.품목코드 if item else name
                prev = lines.get(key)
                line_memo = f"{HISTORY_MEMO}(수량 변경)" if prev and prev.메모 == HISTORY_MEMO else memo
                lines[key] = OrderLine(품목명_원문=name, 수량=qty, 단위=canonical_unit(m["unit"]),
                                       납품일=date, 메모=line_memo, 확신도=0.9)
            if matches:
                continue
            if "빼" in seg:
                for tok in seg.split():
                    item = self.catalog.lookup_exact(tok)
                    if item:
                        lines.pop(item.품목코드, None)
            elif VAGUE_RE.search(seg):
                toks = [t for t in seg.split() if not VAGUE_RE.fullmatch(t)]
                if toks:
                    name = strip_particle(toks[0])
                    lines[name] = OrderLine(품목명_원문=name, 납품일=date, 메모="수량 불명확", 확신도=0.3)
        return ExtractedOrder(lines=list(lines.values()))


def make_extractor(catalog: Catalog, history: dict, engine: str = "auto"):
    if engine == "llm" or (engine == "auto" and os.environ.get("LLM_API_KEY")):
        return LLMExtractor(catalog, history)
    return RuleExtractor(catalog, history)
