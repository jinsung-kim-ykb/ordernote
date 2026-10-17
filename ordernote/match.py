"""품목 매칭(정확 → 별칭 → 유사도) + 단위 정규화.

원칙: 모르면 확인필요. 유사도 매칭은 아래 경우 자동 확정하지 않는다.
  - 1·2위 후보 점수 차가 작을 때 (모호)
  - 한쪽이 다른 쪽의 부분 문자열일 때 ("다리살" ⊂ "앞다리살" → 앞다리/뒷다리/닭다리 중 무엇인지 모름)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from rapidfuzz import fuzz

from .models import Item, OrderLine, OrderMessage, ResolvedLine

FUZZY_THRESHOLD = 85
CONFIDENCE_THRESHOLD = 0.7
AMBIGUITY_GAP = 3
CANDIDATE_MIN = 60

UNIT_SYNONYMS = {
    "kg": "kg", "키로": "kg", "킬로": "kg", "키로그램": "kg", "킬로그램": "kg",
    "g": "g", "그램": "g", "근": "근",
    "단": "단", "망": "망", "판": "판", "개": "개", "포기": "포기", "마리": "마리", "병": "병", "팩": "팩",
    "박스": "박스", "상자": "박스", "빡스": "박스", "box": "박스",
    "통": "통", "말통": "통", "봉": "봉", "봉지": "봉", "포": "포", "포대": "포",
}
PARTICLES = ("으로", "은", "는", "이", "가", "도", "을", "를", "만", "요", "로")


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def strip_particle(s: str) -> str:
    for p in PARTICLES:
        if s.endswith(p) and len(s) > len(p):
            return s[: -len(p)]
    return s


def canonical_unit(u: Optional[str]) -> Optional[str]:
    if u is None:
        return None
    return UNIT_SYNONYMS.get(norm(u), norm(u))


@dataclass
class MatchResult:
    item: Optional[Item]
    how: str = ""
    reason: str = ""
    candidates: list[Item] = field(default_factory=list)


class Catalog:
    def __init__(self, items: list[Item]):
        self.items = items
        self.by_code = {i.품목코드: i for i in items}
        self.exact = {norm(i.품목명): i for i in items}
        self.alias: dict[str, list[Item]] = {}
        for i in items:
            for a in i.별칭:
                self.alias.setdefault(norm(a), []).append(i)
        self.keys = [(norm(i.품목명), i) for i in items] + [(norm(a), i) for i in items for a in i.별칭]

    def lookup_exact(self, name: str) -> Optional[Item]:
        m = self._exact_or_alias(name)
        return m.item if m else None

    def _exact_or_alias(self, name: str) -> Optional[MatchResult]:
        for q in dict.fromkeys([norm(name), strip_particle(norm(name))]):
            if q in self.exact:
                return MatchResult(self.exact[q], how="정확 일치")
            if q in self.alias:
                hits = self.alias[q]
                if len(hits) == 1:
                    return MatchResult(hits[0], how="별칭")
                return MatchResult(None, reason="별칭이 여러 품목에 해당", candidates=hits[:3])
        return None

    def candidates(self, name: str, k: int = 3) -> list[Item]:
        q = strip_particle(norm(name))
        best: dict[str, float] = {}
        for key, item in self.keys:
            s = fuzz.WRatio(q, key)
            best[item.품목코드] = max(best.get(item.품목코드, 0), s)
        ranked = sorted(best.items(), key=lambda kv: -kv[1])[:k]
        return [self.by_code[c] for c, s in ranked if s >= CANDIDATE_MIN]

    def match(self, name: str) -> MatchResult:
        hit = self._exact_or_alias(name)
        if hit:
            return hit
        q = strip_particle(norm(name))
        scored: dict[str, tuple[float, str]] = {}
        for key, item in self.keys:
            s = fuzz.ratio(q, key)
            if s > scored.get(item.품목코드, (0, ""))[0]:
                scored[item.품목코드] = (s, key)
        ranked = sorted(scored.items(), key=lambda kv: -kv[1][0])
        if not ranked:
            return MatchResult(None, reason="품목 마스터에 없음")
        top_code, (top_score, top_key) = ranked[0]
        second = ranked[1][1][0] if len(ranked) > 1 else 0
        cands = self.candidates(name)
        if top_score < FUZZY_THRESHOLD:
            reason = "품목 특정 불가(후보 중 선택 필요)" if cands else "품목 마스터에 없음"
            return MatchResult(None, reason=reason, candidates=cands)
        if q in top_key or top_key in q:
            return MatchResult(None, reason=f"품목명 일부만 일치('{name}' ↔ '{top_key}')", candidates=cands)
        if top_score - second < AMBIGUITY_GAP:
            return MatchResult(None, reason="유사 후보 다수(모호)", candidates=cands)
        return MatchResult(self.by_code[top_code], how=f"유사도 {top_score:.0f}")


def _spec_kg(spec: str) -> Optional[float]:
    m = re.fullmatch(r"([\d.]+)\s*(kg|g)", spec.lower())
    if not m:
        return None
    v = float(m[1])
    return v if m[2] == "kg" else v / 1000


def convert(qty: float, unit: Optional[str], item: Item) -> Optional[float]:
    """주문 단위 → 품목 마스터 단위. 정확히 떨어지지 않으면 None(=확인필요)."""
    unit = canonical_unit(unit)
    if unit is None or unit == item.단위:
        return qty
    if unit == "kg":
        kg = qty
    elif unit == "g":
        kg = qty / 1000
    elif unit == "근":
        # 육류·고춧가루는 1근=600g, 채소는 1근=375g
        kg = qty * (0.6 if item.품목코드.startswith("M") or item.품목명 == "고춧가루" else 0.375)
    else:
        return None
    if item.단위 == "kg":
        return round(kg, 3)
    spec = _spec_kg(item.규격)
    if spec:
        n = kg / spec
        if abs(n - round(n)) < 1e-6:
            return float(round(n))
    return None


def resolve(order: OrderMessage, line: OrderLine, catalog: Catalog) -> ResolvedLine:
    m = catalog.match(line.품목명_원문)
    cands = [f"{c.품목코드} {c.품목명}" for c in m.candidates]
    base = dict(order=order, line=line, 후보=cands)
    if m.item is None:
        return ResolvedLine(**base, status="확인필요", 사유=m.reason)
    item = m.item
    base.update(item=item, 후보=cands or [f"{item.품목코드} {item.품목명}"])
    if line.수량 is None or line.수량 <= 0:
        return ResolvedLine(**base, status="확인필요", 사유="수량 불명확")
    qty = convert(line.수량, line.단위, item)
    if qty is None:
        return ResolvedLine(**base, 수량=line.수량, 단위=line.단위, status="확인필요",
                            사유=f"단위 환산 불가({line.수량:g}{line.단위}→{item.단위}, 규격 {item.규격})")
    if line.확신도 < CONFIDENCE_THRESHOLD:
        return ResolvedLine(**base, 수량=qty, 단위=item.단위, status="확인필요", 사유=f"확신도 낮음({line.확신도:.2f})")
    return ResolvedLine(**base, 수량=qty, 단위=item.단위, status="정상", 사유=m.how)
