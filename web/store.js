/* 작업공간(워크스페이스) 저장소 — 유통사 한 곳의 품목 사전·거래처·직전 주문·기록·오늘 작업.
 * 서버 없이 브라우저 localStorage 에 저장한다(이 브라우저에만 남음 → 백업 JSON 내보내기/가져오기 제공).
 * 백업 파일은 남이 만든 것일 수 있으므로 읽을 때 모든 값을 형식에 맞게 다시 만든다(migrate).
 * 브라우저에서는 window.OrderNoteStore, Node 에서는 require() 로 쓴다. */
(function (root) {
  "use strict";
  const ON = root.OrderNote || (typeof require !== "undefined" ? require("./core.js") : null);

  const KEY = "ordernote.workspace.v1";
  const VERSION = 1;
  const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const str = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max).trim();
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const strList = (v, max = 60) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean) : []);
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const pad = (n) => String(n).padStart(2, "0");

  function blank() {
    return {
      version: VERSION,
      createdAt: null,
      settings: {
        유통사명: "",
        담당자이름: [],          // 카톡 대화에서 '우리 쪽' 발신자 이름(제외 대상)
        engine: "rule",          // rule | llm | claude
        apiKey: "",              // llm 엔진용. rememberKey 가 true 일 때만 저장되고, 백업에는 절대 들어가지 않는다
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
      items: [],                 // 품목 사전: {품목코드, 품목명, 규격, 단위, 별칭[], 환산{단위:배수}, 학습[{별칭,날짜,거래처}], ERP코드}
      clients: {},               // 거래처명 → {표시이름[], 직전주문{코드:수량}, 직전주문일, 주문횟수, 메모, ERP코드}
      days: [],                  // 확정한 날 기록: {납품일, 확정시각, 주문, 라인, 자동, 담당자확인, 확인, 제외, 처리초, 소요분, 학습, engine, sample}
      session: blankSession(),   // 지금 작업 중인 하루
    };
  }

  function blankSession() {
    return {
      ordersText: "",
      deliveryDate: null,        // YYYY-MM-DD — 화면의 납품일 입력란 값(항상 채워 둔다)
      baseDate: null,            // 날짜 없는 복사본을 처음 붙여넣은 날 (키가 날짜 경계에서 흔들리지 않게)
      senders: {},               // 카톡 발신자 이름 → "order" | "me" | "skip"
      extracted: {},             // 캐시 키 → ExtractedOrder (AI 결과만)
      resolutions: {},           // lineKey → {code, qty, dismissed, learned, learnedAlias}
      confirmedAt: null,
      confirmedDate: null,       // 처음 확정한 납품일 (재확정해도 유지)
      confirmedKeys: [],         // 확정 시점에 있던 줄 키 (이후 추가된 줄 = 추가분)
      countedClients: [],        // 오늘 주문 횟수를 올린 거래처
      startedAt: null,           // 첫 붙여넣기 시각 (처리 시간 측정)
      sent: {},                  // 확인서 보낸 거래처 → 보낸 문구의 해시 (문구가 바뀌면 다시 보내야 함)
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

  /** 어떤 모양의 입력(옛 버전·남이 만든 백업)이든 현재 형식으로 다시 만든다. 모르는 키는 버린다. */
  function migrate(ws) {
    if (!isObj(ws)) throw new Error("작업공간 형식이 아님");
    const b = blank();
    const s = isObj(ws.settings) ? ws.settings : {};
    const settings = {
      유통사명: str(s.유통사명, 40), 담당자이름: strList(s.담당자이름), engine: ["rule", "llm", "claude"].includes(s.engine) ? s.engine : "rule",
      apiKey: str(s.apiKey, 300), rememberKey: !!s.rememberKey, model: str(s.model, 60) || b.settings.model,
      mergeGapMin: Math.max(0, Math.min(180, num(s.mergeGapMin, b.settings.mergeGapMin))), leadDays: Math.max(0, Math.min(7, num(s.leadDays, 1))),
      noDeliveryDays: (Array.isArray(s.noDeliveryDays) ? s.noDeliveryDays : []).map((d) => num(d, -1)).filter((d) => d >= 0 && d <= 6),
      autoBackup: s.autoBackup == null ? true : !!s.autoBackup, beforeMinutes: Math.max(0, num(s.beforeMinutes, 0)),
      confirmFooter: s.confirmFooter == null ? b.settings.confirmFooter : str(s.confirmFooter, 200), warehouse: str(s.warehouse, 20),
      onboarded: !!s.onboarded, sample: !!s.sample,
    };
    const items = (Array.isArray(ws.items) ? ws.items : []).map(normalizeItem).filter((i) => i.품목명);
    const codes = new Set(items.map((i) => i.품목코드));
    const clients = {};
    if (isObj(ws.clients)) {
      for (const [name, c] of Object.entries(ws.clients)) {
        const n = str(name, 60);
        if (!n || !isObj(c)) continue;
        clients[n] = normalizeClient(c, codes);
      }
    }
    const clientAliases = {};
    if (isObj(ws.clientAliases)) {
      for (const [name, m] of Object.entries(ws.clientAliases)) {
        if (!isObj(m) || !hasOwn(clients, str(name, 60))) continue;
        const out = {};
        for (const [k, code] of Object.entries(m)) if (codes.has(String(code)) && str(k, 30)) out[str(k, 30)] = String(code);
        if (Object.keys(out).length) clientAliases[str(name, 60)] = out;
      }
    }
    const days = (Array.isArray(ws.days) ? ws.days : []).filter(isObj).map((d) => ({
      납품일: validDate(d.납품일) || "", 확정시각: str(d.확정시각, 40), 주문: num(d.주문), 라인: num(d.라인), 자동: num(d.자동, d.확인 != null ? num(d.라인) - num(d.확인) : 0),
      담당자확인: num(d.담당자확인), 확인: num(d.확인), 제외: num(d.제외), 처리초: num(d.처리초), 소요분: d.소요분 == null ? null : Math.max(0, num(d.소요분)),
      학습: num(d.학습), engine: str(d.engine, 40), sample: !!d.sample,
    })).filter((d) => d.납품일);
    const ss = isObj(ws.session) ? ws.session : {};
    const bs = blankSession();
    const session = {
      ordersText: str(ss.ordersText, 400000), deliveryDate: validDate(ss.deliveryDate), baseDate: validDate(ss.baseDate),
      senders: isObj(ss.senders) ? Object.fromEntries(Object.entries(ss.senders).filter(([k, v]) => str(k, 60) && ["order", "me", "skip"].includes(v)).map(([k, v]) => [str(k, 60), v])) : bs.senders,
      extracted: isObj(ss.extracted) ? ss.extracted : {},
      resolutions: isObj(ss.resolutions) ? Object.fromEntries(Object.entries(ss.resolutions).filter(([, v]) => isObj(v))) : {},
      confirmedAt: str(ss.confirmedAt, 40) || null, confirmedDate: validDate(ss.confirmedDate), confirmedKeys: strList(ss.confirmedKeys, 200),
      countedClients: strList(ss.countedClients), startedAt: str(ss.startedAt, 40) || null,
      sent: isObj(ss.sent) ? Object.fromEntries(Object.entries(ss.sent).map(([k, v]) => [str(k, 60), v === true ? true : str(v, 40)]).filter(([k, v]) => k && v)) : {},
    };
    return { version: VERSION, createdAt: str(ws.createdAt, 40) || null, settings, clientAliases, lastBackupAt: str(ws.lastBackupAt, 40) || null, items, clients, days, session };
  }

  function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toISOString().slice(0, 10) === s ? s : null;
  }

  function normalizeItem(i) {
    if (!isObj(i)) i = {};
    const 환산 = {};
    if (isObj(i.환산)) for (const [u, f] of Object.entries(i.환산)) { const k = str(u, 10); const v = num(f); if (k && v > 0) 환산[k] = Math.round(v * 1000) / 1000; }
    return {
      품목코드: str(i.품목코드, 30),
      품목명: str(i.품목명, 60),
      규격: str(i.규격, 20),
      단위: str(i.단위, 10),
      별칭: Array.isArray(i.별칭) ? strList(i.별칭, 30) : str(i.별칭, 500).split(";").map((a) => a.trim()).filter(Boolean),
      환산,
      학습: (Array.isArray(i.학습) ? i.학습 : []).filter(isObj).map((l) => ({ 별칭: str(l.별칭, 30), 날짜: str(l.날짜, 10), 거래처: str(l.거래처, 60), ...(l.범위 ? { 범위: str(l.범위, 60) } : {}) })).filter((l) => l.별칭),
      ERP코드: str(i.ERP코드, 30),
    };
  }

  function normalizeOrderMap(o, codes) {
    const out = {};
    if (isObj(o)) for (const [code, q] of Object.entries(o)) { const v = num(q); if ((!codes || codes.has(code)) && v > 0) out[str(code, 30)] = Math.round(v * 1000) / 1000; }
    return out;
  }

  function normalizeClient(c, codes) {
    const 이전주문 = normalizeOrderMap(c.이전주문, codes);
    return {
      표시이름: strList(c.표시이름), 직전주문: normalizeOrderMap(c.직전주문, codes), 직전주문일: validDate(c.직전주문일),
      // 오늘 확정으로 덮어쓰기 전의 직전 주문. 확정한 날의 주문을 다시 읽을 때 "어제 거 그대로"가 오늘 주문 자신을 가리키지 않게 한다.
      ...(Object.keys(이전주문).length ? { 이전주문, 이전주문일: validDate(c.이전주문일) } : {}),
      주문횟수: Math.max(0, Math.floor(num(c.주문횟수))), 메모: str(c.메모, 200), ERP코드: str(c.ERP코드, 30),
    };
  }

  /** 백업 JSON. API 키는 절대 넣지 않는다(백업은 다른 PC·사람에게 옮겨지는 파일). */
  function exportJson(ws) {
    return JSON.stringify({ ...ws, settings: { ...ws.settings, apiKey: "" }, exportedAt: new Date().toISOString() }, null, 2);
  }

  function importJson(text) {
    if (typeof text !== "string" || text.length > 20_000_000) throw new Error("파일이 너무 큽니다");
    const ws = migrate(JSON.parse(text));
    ws.settings.apiKey = "";
    if (!ws.items.length && !Object.keys(ws.clients).length) throw new Error("품목도 거래처도 없는 파일입니다");
    return ws;
  }

  // ------------------------------------------------------------ 품목 사전
  function itemsCsv(ws) {
    const rows = [["품목코드", "품목명", "규격", "단위", "별칭", "ERP코드"]];
    for (const i of ws.items) rows.push([i.품목코드, i.품목명, i.규격, i.단위, i.별칭.join(";"), i.ERP코드 || ""]);
    return "﻿" + rows.map((r) => r.map(ON.csvCell).join(",")).join("\r\n") + "\r\n";
  }

  const HEADER_SYNONYMS = {
    품목코드: ["품목코드", "코드", "품목번호", "상품코드", "prod_cd", "code"],
    품목명: ["품목명", "품명", "상품명", "품목", "prod_des", "name"],
    규격: ["규격", "규격명", "사이즈", "size", "size_des"],
    단위: ["단위", "기본단위", "재고단위", "unit"],
    별칭: ["별칭", "별명", "다른이름", "alias", "aliases"],
    ERP코드: ["erp코드", "이카운트코드", "erp_code"],
  };

  /** 열 이름이 달라도(이카운트 품목 내보내기 등) 품목코드·품목명·규격·단위·별칭을 찾아 읽는다. */
  function readItemsCsv(text) {
    const rows = ON.parseCsvRows(text);
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h).replace(/\s+/g, "").toLowerCase());
    const idx = {};
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
      const i = header.findIndex((h) => names.some((n) => h === n.toLowerCase()));
      if (i >= 0) idx[field] = i;
    }
    if (idx.품목명 == null) throw new Error("'품목명' 열을 찾지 못했습니다");
    if (rows.length > 5001) throw new Error("품목이 5,000개를 넘습니다");
    return rows.slice(1).filter((r) => r.some((c) => String(c).trim())).map((r) => ({
      품목코드: idx.품목코드 != null ? r[idx.품목코드] : "", 품목명: r[idx.품목명] ?? "", 규격: idx.규격 != null ? r[idx.규격] : "",
      단위: idx.단위 != null ? r[idx.단위] : "", 별칭: idx.별칭 != null ? r[idx.별칭] : "", ERP코드: idx.ERP코드 != null ? r[idx.ERP코드] : "",
    }));
  }

  /** CSV → items. 코드가 없으면 자동 부여. 기존 사전에 합친다. */
  function importItemsCsv(ws, text, { replace = false } = {}) {
    const parsed = readItemsCsv(text);
    const existing = replace ? [] : ws.items.slice();
    const byCode = new Map(existing.map((i) => [i.품목코드, i]));
    const byName = new Map(existing.map((i) => [ON.normName(i.품목명), i]));
    let added = 0, updated = 0;
    for (const p of parsed) {
      const item = normalizeItem(p);
      if (!item.품목명) continue;
      if (!item.품목코드) item.품목코드 = nextCode(byCode);
      const prev = byCode.get(item.품목코드) || byName.get(ON.normName(item.품목명));
      if (prev) {
        Object.assign(prev, { 품목명: item.품목명, 규격: item.규격 || prev.규격, 단위: item.단위 || prev.단위, ERP코드: item.ERP코드 || prev.ERP코드 });
        for (const a of item.별칭) if (!prev.별칭.includes(a)) prev.별칭.push(a);
        updated++;
      } else {
        existing.push(item);
        byCode.set(item.품목코드, item);
        byName.set(ON.normName(item.품목명), item);
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

  function findItemByName(ws, name) {
    const k = ON.normName(name);
    return k ? ws.items.find((i) => ON.normName(i.품목명) === k || i.별칭.some((a) => ON.normName(a) === k)) || null : null;
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
    for (const c of Object.values(ws.clients)) for (const k of ["직전주문", "이전주문"]) if (c[k] && hasOwn(c[k], code)) delete c[k][code];
    for (const m of Object.values(ws.clientAliases)) for (const k of Object.keys(m)) if (m[k] === code) delete m[k];
  }

  /** 담당자가 확인 큐에서 고른 표현을 별칭으로 기억한다. 다른 품목의 이름/별칭과 겹치면 거부. */
  function learnAlias(ws, code, alias, meta = {}) {
    const a = str(alias, 30);
    if (!a || /[\[\]\n\r]/.test(a) || a.startsWith("(")) return { ok: false, reason: "별칭으로 쓸 수 없는 표현" };
    const item = ws.items.find((i) => i.품목코드 === code);
    if (!item) return { ok: false, reason: "품목 없음" };
    const key = ON.normName(a);
    if (!key || /^[\d.]+$/.test(key)) return { ok: false, reason: "숫자만으로는 별칭이 될 수 없음" };
    if (meta.client && meta.clientOnly) {
      const cl = str(meta.client, 60);
      if (!hasOwn(ws.clientAliases, cl)) ws.clientAliases[cl] = {};
      ws.clientAliases[cl][key] = code;
      item.학습.push({ 별칭: a, 날짜: meta.date || today(), 거래처: cl, 범위: cl });
      return { ok: true, clientOnly: true, alias: a, scope: cl };
    }
    for (const other of ws.items) {
      const names = [other.품목명, ...other.별칭].map(ON.normName);
      if (names.includes(key)) {
        return other.품목코드 === code ? { ok: true, already: true } : { ok: false, reason: `'${a}'는 이미 ${other.품목명}의 이름/별칭` };
      }
    }
    item.별칭.push(a);
    item.학습.push({ 별칭: a, 날짜: meta.date || today(), 거래처: str(meta.client, 60) });
    return { ok: true, alias: a, scope: "" };
  }

  /** 잘못 배운 별칭을 되돌린다. */
  function forgetAlias(ws, code, alias, scope = "") {
    const key = ON.normName(alias);
    const item = ws.items.find((i) => i.품목코드 === code);
    if (!item) return false;
    if (scope) {
      if (hasOwn(ws.clientAliases, scope) && ws.clientAliases[scope][key] === code) delete ws.clientAliases[scope][key];
    } else {
      item.별칭 = item.별칭.filter((x) => ON.normName(x) !== key);
    }
    item.학습 = item.학습.filter((l) => !(ON.normName(l.별칭) === key && (l.범위 || "") === scope));
    return true;
  }

  /** '1<주문단위> = factor<마스터단위>' 를 품목에 기억한다. */
  function learnConversion(ws, code, unit, factor) {
    const item = ws.items.find((i) => i.품목코드 === code);
    const u = str(unit, 10);
    if (!item || !u || !(factor > 0) || !Number.isFinite(factor)) return false;
    item.환산[u] = Math.round(factor * 1000) / 1000;
    return true;
  }

  // ------------------------------------------------------------ 거래처
  function clientNameFor(ws, kakaoName) {
    const n = str(kakaoName, 60);
    if (!n) return "";
    if (hasOwn(ws.clients, n)) return n;
    for (const [name, c] of Object.entries(ws.clients)) if ((c.표시이름 || []).includes(n)) return name;
    return n;
  }

  function ensureClient(ws, name, kakaoName) {
    const n = str(name, 60);
    if (!n) return null;
    if (!hasOwn(ws.clients, n)) ws.clients[n] = normalizeClient({}, null);
    const c = ws.clients[n];
    const k = str(kakaoName, 60);
    if (k && k !== n && !c.표시이름.includes(k)) c.표시이름.push(k);
    return c;
  }

  /** 이름을 바꾸면 오늘 작업의 담당자 결정·보냄 표시·캐시도 새 이름으로 옮긴다. */
  function renameClient(ws, from, to) {
    const t = str(to, 60);
    if (!t || t === from) return false;
    if (!hasOwn(ws.clients, from)) return false;
    if (hasOwn(ws.clients, t)) throw new Error(`거래처 '${t}' 가 이미 있습니다`);
    const c = normalizeClient(ws.clients[from], null);
    if (!c.표시이름.includes(from)) c.표시이름.push(from);
    delete ws.clients[from];
    ws.clients[t] = c;
    if (hasOwn(ws.clientAliases, from)) { ws.clientAliases[t] = { ...(ws.clientAliases[t] || {}), ...ws.clientAliases[from] }; delete ws.clientAliases[from]; }
    const rekey = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k.startsWith(`${from}|`) ? `${t}|${k.slice(from.length + 1)}` : k] = v;
      return out;
    };
    const s = ws.session;
    s.resolutions = rekey(s.resolutions);
    s.extracted = rekey(s.extracted);
    s.confirmedKeys = s.confirmedKeys.map((k) => (k.startsWith(`${from}|`) ? `${t}|${k.slice(from.length + 1)}` : k));
    if (hasOwn(s.sent, from)) { s.sent[t] = s.sent[from]; delete s.sent[from]; }
    s.countedClients = s.countedClients.map((n) => (n === from ? t : n));
    return true;
  }

  /** "어제 거 그대로"에 쓸 거래처별 직전 주문. 이 세션의 납품분을 이미 확정했으면, 그 확정이 덮어쓴 이전 주문을 쓴다(오늘 주문이 자기 자신을 참조하지 않게). */
  function history(ws) {
    const h = {};
    const confirmed = ws.session.confirmedAt ? ws.session.confirmedDate : null;
    for (const [name, c] of Object.entries(ws.clients)) {
      const o = confirmed && c.직전주문일 === confirmed ? c.이전주문 : c.직전주문;
      if (o && Object.keys(o).length) h[name] = o;
    }
    return h;
  }

  // ------------------------------------------------------------ 하루 확정
  /** 처리 결과(정상 줄)를 거래처별 직전 주문으로 저장하고 기록을 남긴다. 같은 세션을 다시 확정하면 같은 날 기록을 덮어쓴다. */
  function confirmDay(ws, result, meta = {}) {
    const { resolved, summary } = result;
    const mainDate = ws.session.confirmedDate || result.mainDate;
    const perClient = {};
    for (const r of resolved) {
      if (r.status !== "정상") continue;
      const name = r.order.거래처;
      if (!hasOwn(perClient, name)) perClient[name] = {};
      perClient[name][r.item.품목코드] = Math.round(((perClient[name][r.item.품목코드] || 0) + r.수량) * 1000) / 1000;
    }
    const when = new Date().toISOString();
    for (const [name, order] of Object.entries(perClient)) {
      const c = ensureClient(ws, name);
      if (c.직전주문일 !== mainDate && Object.keys(c.직전주문 || {}).length) { c.이전주문 = c.직전주문; c.이전주문일 = c.직전주문일; } // 같은 날을 다시 확정하면 이전 것을 유지
      c.직전주문 = order;
      c.직전주문일 = mainDate;
      if (!ws.session.countedClients.includes(name)) { c.주문횟수 = (c.주문횟수 || 0) + 1; ws.session.countedClients.push(name); }
    }
    const learned = Object.values(ws.session.resolutions).filter((r) => r && r.learned).length;
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
    ws.session.confirmedDate = mainDate;
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
    const codes = new Set(ws.items.map((i) => i.품목코드));
    for (const [name, v] of Object.entries(hist)) ws.clients[name] = normalizeClient({ 직전주문: v["품목"], 직전주문일: v["주문일"], 주문횟수: 1 }, codes);
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

  /** 오늘 날짜(현지 시간 기준). UTC 로 하면 한국에서는 아침 9시까지 어제가 된다. */
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    itemsCsv, importItemsCsv, addItem, removeItem, normalizeItem, findItemByName, learnAlias, forgetAlias, learnConversion,
    clientNameFor, ensureClient, renameClient, history, confirmDay, newDay, loadSample, leaveSample, loadDefaultItems, stats, today, readItemsCsv, validDate,
  };
  root.OrderNoteStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
