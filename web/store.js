/* 작업공간(워크스페이스) 저장소 — 유통사 한 곳의 품목 사전·거래처·직전 주문·기록·오늘 작업.
 * 서버 없이 브라우저 localStorage 에 저장한다(이 브라우저에만 남음 → 백업 JSON 내보내기/가져오기 제공).
 * 브라우저에서는 window.OrderNoteStore, Node 에서는 require() 로 쓴다. */
(function (root) {
  "use strict";
  const ON = root.OrderNote || (typeof require !== "undefined" ? require("./core.js") : null);

  const KEY = "ordernote.workspace.v1";
  const VERSION = 1;

  function blank() {
    return {
      version: VERSION,
      createdAt: null,
      settings: {
        유통사명: "",
        담당자이름: [],          // 카톡 대화에서 '우리 쪽' 발신자 이름(제외 대상)
        engine: "rule",          // rule | llm | claude
        apiKey: "",              // llm 엔진용. rememberKey 가 true 일 때만 저장된다
        rememberKey: false,
        model: "claude-opus-5-5",
        mergeGapMin: 10,         // 같은 거래처의 연속 메시지를 한 주문으로 합치는 간격(분)
        leadDays: 1,             // 기본 납품일 = 수신일 + leadDays
        noDeliveryDays: [],      // 배송 없는 요일 (0=일 … 6=토)
        autoBackup: true,        // 확정할 때 백업 JSON 내려받기
        beforeMinutes: 0,        // 도입 전 하루 평균 소요 시간(분) — 단축률 계산용
        confirmFooter: "변경은 이 채널로 회신 주세요.",
        warehouse: "",           // 이카운트 출하창고 코드
        onboarded: false,
        sample: false,           // 샘플 모드(통계에 섞지 않음)
      },
      clientAliases: {},         // 거래처명 → { 정규화된 표현: 품목코드 } (이 거래처에만 적용되는 별칭)
      lastBackupAt: null,
      items: [],                 // 품목 사전: {품목코드, 품목명, 규격, 단위, 별칭[], 환산{단위:배수}, 학습[{별칭,날짜,거래처}]}
      clients: {},               // 거래처명 → {표시이름[], 직전주문{코드:수량}, 직전주문일, 주문횟수, 메모}
      days: [],                  // 확정한 날 기록: {납품일, 확정시각, 주문, 라인, 자동, 확인, 제외, 처리초, 학습, engine}
      session: blankSession(),   // 지금 작업 중인 하루
    };
  }

  function blankSession() {
    return {
      ordersText: "",
      deliveryDate: null,        // YYYY-MM-DD (null 이면 수신일+leadDays)
      senders: {},               // 카톡 발신자 이름 → "order" | "me" | "skip"
      extracted: {},             // orderKey → ExtractedOrder (LLM 결과 캐시: 새로고침해도 재호출 없음)
      resolutions: {},           // lineKey → {code, qty, dismissed, learned}
      confirmedAt: null,
      confirmedKeys: [],         // 확정 시점에 있던 줄 키 (이후 추가된 줄 = 추가분)
      startedAt: null,           // 첫 붙여넣기 시각 (처리 시간 측정)
      sent: {},                  // 확인서 보낸 거래처 → true
    };
  }

  // ------------------------------------------------------------ 저장/불러오기
  function load(storage) {
    const st = storage || safeStorage();
    if (!st) return null;
    try {
      const raw = st.getItem(KEY);
      if (!raw) return null;
      return migrate(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function save(ws, storage) {
    const st = storage || safeStorage();
    if (!st) return false;
    try {
      st.setItem(KEY, JSON.stringify(ws));
      return true;
    } catch {
      return false;
    }
  }

  function safeStorage() {
    try {
      const st = root.localStorage;
      if (!st) return null;
      st.getItem(KEY);
      return st;
    } catch {
      return null;
    }
  }

  function migrate(ws) {
    if (!ws || typeof ws !== "object") throw new Error("작업공간 형식이 아님");
    const b = blank();
    const out = { ...b, ...ws, settings: { ...b.settings, ...(ws.settings || {}) }, session: { ...blankSession(), ...(ws.session || {}) } };
    out.items = (ws.items || []).map(normalizeItem);
    out.clients = ws.clients || {};
    out.clientAliases = ws.clientAliases || {};
    out.days = ws.days || [];
    out.version = VERSION;
    return out;
  }

  function normalizeItem(i) {
    return {
      품목코드: String(i.품목코드 || "").trim(),
      품목명: String(i.품목명 || "").trim(),
      규격: String(i.규격 || "").trim(),
      단위: String(i.단위 || "").trim(),
      별칭: Array.isArray(i.별칭) ? i.별칭.map((a) => String(a).trim()).filter(Boolean) : String(i.별칭 || "").split(";").map((a) => a.trim()).filter(Boolean),
      환산: i.환산 && typeof i.환산 === "object" ? i.환산 : {},
      학습: Array.isArray(i.학습) ? i.학습 : [],
      ERP코드: String(i.ERP코드 || "").trim(),
    };
  }

  function exportJson(ws) {
    return JSON.stringify({ ...ws, exportedAt: new Date().toISOString() }, null, 2);
  }

  function importJson(text) {
    const ws = migrate(JSON.parse(text));
    if (!ws.items.length && !Object.keys(ws.clients).length) throw new Error("품목도 거래처도 없는 파일입니다");
    return ws;
  }

  // ------------------------------------------------------------ 품목 사전
  function itemsCsv(ws) {
    const rows = [["품목코드", "품목명", "규격", "단위", "별칭"]];
    for (const i of ws.items) rows.push([i.품목코드, i.품목명, i.규격, i.단위, i.별칭.join(";")]);
    return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+@]|^-(?![\d.])/.test(s)) s = "'" + s; // 엑셀 수식 주입 방지
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const HEADER_SYNONYMS = {
    품목코드: ["품목코드", "코드", "품목번호", "상품코드", "prod_cd", "code"],
    품목명: ["품목명", "품명", "상품명", "품목", "prod_des", "name"],
    규격: ["규격", "규격명", "사이즈", "size", "size_des"],
    단위: ["단위", "기본단위", "재고단위", "unit"],
    별칭: ["별칭", "별명", "다른이름", "alias", "aliases"],
  };

  /** 열 이름이 달라도(이카운트 품목 내보내기 등) 품목코드·품목명·규격·단위·별칭을 찾아 읽는다. */
  function readItemsCsv(text) {
    const rows = (ON.parseCsvRows ? ON.parseCsvRows(text) : text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((l) => l.split(",")));
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h).replace(/\s+/g, "").toLowerCase());
    const idx = {};
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
      const i = header.findIndex((h) => names.some((n) => h === n.toLowerCase()));
      if (i >= 0) idx[field] = i;
    }
    if (idx.품목명 == null) throw new Error("'품목명' 열을 찾지 못했습니다");
    return rows.slice(1).filter((r) => r.some((c) => String(c).trim())).map((r) => ({
      품목코드: idx.품목코드 != null ? r[idx.품목코드] : "", 품목명: r[idx.품목명] ?? "", 규격: idx.규격 != null ? r[idx.규격] : "",
      단위: idx.단위 != null ? r[idx.단위] : "", 별칭: idx.별칭 != null ? r[idx.별칭] : "",
    }));
  }

  /** CSV → items. 코드가 없으면 자동 부여. 기존 사전에 합친다. */
  function importItemsCsv(ws, text, { replace = false } = {}) {
    const parsed = readItemsCsv(text);
    const existing = replace ? [] : ws.items.slice();
    const byCode = new Map(existing.map((i) => [i.품목코드, i]));
    const byName = new Map(existing.map((i) => [ON.normName ? ON.normName(i.품목명) : i.품목명, i]));
    let added = 0, updated = 0;
    for (const p of parsed) {
      const item = normalizeItem(p);
      if (!item.품목명) continue;
      if (!item.품목코드) item.품목코드 = nextCode(byCode);
      const prev = byCode.get(item.품목코드) || byName.get(item.품목명);
      if (prev) {
        Object.assign(prev, { 품목명: item.품목명, 규격: item.규격 || prev.규격, 단위: item.단위 || prev.단위 });
        for (const a of item.별칭) if (!prev.별칭.includes(a)) prev.별칭.push(a);
        updated++;
      } else {
        existing.push(item);
        byCode.set(item.품목코드, item);
        added++;
      }
    }
    ws.items = existing;
    return { added, updated, total: existing.length };
  }

  function nextCode(byCode) {
    let n = byCode.size + 1;
    while (byCode.has(`I${String(n).padStart(3, "0")}`)) n++;
    return `I${String(n).padStart(3, "0")}`;
  }

  function addItem(ws, fields) {
    const item = normalizeItem(fields);
    if (!item.품목명) throw new Error("품목명은 비울 수 없습니다");
    if (!item.품목코드) item.품목코드 = nextCode(new Map(ws.items.map((i) => [i.품목코드, i])));
    if (ws.items.some((i) => i.품목코드 === item.품목코드)) throw new Error(`품목코드 ${item.품목코드} 가 이미 있습니다`);
    if (!item.단위) item.단위 = "개";
    ws.items.push(item);
    return item;
  }

  function removeItem(ws, code) {
    ws.items = ws.items.filter((i) => i.품목코드 !== code);
    for (const c of Object.values(ws.clients)) if (c.직전주문) delete c.직전주문[code];
    for (const m of Object.values(ws.clientAliases)) for (const k of Object.keys(m)) if (m[k] === code) delete m[k];
  }

  /** 담당자가 확인 큐에서 고른 표현을 별칭으로 기억한다. 다른 품목의 이름/별칭과 겹치면 거부. */
  function learnAlias(ws, code, alias, meta = {}) {
    const a = String(alias || "").trim();
    if (!a || a.length > 30) return { ok: false, reason: "별칭으로 쓸 수 없는 표현" };
    const item = ws.items.find((i) => i.품목코드 === code);
    if (!item) return { ok: false, reason: "품목 없음" };
    const key = a.replace(/\s+/g, "").toLowerCase();
    if (/^[\d.]+$/.test(key)) return { ok: false, reason: "숫자만으로는 별칭이 될 수 없음" };
    if (meta.client && meta.clientOnly) {
      ws.clientAliases[meta.client] ||= {};
      ws.clientAliases[meta.client][key] = code;
      item.학습.push({ 별칭: a, 날짜: meta.date || today(), 거래처: meta.client, 범위: meta.client });
      return { ok: true, clientOnly: true };
    }
    for (const other of ws.items) {
      const names = [other.품목명, ...other.별칭].map((n) => n.replace(/\s+/g, "").toLowerCase());
      if (names.includes(key)) {
        return other.품목코드 === code ? { ok: true, already: true } : { ok: false, reason: `'${a}'는 이미 ${other.품목명}의 이름/별칭` };
      }
    }
    item.별칭.push(a);
    item.학습.push({ 별칭: a, 날짜: meta.date || today(), 거래처: meta.client || "" });
    return { ok: true };
  }

  /** '1<주문단위> = factor<마스터단위>' 를 품목에 기억한다. */
  function learnConversion(ws, code, unit, factor) {
    const item = ws.items.find((i) => i.품목코드 === code);
    if (!item || !unit || !(factor > 0)) return false;
    item.환산[unit] = Math.round(factor * 1000) / 1000;
    return true;
  }

  // ------------------------------------------------------------ 거래처
  function clientNameFor(ws, kakaoName) {
    const n = String(kakaoName || "").trim();
    if (ws.clients[n]) return n;
    for (const [name, c] of Object.entries(ws.clients)) if ((c.표시이름 || []).includes(n)) return name;
    return n;
  }

  function ensureClient(ws, name, kakaoName) {
    const n = String(name || "").trim();
    if (!n) return null;
    if (!ws.clients[n]) ws.clients[n] = { 표시이름: [], 직전주문: {}, 직전주문일: null, 주문횟수: 0, 메모: "", ERP코드: "" };
    const c = ws.clients[n];
    if (kakaoName && kakaoName !== n && !c.표시이름.includes(kakaoName)) c.표시이름.push(kakaoName);
    return c;
  }

  function renameClient(ws, from, to) {
    const t = String(to || "").trim();
    if (!t || t === from) return false;
    if (ws.clients[t]) throw new Error(`거래처 '${t}' 가 이미 있습니다`);
    const c = ws.clients[from];
    if (!c) return false;
    delete ws.clients[from];
    if (!c.표시이름.includes(from)) c.표시이름.push(from);
    ws.clients[t] = c;
    if (ws.clientAliases[from]) { ws.clientAliases[t] = { ...(ws.clientAliases[t] || {}), ...ws.clientAliases[from] }; delete ws.clientAliases[from]; }
    for (const d of ws.days) if (d.sample === undefined) {} // 기록은 이름을 들고 있지 않음
    return true;
  }

  function history(ws) {
    const h = {};
    for (const [name, c] of Object.entries(ws.clients)) {
      if (c.직전주문 && Object.keys(c.직전주문).length) h[name] = c.직전주문;
    }
    return h;
  }

  // ------------------------------------------------------------ 하루 확정
  /** 처리 결과(정상 줄)를 거래처별 직전 주문으로 저장하고 기록을 남긴다. */
  function confirmDay(ws, result, meta = {}) {
    const { resolved, summary, mainDate } = result;
    const perClient = {};
    for (const r of resolved) {
      if (r.status !== "정상") continue;
      const name = r.order.거래처;
      perClient[name] ||= {};
      perClient[name][r.item.품목코드] = (perClient[name][r.item.품목코드] || 0) + r.수량;
    }
    const when = new Date().toISOString();
    const first = !ws.session.confirmedAt; // 같은 날을 다시 확정하면 직전 주문만 갱신하고 횟수는 안 올린다
    for (const [name, order] of Object.entries(perClient)) {
      const c = ensureClient(ws, name);
      c.직전주문 = order;
      c.직전주문일 = mainDate;
      if (first) c.주문횟수 = (c.주문횟수 || 0) + 1;
    }
    const learned = Object.values(ws.session.resolutions).filter((r) => r.learned).length;
    const startedAt = ws.session.startedAt ? new Date(ws.session.startedAt).getTime() : null;
    const elapsedMin = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 60000)) : null;
    const rec = {
      납품일: mainDate, 확정시각: when, 주문: summary.orders, 라인: summary.lines, 자동: summary.autoLines ?? summary.okLines,
      담당자확인: summary.resolvedLines || 0, 확인: summary.pendingLines, 제외: summary.excludedLines || 0,
      처리초: Math.round(summary.seconds * 100) / 100, 소요분: elapsedMin, 학습: learned, engine: summary.engine,
      sample: !!ws.settings.sample, ...meta,
    };
    ws.days = ws.days.filter((d) => d.납품일 !== mainDate).concat(rec).sort((a, b) => (a.납품일 < b.납품일 ? -1 : 1));
    ws.session.confirmedAt = when;
    ws.session.confirmedKeys = resolved.map((r) => r.key).filter(Boolean);
    return rec;
  }

  function newDay(ws) {
    ws.session = blankSession();
  }

  // ------------------------------------------------------------ 샘플
  function loadSample(ws, sample) {
    ws.items = ON.loadItems(sample.items).map(normalizeItem);
    const hist = JSON.parse(sample.history);
    ws.clients = {};
    for (const [name, v] of Object.entries(hist)) {
      ws.clients[name] = { 표시이름: [], 직전주문: v["품목"], 직전주문일: v["주문일"], 주문횟수: 1, 메모: "" };
    }
    ws.settings.유통사명 = ws.settings.유통사명 || "새벽들유통";
    ws.settings.담당자이름 = ws.settings.담당자이름.length ? ws.settings.담당자이름 : ["새벽들유통", "유통사 담당자"];
    ws.settings.sample = true;
    ws.session = blankSession();
    ws.session.ordersText = sample.orders;
    ws.settings.onboarded = true;
    ws.createdAt = ws.createdAt || new Date().toISOString();
    return ws;
  }

  /** 샘플 둘러보기를 끝내고 우리 주문을 시작: 품목 사전(기본 사전)은 남기고 거래처·기록·오늘 작업·학습 기록을 지운다. */
  function leaveSample(ws) {
    ws.clients = {};
    ws.clientAliases = {};
    ws.days = [];
    ws.session = blankSession();
    ws.settings.sample = false;
    ws.settings.담당자이름 = ws.settings.담당자이름.filter((n) => n !== "새벽들유통" && n !== "유통사 담당자");
    for (const i of ws.items) i.학습 = [];
  }

  /** 기본 식자재 사전만으로 시작(거래처·주문 없음). */
  function loadDefaultItems(ws, sample) {
    ws.items = ON.loadItems(sample.defaultItems || sample.items).map(normalizeItem);
    return ws;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function stats(ws) {
    const days = ws.days.filter((d) => !d.sample || ws.settings.sample);
    const t = { days: days.length, orders: 0, lines: 0, auto: 0, resolved: 0, pending: 0, learned: 0, minutes: 0, minuteDays: 0 };
    for (const d of days) {
      t.orders += d.주문; t.lines += d.라인; t.auto += d.자동; t.resolved += d.담당자확인 || 0; t.pending += d.확인; t.learned += d.학습 || 0;
      if (d.소요분) { t.minutes += d.소요분; t.minuteDays++; }
    }
    const aliases = ws.items.reduce((n, i) => n + i.학습.length, 0);
    return { ...t, aliasesLearned: aliases, autoRate: t.lines ? t.auto / t.lines : 0, pendingRate: t.lines ? t.pending / t.lines : 0 };
  }

  const api = {
    KEY, VERSION, blank, blankSession, load, save, migrate, exportJson, importJson,
    itemsCsv, importItemsCsv, addItem, removeItem, normalizeItem, learnAlias, learnConversion,
    clientNameFor, ensureClient, renameClient, history, confirmDay, newDay, loadSample, leaveSample, loadDefaultItems, stats, today, readItemsCsv,
  };
  root.OrderNoteStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
