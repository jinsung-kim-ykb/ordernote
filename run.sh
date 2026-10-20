#!/usr/bin/env bash
# 오더노트 데모 실행기 (Mac / Linux)
#   터미널에서:  bash run.sh              → 샘플 주문 20건 처리
#              bash run.sh 내주문.txt     → 그 파일을 처리
# 처음 한 번은 .venv 를 만들고 패키지를 설치합니다(1~2분). 그 다음부터는 바로 실행됩니다.
set -u
cd "$(dirname "$0")" || exit 1

py_ok() { "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; }

find_python() {
  local c
  for c in python3.13 python3.12 python3.11 python3 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    # 맥에서 /usr/bin/python3 는 개발자 도구가 없으면 설치 안내창만 띄우는 껍데기라 건너뛴다
    if [ "$(uname -s)" = "Darwin" ] && [ "$(command -v "$c")" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then
      continue
    fi
    if py_ok "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

echo "=== 오더노트 데모 ==="
PY="$(find_python)" || {
  cat <<'EOF'
Python 3.11 이상이 없습니다.
  Mac:   https://www.python.org/downloads/macos/ 에서 "macOS 64-bit universal2 installer" (3.12 또는 3.13) 받아 설치
         → 설치 후 터미널 창을 닫았다가 새로 열고 다시 실행
  Linux: sudo apt install python3 python3-venv   (Ubuntu/Debian)
EOF
  exit 1
}
echo "Python $("$PY" -c 'import sys; print(sys.version.split()[0])') 사용"

if [ ! -x ".venv/bin/python" ]; then
  echo "가상환경 만드는 중 ..."
  "$PY" -m venv .venv || { echo "가상환경 생성 실패. Ubuntu/Debian이면: sudo apt install python3-venv"; exit 1; }
fi
VPY=".venv/bin/python"
if [ ! -f ".venv/.deps-ok" ]; then
  echo "패키지 설치 중 (openpyxl, pydantic, rapidfuzz, anthropic) ..."
  "$VPY" -m pip install --disable-pip-version-check -q -r requirements.txt || { echo "패키지 설치 실패. 위 메시지를 복사해서 Claude에게 보내주세요."; exit 1; }
  echo ok > ".venv/.deps-ok"
fi

if [ -n "${LLM_API_KEY:-}" ]; then
  echo "LLM_API_KEY 가 설정되어 있어 LLM 엔진으로 실행합니다."
elif [ -t 0 ]; then
  echo
  echo "LLM 엔진을 쓰려면 Anthropic API 키(sk-ant-...)를 붙여넣고 Enter."
  echo "그냥 Enter 를 누르면 키 없이 규칙 엔진으로 실행합니다."
  read -r -p "LLM_API_KEY: " LLM_API_KEY
  export LLM_API_KEY
fi

echo
if [ $# -eq 0 ]; then
  "$VPY" -m ordernote --eval data/expected.json
else
  "$VPY" -m ordernote --orders "$1"
fi
RC=$?
echo
if [ "$RC" -eq 0 ]; then
  echo "완료. 결과는 output/ 폴더에 있습니다."
  [ "$(uname -s)" = "Darwin" ] && open output 2>/dev/null
else
  echo "종료 코드 $RC — 위 메시지를 확인하세요."
fi
exit "$RC"
