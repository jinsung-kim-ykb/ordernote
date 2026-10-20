"""orders.txt / items.csv / history.json 로더."""
from __future__ import annotations

import csv
import json
import re
from datetime import datetime
from pathlib import Path

from .models import Item, OrderMessage

HEADER_RE = re.compile(r"^\[(?P<client>[^\]]+)\]\s*\[(?P<ts>[^\]]+)\]\s*$")


def read_text_tolerant(path: Path) -> str:
    """UTF-8(BOM 포함) 우선, 안 되면 cp949(윈도우 메모장 'ANSI')로 읽는다."""
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp949")


def parse_orders(path: Path) -> list[OrderMessage]:
    orders: list[OrderMessage] = []
    for block in re.split(r"^---\s*$", read_text_tolerant(path), flags=re.M):
        lines = [l for l in block.strip().splitlines() if l.strip()]
        if not lines:
            continue
        m = HEADER_RE.match(lines[0].strip())
        if not m:
            raise ValueError(f"주문 헤더 형식 오류: {lines[0]!r}")
        orders.append(OrderMessage(
            순번=len(orders) + 1,
            거래처=m["client"].strip(),
            수신시각=datetime.strptime(m["ts"].strip(), "%Y-%m-%d %H:%M"),
            본문="\n".join(lines[1:]).strip(),
        ))
    return orders


def load_items(path: Path) -> list[Item]:
    with path.open(encoding="utf-8") as f:
        return [
            Item(
                품목코드=r["품목코드"], 품목명=r["품목명"], 규격=r["규격"], 단위=r["단위"],
                별칭=[a.strip() for a in r["별칭"].split(";") if a.strip()],
            )
            for r in csv.DictReader(f)
        ]


def load_history(path: Path) -> dict[str, dict[str, float]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {client: v["품목"] for client, v in raw.items()}
