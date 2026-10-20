/* 오더노트 처리 로직 (ordernote/*.py 의 브라우저 포팅).
 * parse → 구조화(규칙 엔진) → 매칭/단위 정규화 → 확인서·확인큐 문자열.
 * 브라우저에서는 window.OrderNote, Node에서는 require()로 쓴다. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ parse.py
  const HEADER_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*$/;
  const TS_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/;

  function parseOrders(text) {
    const orders = [];
    for (const block of text.replace(/\r\n?/g, "\n").split(/^---\s*$/m)) {
      const lines = block.trim().split("\n").filter((l) => l.trim());
      if (!lines.length) continue;
      const m = lines[0].trim().match(HEADER_RE);
      if (!m) throw new Error(`주문 헤더 형식 오류: "${lines[0]}" — [거래처명] [YYYY-MM-DD HH:MM] 형식이어야 합니다`);
      const t = m[2].trim().match(TS_RE);
      if (!t) throw new Error(`수신시각 형식 오류: "${m[2]}" — YYYY-MM-DD HH:MM 형식이어야 합니다`);
      orders.push({
        순번: orders.length + 1,
        거래처: m[1].trim(),
        수신시각: { y: +t[1], mo: +t[2], d: +t[3], h: +t[4], mi: +t[5], text: `${t[1]}-${t[2]}-${t[3]} ${t[4].padStart(2, "0")}:${t[5]}` },
        본문: lines.slice(1).join("\n").trim(),
      });
    }
    return orders;
  }

  /** RFC 4180 CSV → 행 배열 (따옴표 안 쉼표·줄바꿈·"" 허용) */
  function parseCsvRows(text) {
    const rows = [];
    let row = [], field = "", q = false;
    const src = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim()));
  }

  function loadItems(csvText) {
    const rows = parseCsvRows(csvText);
    const header = rows[0].map((h) => h.trim());
    return rows.slice(1).map((cols) => {
      const rec = Object.fromEntries(header.map((h, i) => [h, (cols[i] || "").trim()]));
      return {
        품목코드: rec["품목코드"], 품목명: rec["품목명"], 규격: rec["규격"], 단위: rec["단위"],
        별칭: rec["별칭"].split(";").map((a) => a.trim()).filter(Boolean),
      };
    });
  }

  function loadHistory(json) {
    return Object.fromEntries(Object.entries(json).map(([client, v]) => [client, v["품목"]]));
  }

  // ------------------------------------------------------------ match.py
  const FUZZY_THRESHOLD = 85;
  const CONFIDENCE_THRESHOLD = 0.7;
  const AMBIGUITY_GAP = 3;
  const CANDIDATE_MIN = 60;

  const UNIT_SYNONYMS = {
    kg: "kg", 키로: "kg", 킬로: "kg", 키로그램: "kg", 킬로그램: "kg",
    g: "g", 그램: "g", 근: "근",
    단: "단", 망: "망", 판: "판", 개: "개", 포기: "포기", 마리: "마리", 병: "병", 팩: "팩",
    박스: "박스", 상자: "박스", 빡스: "박스", box: "박스",
    통: "통", 말통: "통", 봉: "봉", 봉지: "봉", 포: "포", 포대: "포",
  };
  const PARTICLES = ["으로", "은", "는", "이", "가", "도", "을", "를", "만", "요", "로"];

  const norm = (s) => s.replace(/\s+/g, "").toLowerCase();

  function stripParticle(s) {
    for (const p of PARTICLES) if (s.endsWith(p) && s.length > p.length) return s.slice(0, -p.length);
    return s;
  }

  function canonicalUnit(u) {
    if (u == null) return null;
    const n = norm(u);
    return UNIT_SYNONYMS[n] || n;
  }

  // rapidfuzz fuzz.ratio = 2·LCS / (|a|+|b|) × 100 (Indel 정규화 유사도)
  function lcs(a, b) {
    const A = [...a], B = [...b];
    let prev = new Array(B.length + 1).fill(0);
    for (let i = 1; i <= A.length; i++) {
      const cur = new Array(B.length + 1).fill(0);
      for (let j = 1; j <= B.length; j++) cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    return prev[B.length];
  }
  function ratio(a, b) {
    const la = [...a].length, lb = [...b].length;
    if (!la && !lb) return 100;
    return (200 * lcs(a, b)) / (la + lb);
  }
  function partialRatio(a, b) {
    let [s, l] = [...a].length <= [...b].length ? [[...a], [...b]] : [[...b], [...a]];
    if (!s.length) return 0;
    let best = 0;
    const L = s.join("");
    for (let k = 1; k < s.length; k++) {
      best = Math.max(best, ratio(L, l.slice(0, k).join("")), ratio(L, l.slice(l.length - k).join("")));
    }
    for (let i = 0; i + s.length <= l.length; i++) best = Math.max(best, ratio(L, l.slice(i, i + s.length).join("")));
    return best;
  }
  // 공백 없는 단일 토큰 기준 rapidfuzz WRatio 근사 (후보 추천용)
  function wratio(a, b) {
    const la = [...a].length, lb = [...b].length;
    if (!la || !lb) return 0;
    const lenRatio = Math.max(la, lb) / Math.min(la, lb);
    const r = ratio(a, b);
    if (lenRatio < 1.5) return r;
    return Math.max(r, partialRatio(a, b) * (lenRatio < 8 ? 0.9 : 0.6));
  }

  class Catalog {
    /** clientAliases: { 거래처명: { 별칭(정규화): 품목코드 } } — 전체 별칭보다 우선 */
    constructor(items, clientAliases = {}) {
      this.clientAliases = clientAliases;
      this.items = items;
      this.byCode = Object.fromEntries(items.map((i) => [i.품목코드, i]));
      this.exact = Object.fromEntries(items.map((i) => [norm(i.품목명), i]));
      this.alias = {};
      for (const i of items) for (const a of i.별칭) (this.alias[norm(a)] ||= []).push(i);
      this.keys = [
        ...items.map((i) => [norm(i.품목명), i]),
        ...items.flatMap((i) => i.별칭.map((a) => [norm(a), i])),
      ];
    }

    lookupExact(name) {
      const m = this._exactOrAlias(name);
      return m ? m.item : null;
    }

    _exactOrAlias(name) {
      for (const q of new Set([norm(name), stripParticle(norm(name))])) {
        if (this.exact[q]) return { item: this.exact[q], how: "정확 일치", reason: "", candidates: [] };
        const hits = this.alias[q];
        if (hits) {
          if (hits.length === 1) return { item: hits[0], how: "별칭", reason: "", candidates: [] };
          return { item: null, how: "", reason: "별칭이 여러 품목에 해당", candidates: hits.slice(0, 3) };
        }
      }
      return null;
    }

    candidates(name, k = 3) {
      const q = stripParticle(norm(name));
      const best = new Map();
      for (const [key, item] of this.keys) best.set(item.품목코드, Math.max(best.get(item.품목코드) || 0, wratio(q, key)));
      return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
        .filter(([, s]) => s >= CANDIDATE_MIN).map(([c]) => this.byCode[c]);
    }

    match(name, client = null) {
      const ca = client && this.clientAliases[client];
      if (ca) {
        for (const q of new Set([norm(name), stripParticle(norm(name))])) {
          if (ca[q] && this.byCode[ca[q]]) return { item: this.byCode[ca[q]], how: "거래처 별칭", reason: "", candidates: [] };
        }
      }
      const hit = this._exactOrAlias(name);
      if (hit) return hit;
      const q = stripParticle(norm(name));
      const scored = new Map();
      for (const [key, item] of this.keys) {
        const s = ratio(q, key);
        if (s > (scored.get(item.품목코드) || [0])[0]) scored.set(item.품목코드, [s, key]);
      }
      const ranked = [...scored.entries()].sort((a, b) => b[1][0] - a[1][0]);
      const cands = this.candidates(name);
      const [topCode, [topScore, topKey]] = ranked[0] || [null, [0, ""]];
      const second = ranked[1] ? ranked[1][1][0] : 0;
      if (topScore < FUZZY_THRESHOLD) {
        const reason = cands.length ? "품목 특정 불가(후보 중 선택 필요)" : "품목 마스터에 없음";
        return { item: null, how: "", reason, candidates: cands };
      }
      if (topKey.includes(q) || q.includes(topKey)) {
        return { item: null, how: "", reason: `품목명 일부만 일치('${name}' ↔ '${topKey}')`, candidates: cands };
      }
      if (topScore - second < AMBIGUITY_GAP) return { item: null, how: "", reason: "유사 후보 다수(모호)", candidates: cands };
      return { item: this.byCode[topCode], how: `유사도 ${Math.round(topScore)}`, reason: "", candidates: [] };
    }
  }

  const fmtNum = (n) => String(Math.round(n * 1000) / 1000);

  function specKg(spec) {
    const m = spec.toLowerCase().match(/^([\d.]+)\s*(kg|g)$/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return m[2] === "kg" ? v : v / 1000;
  }

  /** 주문 단위 → 품목 마스터 단위. 정확히 떨어지지 않으면 null(=확인필요). */
  function convert(qty, unit, item) {
    unit = canonicalUnit(unit);
    if (unit == null || unit === item.단위) return qty;
    // 담당자가 확인 큐에서 기억시킨 품목별 환산('1박스 = 10kg')이 있으면 그것을 먼저 쓴다
    if (item.환산 && item.환산[unit] > 0) return Math.round(qty * item.환산[unit] * 1000) / 1000;
    let kg;
    if (unit === "kg") kg = qty;
    else if (unit === "g") kg = qty / 1000;
    // 육류·고춧가루는 1근=600g, 채소는 1근=375g
    else if (unit === "근") kg = qty * (item.품목코드.startsWith("M") || item.품목명 === "고춧가루" ? 0.6 : 0.375);
    else return null;
    if (item.단위 === "kg") return Math.round(kg * 1000) / 1000;
    const spec = specKg(item.규격);
    if (spec) {
      const n = kg / spec;
      if (Math.abs(n - Math.round(n)) < 1e-6) return Math.round(n);
    }
    return null;
  }

  function resolve(order, line, catalog) {
    const m = catalog.match(line.품목명_원문, order.거래처);
    const base = { order, line, item: null, 수량: null, 단위: null, 후보: m.candidates.map((c) => `${c.품목코드} ${c.품목명}`) };
    if (!m.item) return { ...base, status: "확인필요", 사유: m.reason };
    const item = m.item;
    Object.assign(base, { item, 후보: base.후보.length ? base.후보 : [`${item.품목코드} ${item.품목명}`] });
    if (line.수량 == null || line.수량 <= 0) return { ...base, status: "확인필요", 사유: "수량 불명확" };
    const qty = convert(line.수량, line.단위, item);
    if (qty == null) {
      return { ...base, 수량: line.수량, 단위: line.단위, status: "확인필요",
        사유: `단위 환산 불가(${fmtNum(line.수량)}${line.단위}→${item.단위}, 규격 ${item.규격})` };
    }
    if (line.확신도 < CONFIDENCE_THRESHOLD) {
      const why = line.메모 && /확인$/.test(line.메모) ? line.메모 : `확신도 낮음(${line.확신도.toFixed(2)})`;
      return { ...base, 수량: qty, 단위: item.단위, status: "확인필요", 사유: why };
    }
    return { ...base, 수량: qty, 단위: item.단위, status: "정상", 사유: m.how };
  }

  // ------------------------------------------------------------ extract.py
  const HISTORY_MEMO = "직전 주문 참조";
  const HISTORY_CUES = /어제\s*(거|꺼|것)|평소|그대로|지난번|똑같이|늘\s*하던/;

  function deliveryDate(order) {
    const extra = order.본문.includes("모레") ? 1 : 0;
    if (order.납품일기본) {
      const [y, m, d] = order.납품일기본.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + extra)).toISOString().slice(0, 10);
    }
    const t = order.수신시각;
    return new Date(Date.UTC(t.y, t.mo - 1, t.d + 1 + extra)).toISOString().slice(0, 10);
  }

  function historyLines(order, history, catalog) {
    const hist = history[order.거래처];
    if (!hist) return [{ 품목명_원문: "(직전 주문)", 규격: null, 수량: null, 단위: null, 납품일: null, 메모: "직전 주문 기록 없음", 확신도: 0 }];
    const date = deliveryDate(order);
    return Object.entries(hist).map(([c, q]) => ({
      품목명_원문: catalog.byCode[c].품목명, 규격: null, 수량: q, 단위: catalog.byCode[c].단위,
      납품일: date, 메모: HISTORY_MEMO, 확신도: 0.95,
    }));
  }

  const SYSTEM_PROMPT = `너는 식자재 유통사의 주문 접수 담당이다. 식당 사장님이 카카오톡으로 보낸 주문 메시지를 주문 라인으로 구조화한다.

규칙
- 품목 하나당 한 줄. 품목명_원문은 고객이 쓴 표현 그대로 적는다(사투리·약어 포함). 품목 마스터 이름으로 바꾸지 않는다. 매칭은 별도 시스템이 한다.
- 수량은 숫자로 적는다(한→1, 두→2, 열→10). '좀', '넉넉히'처럼 수량이 불명확하면 수량은 null, 확신도는 0.5 미만.
- 단위는 고객이 쓴 단위 그대로 적는다(키로·킬로만 kg로). 환산하지 않는다.
- "어제 거 그대로", "평소대로", "지난번처럼"처럼 직전 주문을 가리키면, 아래 [직전 주문]의 품목을 모두 넣는다. 이때 품목명_원문은 [직전 주문]에 적힌 품목명, 메모는 "직전 주문 참조". 같은 메시지 안의 수량 변경·추가·제외 지시를 반영한다. [직전 주문]이 없으면 품목명_원문 "(직전 주문)", 수량 null, 확신도 0 인 한 줄만 넣는다.
- "아까 거에 추가"처럼 당일 추가 주문이면 직전 주문을 복사하지 말고 추가 품목만 넣는다.
- 인사말, "~말고"처럼 부정된 품목은 넣지 않는다.
- 납품일: '모레'면 수신일+2일, 그 외('내일', '낼', 언급 없음)는 기본 납품일.
- 확신도: 품목과 수량이 명확하면 0.9 이상. 무엇을 가리키는지 애매하면 0.7 미만.`;

  const nullable = (type, description) => ({ anyOf: [{ type }, { type: "null" }], ...(description ? { description } : {}) });
  const ORDER_SCHEMA = {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            품목명_원문: { type: "string", description: "고객이 쓴 품목명 그대로. 직전 주문 복사 시에는 품목 마스터의 품목명" },
            규격: nullable("string", "메시지에 규격이 명시된 경우만 (예: 15kg, 1단)"),
            수량: nullable("number", "숫자. '좀/넉넉히'처럼 불명확하면 null"),
            단위: nullable("string", "고객이 쓴 단위 (단, 망, 근, 박스, kg, 판, 통, 봉, 개 ...)"),
            납품일: nullable("string", "YYYY-MM-DD"),
            메모: nullable("string"),
            확신도: { type: "number", description: "이 줄 해석에 대한 확신 0~1" },
          },
          required: ["품목명_원문", "확신도"],
          additionalProperties: false,
        },
      },
    },
    required: ["lines"],
    additionalProperties: false,
  };

  /** pydantic ExtractedOrder 검증과 같은 역할. 실패 시 throw. */
  function validateExtracted(obj) {
    if (!obj || !Array.isArray(obj.lines)) throw new Error("lines 배열 없음");
    return {
      lines: obj.lines.map((l, i) => {
        const where = `lines[${i}]`;
        if (typeof l.품목명_원문 !== "string" || !l.품목명_원문.trim()) throw new Error(`${where}.품목명_원문 오류`);
        if (typeof l.확신도 !== "number" || l.확신도 < 0 || l.확신도 > 1) throw new Error(`${where}.확신도는 0~1 숫자여야 함`);
        for (const k of ["규격", "단위", "납품일", "메모"]) {
          if (l[k] != null && typeof l[k] !== "string") throw new Error(`${where}.${k} 타입 오류`);
        }
        if (l.수량 != null && typeof l.수량 !== "number") throw new Error(`${where}.수량 타입 오류`);
        return { 품목명_원문: l.품목명_원문, 규격: l.규격 ?? null, 수량: l.수량 ?? null, 단위: l.단위 ?? null,
          납품일: l.납품일 ?? null, 메모: l.메모 ?? null, 확신도: l.확신도 };
      }),
    };
  }

  function llmPrompt(order, history, catalog) {
    const hist = history[order.거래처];
    const histText = hist
      ? Object.entries(hist).map(([c, q]) => `- ${catalog.byCode[c].품목명} ${fmtNum(q)}${catalog.byCode[c].단위}`).join("\n")
      : "없음";
    const catalogText = catalog.items
      .map((i) => `- ${i.품목명} | 규격 ${i.규격} | 단위 ${i.단위}` + (i.별칭.length ? ` | 별칭 ${i.별칭.join(", ")}` : ""))
      .join("\n");
    return `거래처: ${order.거래처}\n수신시각: ${order.수신시각.text}\n기본 납품일: ${deliveryDate(order)}\n\n` +
      `[직전 주문]\n${histText}\n\n[품목 마스터(참고용)]\n${catalogText}\n\n[메시지]\n${order.본문}`;
  }

  const NUM_WORDS = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 석: 3, 네: 4, 넷: 4, 다섯: 5,
    여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 스무: 20, 반: 0.5 };
  const UNITS = "kg|KG|Kg|키로그램|킬로그램|키로|킬로|근|포기|포대|포|단|망|박스|상자|빡스|판|말통|통|봉지|봉|개|마리|병|팩";
  const NUM_ALT = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join("|");
  const QTY_RE = new RegExp(`(?<name>[가-힣A-Za-z]+(?:\\s+[가-힣A-Za-z]+)?)\\s*(?<num>\\d+(?:\\.\\d+)?|${NUM_ALT})\\s*(?<unit>${UNITS})(?<half>\\s*반(?![가-힣]))?`, "g");
  const VAGUE_RE = /좀|넉넉히|적당히|조금|많이|약간/;
  // 앞선 주문을 고치는 말이나 휴무 통보: 자동으로 넣지 말고 담당자에게 묻는다('틀리게 넣느니 묻는다')
  const EDIT_CUE = /취소|말고|대신|변경|바꿔|바꾸|수정/;
  const CLOSED_CUE = /휴무|쉬어요|쉽니다|쉴게요|안\s*받|오지\s*마|배송\s*안|문\s*안\s*열/;
  function messageCue(body) {
    if (CLOSED_CUE.test(body)) return "휴무·배송 안내";
    if (EDIT_CUE.test(body)) return "수정·취소 표현";
    return null;
  }
  const VAGUE_FULL = /^(좀|넉넉히|적당히|조금|많이|약간)$/;
  const SEGMENT_RE = /[,\n.]|그리고|근데/;
  const CONNECTIVE = /^(말고|아니라|아니고|아니|대신|대신에|으로|로)$/;

  class RuleExtractor {
    constructor(catalog, history) {
      this.name = "규칙(오프라인)";
      this.catalog = catalog;
      this.history = history;
    }

    _name(raw) {
      const words = raw.trim().split(/\s+/);
      if (words.length === 2 && this.catalog.lookupExact(words.join(""))) return words.join("");
      return words[words.length - 1];
    }

    async extract(order) {
      const date = deliveryDate(order);
      const memo = [...order.본문.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join("; ") || null;
      const body = order.본문.replace(/\([^)]*\)/g, " ");
      const cue = messageCue(body);
      const lines = new Map();
      if (HISTORY_CUES.test(body)) {
        for (const l of historyLines(order, this.history, this.catalog)) {
          const item = this.catalog.lookupExact(l.품목명_원문);
          lines.set(item ? item.품목코드 : l.품목명_원문, l);
        }
      }
      for (const seg of body.split(SEGMENT_RE).map((s) => s.trim())) {
        if (!seg) continue;
        const matches = [...seg.matchAll(QTY_RE)];
        let prevKey = null;
        for (const m of matches) {
          const name = this._name(m.groups.name);
          const num = m.groups.num;
          const qty = (/^\d/.test(num) ? parseFloat(num) : NUM_WORDS[num]) + (m.groups.half ? 0.5 : 0);
          // "삼겹 10키로 말고 15키로": 접속어 뒤의 수량은 앞 품목의 수량을 고치는 것
          if (CONNECTIVE.test(name) && prevKey && lines.has(prevKey)) {
            Object.assign(lines.get(prevKey), { 수량: qty, 단위: canonicalUnit(m.groups.unit) });
            continue;
          }
          const item = this.catalog.lookupExact(name);
          const key = item ? item.품목코드 : name;
          prevKey = key;
          const prev = lines.get(key);
          const lineMemo = prev && prev.메모 === HISTORY_MEMO ? `${HISTORY_MEMO}(수량 변경)` : memo;
          lines.set(key, { 품목명_원문: name, 규격: null, 수량: qty, 단위: canonicalUnit(m.groups.unit),
            납품일: date, 메모: cue ? `${cue} 포함 — 확인` : lineMemo, 확신도: cue ? 0.6 : 0.9 });
        }
        if (matches.length) continue;
        if (seg.includes("빼")) {
          for (const tok of seg.split(/\s+/)) {
            const item = this.catalog.lookupExact(tok);
            if (item) lines.delete(item.품목코드);
          }
        } else if (VAGUE_RE.test(seg)) {
          const toks = seg.split(/\s+/).filter((t) => t && !VAGUE_FULL.test(t));
          if (toks.length) {
            const name = stripParticle(toks[0]);
            lines.set(name, { 품목명_원문: name, 규격: null, 수량: null, 단위: null, 납품일: date, 메모: "수량 불명확", 확신도: 0.3 });
          }
        }
      }
      return validateExtracted({ lines: [...lines.values()] });
    }
  }

  // ------------------------------------------------------------ __main__.py
  /** 1건당 호출 1회. 실패(검증 오류 포함) 시 1회 재시도 후 포기. */
  async function structure(extractor, order) {
    let err = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { ext: await extractor.extract(order), err: "" };
      } catch (e) {
        err = `${e.name || "Error"}: ${e.message}`.slice(0, 200);
        if (e && e.retry === false) break; // 재시도해도 소용없는 오류(권한 거부·호출 한도 등)
      }
    }
    return { ext: null, err };
  }

  function hashText(s) {
    let h = 5381;
    for (const ch of s) h = (Math.imul(h, 33) ^ ch.codePointAt(0)) >>> 0;
    return h.toString(36);
  }

  /** 주문 1건을 가리키는 안정적인 키(같은 주문을 다시 처리해도 같음) — LLM 캐시·담당자 확인 저장에 쓴다. */
  function orderKey(o) {
    return `${o.거래처}|${o.수신시각.text}|${hashText(o.본문)}`;
  }

  /** 담당자가 확인 큐에서 내린 결정을 결과에 덮어쓴다. {code, qty} → 정상(담당자 확인), {dismissed} → 제외. */
  function applyResolutions(resolved, resolutions, catalog) {
    for (const r of resolved) {
      const res = resolutions[r.key];
      if (!res) continue;
      if (res.dismissed) {
        Object.assign(r, { status: "제외", 사유: "담당자 제외", resolved: true });
        continue;
      }
      const item = catalog.byCode[res.code];
      if (!item || !(res.qty > 0)) continue;
      Object.assign(r, { item, 수량: res.qty, 단위: item.단위, status: "정상", 사유: "담당자 확인", resolved: true });
    }
  }

  async function run({ ordersText, ...rest }) {
    return runOrders({ orders: parseOrders(ordersText), ...rest });
  }

  /** cache: orderKey → ExtractedOrder (있으면 추출기를 부르지 않음). resolutions: lineKey → 담당자 결정. */
  async function runOrders({ orders, catalog, history, extractor, onProgress, concurrency = Infinity, cache = null, resolutions = null }) {
    const t0 = performance.now();
    let done = 0, next = 0;
    const results = new Array(orders.length);
    const worker = async () => {
      while (next < orders.length) {
        const i = next++;
        // 캐시 키: 주문 + 납품일 + 해석 방식 (방식을 바꾸면 다시 해석하고, 되돌리면 이전 결과를 다시 쓴다)
        const ck = `${orderKey(orders[i])}@${orders[i].납품일기본 || ""}@${extractor.cacheKey || extractor.name}`;
        if (cache && cache[ck]) {
          results[i] = { ext: cache[ck], err: "", cached: true };
        } else {
          results[i] = await structure(extractor, orders[i]);
          if (cache && results[i].ext) cache[ck] = results[i].ext;
        }
        onProgress && onProgress(++done, orders.length);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, orders.length)) }, worker));
    const tStruct = performance.now() - t0;
    const resolved = [];
    orders.forEach((order, i) => {
      const key = orderKey(order);
      const { ext, err } = results[i];
      const blank = { 규격: null, 수량: null, 단위: null, 납품일: null, 확신도: 0 };
      if (!ext) {
        const line = { ...blank, 품목명_원문: order.본문.split("\n")[0], 메모: err };
        resolved.push({ key: `${key}#fail`, order, line, item: null, 수량: null, 단위: null, 후보: [], status: "확인필요", 사유: "구조화 실패(재시도 1회 후)" });
        return;
      }
      if (!ext.lines.length) {
        const line = { ...blank, 품목명_원문: "(품목 없음)", 메모: null };
        resolved.push({ key: `${key}#empty`, order, line, item: null, 수량: null, 단위: null, 후보: [], status: "확인필요", 사유: "주문 품목을 찾지 못함" });
      }
      ext.lines.forEach((l, j) => resolved.push({ key: `${key}#${j}`, ...resolve(order, l, catalog) }));
    });
    if (resolutions) {
      applyResolutions(resolved, resolutions, catalog);
      // 담당자가 주문에 직접 추가한 품목: 키 "<orderKey>#add-<n>"
      const byKey = new Map(orders.map((o) => [orderKey(o), o]));
      for (const [k, res] of Object.entries(resolutions)) {
        const m = k.match(/^(.*)#add-\d+$/);
        if (!m || !byKey.has(m[1]) || res.dismissed) continue;
        const item = catalog.byCode[res.code];
        if (!item || !(res.qty > 0)) continue;
        const order = byKey.get(m[1]);
        const line = { 품목명_원문: res.원문 || "(담당자 추가)", 규격: null, 수량: res.qty, 단위: item.단위, 납품일: deliveryDate(order), 메모: "담당자 추가", 확신도: 1 };
        resolved.push({ key: k, order, line, item, 수량: res.qty, 단위: item.단위, 후보: [], status: "정상", 사유: "담당자 추가", resolved: true });
      }
    }
    const pendingOrders = new Set(resolved.filter((r) => r.status === "확인필요").map((r) => r.order.순번));
    const dates = {};
    for (const r of resolved) if (r.line.납품일) dates[r.line.납품일] = (dates[r.line.납품일] || 0) + 1;
    const mainDate = Object.entries(dates).sort((a, b) => b[1] - a[1])[0]?.[0] || new Date().toISOString().slice(0, 10);
    const count = (st) => resolved.filter((r) => r.status === st).length;
    return {
      orders, resolved, mainDate,
      summary: {
        engine: extractor.name,
        orders: orders.length,
        lines: resolved.length,
        clients: new Set(orders.map((o) => o.거래처)).size,
        autoOrders: orders.length - pendingOrders.size,
        pendingOrders: pendingOrders.size,
        okLines: count("정상"),
        autoLines: resolved.filter((r) => r.status === "정상" && !r.resolved).length,
        resolvedLines: resolved.filter((r) => r.resolved && r.status === "정상").length,
        pendingLines: count("확인필요"),
        excludedLines: count("제외"),
        cachedOrders: results.filter((r) => r && r.cached).length,
        seconds: (performance.now() - t0) / 1000,
        structSeconds: tStruct / 1000,
      },
    };
  }

  function evaluate(resolved, orders, gold) {
    const wrong = [], missed = [], pendingDiff = [];
    for (const o of orders) {
      const g = gold[String(o.순번)];
      if (!g) continue;
      const exp = new Set(g["정상"].map(([c, q]) => `${c}:${+q}`));
      const rs = resolved.filter((r) => r.order.순번 === o.순번);
      const got = new Set(rs.filter((r) => r.status === "정상").map((r) => `${r.item.품목코드}:${+r.수량}`));
      for (const x of got) if (!exp.has(x)) wrong.push([o.순번, x]);
      for (const x of exp) if (!got.has(x)) missed.push([o.순번, x]);
      const n = rs.filter((r) => r.status === "확인필요").length;
      if (n !== g["확인필요"]) pendingDiff.push([o.순번, n, g["확인필요"]]);
    }
    return { wrong, missed, pendingDiff };
  }

  // ------------------------------------------------------------ export.py (텍스트 출력)
  let DISTRIBUTOR = "새벽들유통";
  let FOOTER = "변경은 이 채널로 회신 주세요.";
  /** 확인서 머리글의 유통사 이름과 꼬리말. */
  function setDistributor(name, footer) {
    if (name && String(name).trim()) DISTRIBUTOR = String(name).trim();
    if (footer != null) FOOTER = String(footer).trim();
  }

  function rawText(r) {
    const l = r.line;
    return l.수량 != null ? `${l.품목명_원문} ${fmtNum(l.수량)}${l.단위 || ""}` : l.품목명_원문;
  }

  function fmtItem(item, qty) {
    if (item.단위 === "kg") return `${item.품목명} ${fmtNum(qty)}kg`;
    if (item.단위 === "단") return `${item.품목명} ${item.규격}×${fmtNum(qty)}`;
    return `${item.품목명} ${fmtNum(qty)}${item.단위}`;
  }

  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const x of arr) {
      const k = keyFn(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  }

  function confirmations(resolved) {
    const out = [];
    for (const [client, rs] of groupBy(resolved, (r) => r.order.거래처)) {
      const ok = new Map(), items = {}, dates = new Set();
      for (const r of rs) {
        if (r.status !== "정상") continue;
        ok.set(r.item.품목코드, (ok.get(r.item.품목코드) || 0) + r.수량);
        items[r.item.품목코드] = r.item;
        if (r.line.납품일) dates.add(r.line.납품일);
      }
      const pending = rs.filter((r) => r.status === "확인필요").map(rawText);
      const when = [...dates].sort().map((d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`).join("·") || "다음";
      const text = [`[${DISTRIBUTOR}] 주문 확인`];
      text.push(ok.size
        ? `${client}님, ${when} 납품 주문 확인드립니다. ` + [...ok].map(([c, q]) => fmtItem(items[c], q)).join(", ")
        : `${client}님, 주문 잘 받았습니다.`);
      if (pending.length) text.push(`※ 확인 중: ${pending.join(", ")} — 품목/수량 확인 후 다시 연락드리겠습니다.`);
      if (FOOTER) text.push(FOOTER);
      out.push({ client, text: text.join("\n"), pending: pending.length });
    }
    return out;
  }

  function pickingList(resolved) {
    const rows = new Map();
    for (const r of resolved) {
      if (r.status !== "정상") continue;
      const c = r.item.품목코드;
      if (!rows.has(c)) rows.set(c, { item: r.item, total: 0, perClient: new Map() });
      const row = rows.get(c);
      row.total += r.수량;
      row.perClient.set(r.order.거래처, (row.perClient.get(r.order.거래처) || 0) + r.수량);
    }
    return [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  }

  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+@]|^-(?![\d.])/.test(s)) s = "'" + s; // 엑셀 수식 주입 방지
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function queueCsv(resolved) {
    const rows = [["거래처", "수신시각", "원문", "후보1", "후보2", "후보3", "사유", "메시지 전문"]];
    for (const r of resolved.filter((r) => r.status === "확인필요")) {
      const c = [...r.후보, "", "", ""].slice(0, 3);
      rows.push([r.order.거래처, r.order.수신시각.text, rawText(r), ...c, r.사유, r.order.본문.replace(/\n/g, " / ")]);
    }
    return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  const api = {
    parseOrders, loadItems, loadHistory, Catalog, RuleExtractor, resolve, convert, run, runOrders, orderKey, applyResolutions, evaluate,
    normName: norm, canonicalUnit, hashText, messageCue, parseCsvRows,
    confirmations, pickingList, queueCsv, rawText, fmtNum, groupBy, deliveryDate, llmPrompt, validateExtracted,
    SYSTEM_PROMPT, ORDER_SCHEMA, setDistributor,
  };
  root.OrderNote = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
