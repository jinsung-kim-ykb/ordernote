#!/usr/bin/env bash
# 오더노트 CLI 실행기 (Mac / Linux)
#   터미널에서:  bash run-mac.sh              → 샘플 주문 20건 처리
#              bash run-mac.sh 내주문.txt     → 그 파일을 처리
# 처음 한 번은 .venv 를 만들고 패키지를 설치합니다(1~3분). 그 다음부터는 바로 실행됩니다.
set -u
cd "$(dirname "$0")" || { echo "폴더에 들어갈 수 없습니다. '터미널이 다운로드 폴더에 접근하려고 합니다' 창이 떴다면 '허용'을 누르고 다시 실행하세요."; exit 1; }
if [ ! -f requirements.txt ]; then
  echo "이 파일은 압축을 푼 폴더 안에서 실행해야 합니다 (requirements.txt 가 같은 폴더에 있어야 함)."
  exit 1
fi

py_ok() { "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; }

find_python() {
  local c
  for c in python3.15 python3.14 python3.13 python3.12 python3.11 python3 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    # 맥에서 /usr/bin/python3 는 개발자 도구가 없으면 설치 안내창만 띄우는 껍데기라 건너뛴다
    if [ "$(uname -s)" = "Darwin" ] && [ "$(command -v "$c")" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then
      continue
    fi
    if py_ok "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

echo "=== 오더노트 CLI ==="
PY="$(find_python)" || {
  cat <<'EOF'
Python 3.11 이상이 없습니다.
  Mac:   https://www.python.org/downloads/ 에서 노란 "Download Python 3.x.x" 버튼 (3.11 이상 아무 버전, alpha/beta 제외)
         → 설치 후 터미널 창을 닫았다가 새로 열고 다시 실행 (설치 끝에 뜨는 Finder 창은 닫아도 됩니다)
  Linux: sudo apt install python3 python3-venv   (Ubuntu 22.04 이하는 python3.12 python3.12-venv)
EOF
  exit 1
}
echo "Python $("$PY" -c 'import sys; print(sys.version.split()[0])') 사용"

if [ ! -x .venv/bin/python ] || ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  rm -rf .venv
  echo "가상환경 만드는 중 ..."
  "$PY" -m venv .venv || { rm -rf .venv; echo "가상환경 생성 실패. Ubuntu/Debian이면: sudo apt install python3-venv"; exit 1; }
fi
VPY=".venv/bin/python"
if [ ! -f ".venv/.deps-ok" ]; then
  echo "패키지 설치 중 (openpyxl, pydantic, rapidfuzz, anthropic) — 처음 한 번만 1~3분 걸립니다 ..."
  "$VPY" -m pip install --disable-pip-version-check -r requirements.txt || { echo "패키지 설치 실패. 위 메시지를 복사해서 Claude에게 보내주세요."; exit 1; }
  echo ok > ".venv/.deps-ok"
fi

if [ -n "${LLM_API_KEY:-}" ]; then
  echo "LLM_API_KEY 가 설정되어 있어 AI 엔진으로 실행합니다."
elif [ -t 0 ]; then
  echo
  echo "AI(Claude) 엔진을 쓰려면 Anthropic API 키(sk-ant-...)를 붙여넣고 Enter."
  echo "그냥 Enter 를 누르면 키 없이 기본 방식(규칙 엔진)으로 실행합니다."
  read -r -p "LLM_API_KEY: " LLM_API_KEY
  LLM_API_KEY=${LLM_API_KEY//[$'\r\t "']/}
  export LLM_API_KEY
  case "$LLM_API_KEY" in
    "" | sk-ant-*) ;;
    *) echo "주의: 키가 sk-ant- 로 시작하지 않습니다. 호출이 실패할 수 있습니다." ;;
  esac
fi

echo
if [ $# -eq 0 ]; then
  "$VPY" -m ordernote --eval data/expected.json
else
  echo "처리할 파일: $1"
  "$VPY" -m ordernote --orders "$1"
fi
RC=$?
echo
if [ "$RC" -eq 0 ]; then
  echo "완료. 결과는 $(pwd)/output 에 있습니다."
elif [ "$RC" -eq 1 ] && [ -f output/확인큐.csv ]; then
  echo "처리는 끝났지만 정답셋과 다르게 처리된 건이 있습니다(위 '잘못 매칭' 줄 참고). 결과는 $(pwd)/output 에 있습니다."
else
  echo "종료 코드 $RC — 위 메시지를 확인하세요."
fi
[ -d output ] && [ "$(uname -s)" = "Darwin" ] && open output 2>/dev/null
exit "$RC"
