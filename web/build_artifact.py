"""claude.ai Artifact용 단일 HTML 생성.

    python3 web/build_artifact.py <출력.html>

index.html 본문 + web/style.css + web/core.js + web/app.js + 샘플 데이터를 한 파일로 합친다.
Artifact는 문서 뼈대(doctype/head/body)를 자동으로 씌우므로 본문만 넣고, 외부 스크립트는
허용된 CDN(jsDelivr)에서만 불러온다. LLM 호출·파일 저장은 app.js가 window.claude 기능으로 처리한다.
배포: Artifact 도구에 출력 파일을 publish, capabilities={"sample": {}, "downloads": True}.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCELJS_CDN = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def inline_safe(code: str) -> str:
    if "</script" in code.lower():
        raise ValueError("인라인 스크립트에 </script 가 들어 있음")
    return code


def build() -> str:
    html = read("index.html")
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = re.sub(r'\s*<script[^>]*src="web/[^"]+"[^>]*></script>', "", body)
    config = {
        "exceljs": EXCELJS_CDN,
        "data": {
            "items": read("data/items.csv"),
            "history": read("data/history.json"),
            "orders": read("input/orders.txt"),
            "expected": read("data/expected.json"),
        },
    }
    config_js = "window.ORDERNOTE_CONFIG = " + json.dumps(config, ensure_ascii=False).replace("</", "<\\/") + ";"
    return (
        "<title>오더노트 데모</title>\n"
        '<meta name="claude:viewport-fit-sides" content="cover">\n'
        f"<style>\n{read('web/style.css')}\n</style>\n"
        f"{body.strip()}\n"
        f"<script>{config_js}</script>\n"
        + "".join(f"<script>\n{inline_safe(read(f'web/{m}.js'))}\n</script>\n" for m in ("core", "kakao", "store"))
        + f'<script type="module">\n{inline_safe(read("web/app.js"))}\n</script>\n'
    )


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/ordernote_artifact.html")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(), encoding="utf-8")
    print(f"{out} ({out.stat().st_size / 1024:.0f} KB)")
