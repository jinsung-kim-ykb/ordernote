"""CLI: python -m ordernote [--engine auto|llm|rule] [--eval data/expected.json]"""
from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .export import write_confirmations, write_queue, write_xlsx
from .extract import make_extractor
from .match import Catalog, resolve
from .models import ExtractedOrder, OrderLine, OrderMessage, ResolvedLine
from .parse import load_history, load_items, parse_orders


def structure(extractor, order: OrderMessage) -> tuple[ExtractedOrder | None, str]:
    """1건당 호출 1회. 실패(검증 오류 포함) 시 1회 재시도 후 포기."""
    err = ""
    for _ in range(2):
        try:
            return extractor.extract(order), ""
        except Exception as e:  # pydantic ValidationError, API 오류, 거절 등
            err = f"{type(e).__name__}: {e}"[:200]
    return None, err


def run(args) -> int:
    t0 = time.perf_counter()
    catalog = Catalog(load_items(Path(args.items)))
    history = load_history(Path(args.history))
    orders = parse_orders(Path(args.orders))
    extractor = make_extractor(catalog, history, args.engine)

    t1 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(20, len(orders))) as pool:
        results = list(pool.map(lambda o: structure(extractor, o), orders))
    t_struct = time.perf_counter() - t1
    if orders and all(ext is None for ext, _ in results):
        print(f"\n!!! 주문 {len(orders)}건 모두 구조화 실패. 첫 오류: {results[0][1]}")
        print("!!! LLM 엔진이면 API 키·크레딧·모델명을 확인하세요. 아래 결과는 전부 '확인필요'로 나갑니다.")

    resolved: list[ResolvedLine] = []
    for order, (ext, err) in zip(orders, results):
        if ext is None:
            line = OrderLine(품목명_원문=order.본문.splitlines()[0], 확신도=0.0, 메모=err)
            resolved.append(ResolvedLine(order=order, line=line, status="확인필요", 사유="구조화 실패(재시도 1회 후)"))
            continue
        if not ext.lines:
            line = OrderLine(품목명_원문="(품목 없음)", 확신도=0.0)
            resolved.append(ResolvedLine(order=order, line=line, status="확인필요", 사유="주문 품목을 찾지 못함"))
        resolved.extend(resolve(order, l, catalog) for l in ext.lines)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dates = Counter(r.line.납품일 for r in resolved if r.line.납품일)
    stamp = (dates.most_common(1)[0][0] if dates else time.strftime("%Y-%m-%d")).replace("-", "")
    xlsx = out / f"배송표_{stamp}.xlsx"
    write_xlsx(resolved, xlsx)
    n_clients = write_confirmations(resolved, out / "확인서")
    n_queue = write_queue(resolved, out / "확인큐.csv")
    elapsed = time.perf_counter() - t0

    pending_orders = {r.order.순번 for r in resolved if r.status == "확인필요"}
    auto = len(orders) - len(pending_orders)
    ok_lines = sum(r.status == "정상" for r in resolved)
    print(f"\n=== 오더노트 처리 요약 (구조화 엔진: {extractor.name}) ===")
    print(f"총 주문      {len(orders)}건  (품목 {len(resolved)}줄, 거래처 {n_clients}곳)")
    print(f"자동 처리    {auto}/{len(orders)}건 = {auto / len(orders):.0%}   (라인 기준 {ok_lines}/{len(resolved)}줄 = {ok_lines / len(resolved):.0%})")
    print(f"확인필요     주문 {len(pending_orders)}건 / {n_queue}줄  → {out / '확인큐.csv'}")
    print(f"처리 시간    {elapsed:.2f}초  (구조화 {t_struct:.2f}초, 주문 {len(orders)}건 병렬)")
    print(f"출력         {xlsx}\n             {out / '확인서'}/ ({n_clients}개 거래처)")
    print("\n[확인필요]")
    for r in resolved:
        if r.status == "확인필요":
            cand = f"  후보: {', '.join(r.후보)}" if r.후보 else ""
            print(f"  #{r.order.순번:<2} {r.order.거래처:<7} {r.line.품목명_원문:<10} {r.사유}{cand}")

    if args.eval:
        return evaluate(resolved, orders, Path(args.eval))
    return 0


def evaluate(resolved: list[ResolvedLine], orders: list[OrderMessage], path: Path) -> int:
    """정답셋 대비 잘못 매칭(정상 처리됐는데 틀린 것)·누락을 센다."""
    gold = json.loads(path.read_text(encoding="utf-8"))
    wrong, missed, pending_diff = [], [], []
    for o in orders:
        g = gold[str(o.순번)]
        exp = {(c, float(q)) for c, q in g["정상"]}
        rs = [r for r in resolved if r.order.순번 == o.순번]
        got = {(r.item.품목코드, r.수량) for r in rs if r.status == "정상"}
        wrong += [(o.순번, x) for x in got - exp]
        missed += [(o.순번, x) for x in exp - got]
        n_pending = sum(r.status == "확인필요" for r in rs)
        if n_pending != g["확인필요"]:
            pending_diff.append((o.순번, n_pending, g["확인필요"]))
    print(f"\n=== 정답셋 비교 ({path}) ===")
    print(f"잘못 매칭    {len(wrong)}건 {wrong if wrong else ''}")
    print(f"누락(정답인데 자동처리 못함) {len(missed)}건 {missed if missed else ''}")
    print(f"확인필요 개수 불일치 {len(pending_diff)}건 {pending_diff if pending_diff else ''}")
    return 1 if wrong else 0


def main() -> None:
    p = argparse.ArgumentParser(prog="ordernote", description="카톡 주문 → 배송표 자동화 데모")
    p.add_argument("--orders", default="input/orders.txt")
    p.add_argument("--items", default="data/items.csv")
    p.add_argument("--history", default="data/history.json")
    p.add_argument("--out", default="output")
    p.add_argument("--engine", choices=["auto", "llm", "rule"], default="auto",
                   help="auto: LLM_API_KEY 있으면 LLM, 없으면 규칙 엔진")
    p.add_argument("--eval", help="정답셋 JSON 경로 (예: data/expected.json)")
    raise SystemExit(run(p.parse_args()))


if __name__ == "__main__":
    main()
