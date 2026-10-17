"""pydantic 스키마. LLM 출력과 규칙 엔진 출력 모두 여기를 통과한다."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class OrderMessage(BaseModel):
    순번: int
    거래처: str
    수신시각: datetime
    본문: str


class OrderLine(BaseModel):
    품목명_원문: str = Field(description="고객이 쓴 품목명 그대로. 직전 주문 복사 시에는 품목 마스터의 품목명")
    규격: Optional[str] = Field(default=None, description="메시지에 규격이 명시된 경우만 (예: 15kg, 1단)")
    수량: Optional[float] = Field(default=None, description="숫자. '좀/넉넉히'처럼 불명확하면 null")
    단위: Optional[str] = Field(default=None, description="고객이 쓴 단위 (단, 망, 근, 박스, kg, 판, 통, 봉, 개 ...)")
    납품일: Optional[str] = Field(default=None, description="YYYY-MM-DD")
    메모: Optional[str] = None
    확신도: float = Field(ge=0, le=1, description="이 줄 해석에 대한 확신 0~1")


class ExtractedOrder(BaseModel):
    lines: list[OrderLine]


class Item(BaseModel):
    품목코드: str
    품목명: str
    규격: str
    단위: str
    별칭: list[str]


class ResolvedLine(BaseModel):
    order: OrderMessage
    line: OrderLine
    item: Optional[Item] = None
    수량: Optional[float] = None
    단위: Optional[str] = None
    status: str  # "정상" | "확인필요"
    사유: str = ""
    후보: list[str] = []
