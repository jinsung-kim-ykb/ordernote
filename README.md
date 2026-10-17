# 오더노트 데모 — 카톡 주문 → 배송표 자동화

식당 사장님이 카톡으로 보낸 비정형 주문 텍스트를 구조화해서
**배송표 엑셀 · 거래처 확인서 · 확인큐**를 한 번에 만드는 데모입니다 (웹 + CLI).
외부 연동(카카오·ERP·DB)은 없습니다.

## 웹 데모 (GitHub Pages)

`index.html` + `web/` 는 서버 없이 브라우저에서 도는 정적 사이트입니다.
주문 텍스트를 붙여넣고 **처리하기** → 결과 확인 → 엑셀/CSV/확인서 다운로드.

- **규칙 엔진**: 키 없이 바로 동작
- **LLM**: 화면에 Anthropic API 키 입력 (키는 저장되지 않고 브라우저에서 API로만 전송)
- 샘플 20건 그대로 돌리면 정답셋 비교(잘못 매칭 0건) 배지가 뜹니다

**Pages 켜기**: 저장소 Settings → Pages → Build and deployment → Source: *Deploy from a branch* →
Branch: 이 브랜치, 폴더 `/ (root)` → Save. 1~2분 뒤 `https://<사용자명>.github.io/playground_youtube/` 에서 열립니다.
(비공개 저장소는 GitHub 유료 플랜에서만 Pages 사용 가능)

**로컬에서 보기**: 저장소 폴더에서 `python3 -m http.server` → http://localhost:8000
(index.html 을 더블클릭으로 열면 데이터 파일을 못 읽습니다)

**claude.ai 링크 버전**: `python3 web/build_artifact.py <출력.html>` 로 단일 HTML을 만들어 Artifact로 게시합니다
(capabilities: `sample`, `downloads`). 이 버전은 API 키 없이 **보는 사람의 claude.ai 계정**으로 Claude를 호출하고
(주문 1건당 1회, 2건씩 동시), 파일은 claude.ai 저장 확인창으로 내려받습니다. `app.js` 가 `window.claude` 유무로 두 환경을 구분합니다.

웹 버전 로직(`web/core.js`)은 `ordernote/*.py` 를 그대로 옮긴 것이고, `node web/eval.test.cjs` 로 같은 정답셋을 검증합니다.
라이브러리(Anthropic SDK 번들, ExcelJS)는 CDN 없이 동작하도록 `web/vendor/` 에 포함했습니다.

## CLI 빠른 시작

```bash
pip install -r requirements.txt

# LLM 사용 (주문 1건당 호출 1회, 20건 병렬)
export LLM_API_KEY=sk-ant-...        # 선택: LLM_MODEL (기본 claude-opus-5-5)
python -m ordernote

# 키 없이 오프라인 규칙 엔진으로
python -m ordernote --engine rule

# 정답셋으로 품질 확인 (잘못 매칭이 있으면 exit 1)
python -m ordernote --eval data/expected.json
```

`--engine auto`(기본)는 `LLM_API_KEY`가 있으면 LLM, 없으면 규칙 엔진을 씁니다.

## 데모 시나리오 (3분)

1. **상황**: 밤 8시~11시, 사장님 단톡/개인톡으로 주문 20건이 들어옴 → `input/orders.txt`
   - 사투리("보내주이소", 땡초, 정구지, 상치), 약어("삼겹", "차돌"), 숫자 한글("한단", "열개")
   - "어제 거 그대로", "평소대로 근데 계란은 5판으로", "평소처럼, 상추는 빼고"
   - 일부러 애매한 주문: "고추 한봉", "다리살 10키로", "베이컨도 좀", 마스터에 없는 "바지락"
2. **실행**: `python -m ordernote --eval data/expected.json`
3. **결과** (규칙 엔진 기준 실측):
   ```
   총 주문      20건  (품목 65줄, 거래처 8곳)
   자동 처리    14/20건 = 70%   (라인 기준 59/65줄 = 91%)
   확인필요     주문 6건 / 6줄  → output/확인큐.csv
   처리 시간    0.05초
   잘못 매칭    0건
   ```
4. **보여줄 파일**
   - `output/배송표_20261018.xlsx` — 시트1 피킹리스트(품목별 합계), 시트2~ 거래처별. 확인필요 행은 노란색
   - `output/확인서/온달고깃집.txt` — 카톡에 그대로 붙여넣을 확인 문구
   - `output/확인큐.csv` — 사람이 볼 6줄만 (후보 품목 3개 + 사유)

## 처리 단계

| 단계 | 파일 | 내용 |
|---|---|---|
| 1. 파서 | `ordernote/parse.py` | `[거래처] [YYYY-MM-DD HH:MM]` + 본문 + `---` → `OrderMessage` |
| 2. 구조화 | `ordernote/extract.py` | 본문 + 직전 주문 + 품목 별칭 → `OrderLine`(품목명_원문, 규격, 수량, 단위, 납품일, 메모, 확신도). pydantic 검증, 실패 시 재시도 1회 후 확인필요 |
| 3. 매칭 | `ordernote/match.py` | 정확 일치 → 별칭 → rapidfuzz ≥85. 단위는 마스터 단위로 환산(근→kg 등), 안 떨어지면 확인필요 |
| 4. 출력 | `ordernote/export.py` | 엑셀 · 확인서 · 확인큐 |
| 5. 요약 | `ordernote/__main__.py` | 건수, 자동 처리율, 확인필요, 처리 시간, `--eval` 정답셋 비교 |

### "모르면 확인필요" 규칙
- 매칭 실패, 수량 불명확("좀", "넉넉히"), 확신도 < 0.7 → 확인필요
- 유사도 ≥85여도 **부분 문자열 관계**면 자동 확정 안 함 (`다리살` ⊂ `앞다리살` → 앞다리? 뒷다리? 닭다리?)
- 1·2위 후보 점수 차가 3점 미만이면 확인필요
- 단위 환산이 정수로 안 떨어지면 확인필요 (고춧가루 2근 = 1.2kg ≠ 1kg봉 × 정수)

## 데이터
- `data/items.csv` — 품목 50개 (채소 V, 육류 M, 공산품 P), 별칭은 `;` 구분
- `data/history.json` — 거래처 5곳 직전 주문 (`품목코드: 수량`)
- `input/orders.txt` — 샘플 주문 20건
- `data/expected.json` — 샘플 20건 정답셋 (`--eval`용)

상호·전화번호는 모두 가상입니다.

## 참고
- LLM 엔진은 Anthropic SDK의 구조화 출력(`messages.parse` + pydantic)을 쓰고, 거절 응답 시 서버 측 대체 모델(`fallbacks="default"`)로 넘어갑니다.
- 규칙 엔진은 키 없이 데모·회귀 테스트를 돌리기 위한 폴백입니다. 처음 보는 표현에는 LLM 엔진이 더 강합니다.
- 범위 밖: 카카오·ERP·DB 연동 (2주차)
