// 오더노트 화면 로직. 두 환경에서 돈다.
//  - 일반 브라우저(GitHub Pages): AI 해석은 Anthropic API 키로 SDK 호출, 파일은 blob 링크로 다운로드, 인쇄 가능
//  - claude.ai Artifact(window.claude 있음): AI 해석은 claude.use("sample")로 보는 사람 계정에서 호출(키 불필요),
//    파일은 claude.use("downloads")로 저장. 외부 API 호출·직접 다운로드·인쇄는 Artifact에서 막혀 있다.
// 데이터(품목 사전·거래처·기록·오늘 작업)는 web/store.js 를 통해 localStorage 에 저장한다.
const ON = window.OrderNote;
const Kakao = window.OrderNoteKakao;
const Store = window.OrderNoteStore;
const CONFIG = window.ORDERNOTE_CONFIG || {};
const IN_CLAUDE = typeof window.claude?.use === "function";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

const state = { ws: null, sample: null, gold: null, parsed: null, orders: [], result: null, claudeSample: undefined, view: null };

// ============================================================ 저장
let saveTimer = null;
function touch(immediate = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    if (!state.ws) return;
    const ok = Store.save(state.ws);
    const el = $("#storage-status");
    if (el) el.textContent = ok ? `마지막 저장 ${new Date().toLocaleTimeString("ko-KR")}.` : "저장 실패: 이 브라우저는 저장소를 막고 있습니다(시크릿 창?).";
    if (!ok) showError("브라우저 저장소에 저장하지 못했습니다. 시크릿 창이거나 저장 공간이 막혀 있으면 데이터가 남지 않습니다. 설정 → 백업으로 내보내 두세요.");
  };
  if (immediate) doSave(); else saveTimer = setTimeout(doSave, 300);
}

function showError(msg) {
  const el = $("#error");
  el.textContent = msg || "";
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: "nearest" });
}

// ============================================================ 샘플 데이터
async function fetchText(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path} 불러오기 실패 (${r.status})`);
  return r.text();
}

async function loadSampleData() {
  if (state.sample) return state.sample;
  const d = CONFIG.data || {};
  const [items, history, orders, expected, defaultItems] = await Promise.all([
    d.items ?? fetchText("data/items.csv"), d.history ?? fetchText("data/history.json"),
    d.orders ?? fetchText("input/orders.txt"), d.expected ?? fetchText("data/expected.json"),
    d.defaultItems ?? fetchText("data/items_default.csv").catch(() => null),
  ]);
  state.sample = { items, history, orders, expected, defaultItems };
  state.gold = JSON.parse(expected);
  return state.sample;
}

// ============================================================ AI 해석기
class LLMExtractor {
  constructor(catalog, history, apiKey, model) { Object.assign(this, { catalog, history, apiKey, model, name: `AI (${model})` }); }
  async init() {
    const { default: Anthropic } = await import("./vendor/anthropic-sdk.mjs");
    this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 25000 });
  }
  async extract(order) {
    let resp;
    try {
      resp = await this.client.beta.messages.create({
        model: this.model, max_tokens: 16000, system: ON.SYSTEM_PROMPT,
        messages: [{ role: "user", content: ON.llmPrompt(order, this.history, this.catalog) }],
        output_config: { effort: "low", format: { type: "json_schema", schema: ON.ORDER_SCHEMA } },
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      });
    } catch (e) {
      const status = e?.status;
      throw Object.assign(new Error(`API ${status || ""} ${e?.message || e}`.trim()), { retry: !(status === 401 || status === 403 || status === 404 || status === 400) });
    }
    if (resp.stop_reason === "refusal") throw new Error("모델이 응답을 거절함");
    return ON.validateExtracted(JSON.parse(resp.content.filter((b) => b.type === "text").map((b) => b.text).join("")));
  }
}

const SAMPLE_FORMAT = `출력: 아래 형식의 JSON 객체 하나만 답한다. 다른 글은 쓰지 않는다.
{"lines": [{"품목명_원문": "대파", "규격": null, "수량": 3, "단위": "단", "납품일": "2026-10-18", "메모": null, "확신도": 0.95}]}
- 품목명_원문(문자열)과 확신도(0~1 숫자)는 필수. 규격·수량·단위·납품일·메모는 모르면 null.`;
const SAMPLE_STOP = {
  not_granted: "Claude 사용을 허용하지 않아서 AI 해석을 멈췄습니다.", sampling_disabled: "이 계정에서는 Claude 호출을 쓸 수 없습니다.",
  session_expired: "claude.ai 로그인이 만료됐습니다. 다시 로그인한 뒤 시도하세요.", rate_limited: "Claude 호출 한도에 걸렸습니다. 잠시 후 다시 시도하세요.",
  not_declared: "이 페이지에서 Claude 호출이 꺼져 있습니다.", capability_disabled: "이 화면에서는 Claude 호출을 쓸 수 없습니다.", capability_removed: "이 앱 버전에서는 Claude 호출을 쓸 수 없습니다.",
};

class SampleExtractor {
  constructor(catalog, history, sample) { Object.assign(this, { catalog, history, sample, name: "AI (claude.ai 계정)", concurrency: 2, stopped: "" }); }
  async extract(order) {
    if (this.stopped) throw Object.assign(new Error(this.stopped), { retry: false });
    const prompt = `${ON.SYSTEM_PROMPT}\n\n${ON.llmPrompt(order, this.history, this.catalog)}\n\n${SAMPLE_FORMAT}`;
    let data;
    try { data = await this.sample.json(prompt, { modelTier: "quick" }); }
    catch (e) {
      const code = e?.code || "upstream_error";
      if (SAMPLE_STOP[code]) this.stopped = SAMPLE_STOP[code];
      throw Object.assign(new Error(`${code}: ${e?.message || ""}`), { retry: code === "upstream_error" });
    }
    return ON.validateExtracted(data);
  }
}

/** AI가 실패한 주문은 기본(규칙) 방식으로 처리해 밤에 멈추지 않게 한다. */
class FallbackExtractor {
  constructor(ai, rule) { Object.assign(this, { ai, rule, name: ai.name, cacheKey: ai.name, concurrency: ai.concurrency, fallbacks: 0 }); }
  get stopped() { return this.ai.stopped; }
  async extract(order) {
    try { return await this.ai.extract(order); }
    catch (e) {
      if (e && e.retry !== false && !this._retried?.has(order)) { (this._retried ||= new Set()).add(order); throw e; }
      this.fallbacks++;
      const ext = await this.rule.extract(order);
      for (const l of ext.lines) l.메모 = `AI 실패(${String(e.message).slice(0, 60)}) → 기본 방식`;
      return ext;
    }
  }
}

function availableEngines() {
  const list = [{ id: "rule", label: "기본 (규칙)" }];
  if (IN_CLAUDE) { if (state.claudeSample) list.push({ id: "claude", label: "AI (claude.ai 계정)" }); }
  else list.push({ id: "llm", label: "AI (API 키)" });
  return list;
}

function effectiveEngine() {
  const want = state.ws.settings.engine;
  return availableEngines().some((e) => e.id === want) ? want : "rule";
}

async function makeExtractor(catalog, history) {
  const s = state.ws.settings;
  const eng = effectiveEngine();
  const rule = new ON.RuleExtractor(catalog, history);
  if (eng === "claude") return new FallbackExtractor(new SampleExtractor(catalog, history, state.claudeSample), rule);
  if (eng === "llm") {
    if (!s.apiKey) throw new Error("설정에서 Anthropic API 키를 넣거나 해석 방식을 '기본'으로 바꾸세요.");
    const ex = new LLMExtractor(catalog, history, s.apiKey, s.model || "claude-opus-5-5");
    await ex.init();
    return new FallbackExtractor(ex, rule);
  }
  return rule;
}

async function setupClaude() {
  if (!IN_CLAUDE) { state.claudeSample = null; return; }
  $$("#print-picking, #print-detail").forEach((b) => (b.hidden = true));
  state.claudeSample = await window.claude.use("sample");
  const dl = await window.claude.use("downloads");
  if (!dl) $$("#dl-xlsx, #dl-erp, #dl-csv, #s-export, #items-export, #backup-now").forEach((b) => (b.hidden = true));
  renderEngineLine();
  if (state.view === "settings") renderSettings();
}

// ============================================================ 화면 전환
const VIEWS = ["onboard", "inbox", "items", "clients", "history", "settings"];
function showView(name) {
  state.view = name;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
  $$("#nav button").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $("#nav").hidden = name === "onboard";
  showError("");
  if (name === "items") renderItems();
  if (name === "clients") renderClients();
  if (name === "history") renderHistory();
  if (name === "settings") renderSettings();
  if (name === "inbox") renderEngineLine();
  renderBanners();
  try { history.replaceState(null, "", name === "inbox" || name === "onboard" ? location.pathname : `#${name}`); } catch { /* ignore */ }
}

function renderChrome() {
  const ws = state.ws;
  $("#ws-name").textContent = ws ? ws.settings.유통사명 : "";
  $("#nav-items").textContent = ws ? ws.items.length : "";
  $("#nav-clients").textContent = ws ? Object.keys(ws.clients).length : "";
  $("#data-info").textContent = ws ? `품목 ${ws.items.length}개 · 거래처 ${Object.keys(ws.clients).length}곳 · 확정 ${ws.days.length}일` : "";
  renderBanners();
}

function renderBanners() {
  const ws = state.ws;
  $("#sample-banner").hidden = !(ws && ws.settings.sample && state.view !== "onboard");
  const bb = $("#backup-banner");
  if (!ws || ws.settings.sample || !ws.days.length || state.view === "onboard") { bb.hidden = true; return; }
  const last = ws.lastBackupAt ? new Date(ws.lastBackupAt) : null;
  const daysAgo = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
  const stale = daysAgo == null || daysAgo >= 3;
  bb.hidden = !stale;
  if (stale) $("#backup-banner-text").textContent = daysAgo == null ? "아직 백업을 받은 적이 없습니다. 데이터는 이 브라우저에만 있습니다." : `마지막 백업이 ${daysAgo}일 전입니다.`;
}

// ============================================================ 온보딩
function startWorkspace(ws) {
  ws.settings.유통사명 = ws.settings.유통사명 || $("#ob-name").value.trim() || "우리 유통사";
  ws.settings.onboarded = true;
  ws.createdAt = ws.createdAt || new Date().toISOString();
  state.ws = ws;
  state.result = null;
  ON.setDistributor(ws.settings.유통사명, ws.settings.confirmFooter);
  touch(true);
  renderChrome();
  $("#orders").value = ws.session.ordersText || "";
  $("#delivery-date").value = ws.session.deliveryDate || defaultDeliveryDate();
  $("#results").hidden = true;
  $("#progress").textContent = "";
  showView("inbox");
  parseInput();
}

function readFile(input) {
  return new Promise((resolve, reject) => {
    const f = input.files && input.files[0];
    if (!f) return reject(new Error("파일을 고르지 않았습니다"));
    const fr = new FileReader();
    fr.onload = () => resolve(decodeText(fr.result));
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다"));
    fr.readAsArrayBuffer(f);
  });
}

// UTF-8(BOM) 우선, 깨지면 EUC-KR(엑셀 기본 CSV) 로 다시 읽는다
function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, ""); }
  catch { try { return new TextDecoder("euc-kr").decode(buf); } catch { return new TextDecoder().decode(buf); } }
}

// ============================================================ 주문 입력
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultDeliveryDate() {
  const s = state.ws?.settings || {};
  const d = new Date();
  d.setDate(d.getDate() + (s.leadDays ?? 1));
  const skip = new Set(s.noDeliveryDays || []);
  for (let i = 0; i < 7 && skip.has(d.getDay()); i++) d.setDate(d.getDate() + 1);
  return fmtDate(d);
}

function labelDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}(${DAY_NAMES[new Date(y, m - 1, d).getDay()]})`;
}

function currentRoles(stats, parsed) {
  const ws = state.ws;
  const me = new Set(ws.settings.담당자이름.map(norm));
  const saved = ws.session.senders || {};
  const roles = {};
  const partners = new Set((parsed.partners || []).map(norm));
  const nonPartner = stats.filter((s) => partners.size && !partners.has(norm(s.name)));
  for (const s of stats) {
    if (saved[s.name]) roles[s.name] = saved[s.name];
    else if (me.has(norm(s.name))) roles[s.name] = "me";
    // 1:1 방 헤더의 상대가 아닌 발신자가 딱 한 명이면 그 사람이 우리 담당자. 방 여러 개에 다 나오는 사람도 우리 담당자.
    else if ((nonPartner.length === 1 && nonPartner[0] === s) || ((parsed.rooms || 0) >= 2 && s.rooms >= 2)) roles[s.name] = "me";
    else roles[s.name] = "order";
  }
  return roles;
}

function parseInput() {
  const ws = state.ws;
  const text = $("#orders").value;
  if (ws.session.ordersText !== text) {
    if (text.trim() && !ws.session.startedAt) ws.session.startedAt = new Date().toISOString();
    ws.session.ordersText = text;
    touch();
  }
  const parsed = Kakao.parseMessages(text, { baseDate: Store.today() });
  state.parsed = parsed;
  const stats = Kakao.senderStats(parsed.messages);
  const roles = currentRoles(stats, parsed);
  state.orders = Kakao.toOrders(parsed.messages, {
    roles, mergeGapMin: ws.settings.mergeGapMin, clientNameFor: (n) => Store.clientNameFor(ws, n), deliveryDate: ws.session.deliveryDate || null,
  });
  const st = $("#parse-status");
  if (!text.trim()) { st.textContent = ""; $("#senders").innerHTML = ""; return; }
  const clients = new Set(state.orders.map((o) => o.거래처)).size;
  let msg = `${Kakao.describeFormat(parsed.formats)} · 메시지 ${parsed.messages.length}개 → 주문 ${state.orders.length}건 · 거래처 ${clients}곳`;
  if (parsed.duplicates) msg += ` · 중복 ${parsed.duplicates}개 제외`;
  if (parsed.formats.includes("copy-nodate")) msg += " · 날짜가 없어 오늘 받은 것으로 봅니다";
  if (parsed.formats.includes("plain")) msg += " · 형식 없는 줄은 '(발신자 없음)' 주문으로 묶었습니다";
  st.textContent = msg;
  renderSenders(stats, roles);
}

function renderSenders(stats, roles) {
  const box = $("#senders");
  if (stats.length < 2 && !(stats[0] && roles[stats[0].name] !== "order")) { box.innerHTML = ""; return; }
  box.innerHTML = `<span class="muted small" style="align-self:center">발신자:</span>` + stats.map((s) => `
    <span class="sender ${roles[s.name] === "order" ? "" : "me"}">
      <span>${esc(s.name)} <span class="muted small">${s.count}</span></span>
      <select data-sender="${esc(s.name)}" aria-label="${esc(s.name)} 역할">
        <option value="order" ${roles[s.name] === "order" ? "selected" : ""}>주문 거래처</option>
        <option value="me" ${roles[s.name] === "me" ? "selected" : ""}>우리 담당자</option>
        <option value="skip" ${roles[s.name] === "skip" ? "selected" : ""}>제외</option>
      </select>
    </span>`).join("");
  box.querySelectorAll("select").forEach((sel) => sel.addEventListener("change", () => {
    state.ws.session.senders[sel.dataset.sender] = sel.value;
    if (sel.value === "me" && !state.ws.settings.담당자이름.includes(sel.dataset.sender)) state.ws.settings.담당자이름.push(sel.dataset.sender);
    touch();
    parseInput();
    if (state.result) process();
  }));
}

function renderEngineLine() {
  if (!state.ws) return;
  const eng = effectiveEngine();
  const names = { rule: "기본 (규칙)", llm: "AI (API 키)", claude: "AI (claude.ai 계정)" };
  $("#engine-label").textContent = names[eng];
  const hint = $("#engine-hint");
  if (state.ws.settings.engine !== eng) hint.textContent = "설정한 AI 방식을 이 화면에서는 쓸 수 없어 기본 방식으로 돕니다.";
  else if (eng === "rule") hint.textContent = "붙여넣으면 바로 처리됩니다. 사전에 없는 표현은 확인 큐로 갑니다.";
  else if (eng === "claude") hint.textContent = "주문 1건당 Claude 호출 1회, 2건씩. 처음이면 허용 여부를 묻습니다. '처리하기'를 눌러야 호출합니다.";
  else hint.textContent = "주문 1건당 API 호출 1회. '처리하기'를 눌러야 호출합니다.";
}

// ============================================================ 처리
let processing = false;
let queued = false;
async function process() {
  if (processing) { queued = true; return; }
  const ws = state.ws;
  showError("");
  parseInput();
  if (!state.orders.length) { if (state.result) { state.result = null; $("#results").hidden = true; } return showError("처리할 주문이 없습니다. 카톡 대화를 붙여넣고, 발신자가 전부 '우리 담당자'로 되어 있지 않은지 확인하세요."); }
  if (!ws.items.length) return showError("품목 사전이 비어 있습니다. 품목 사전 화면에서 CSV를 올리거나 품목을 추가하세요.");
  const btn = $("#run");
  processing = true;
  btn.disabled = true;
  $("#progress").textContent = "처리 중…";
  try {
    const catalog = new ON.Catalog(ws.items, ws.clientAliases);
    const history = Store.history(ws);
    const extractor = await makeExtractor(catalog, history);
    if (extractor.ai instanceof SampleExtractor) $("#progress").textContent = "Claude 응답 기다리는 중… (처음이면 허용 여부를 묻습니다)";
    const res = await ON.runOrders({
      orders: state.orders, catalog, history, extractor, concurrency: extractor.concurrency,
      cache: ws.session.extracted, resolutions: ws.session.resolutions,
      onProgress: (done, total) => { $("#progress").textContent = `해석 ${done}/${total}건`; },
    });
    state.result = res;
    render(res);
    const failed = res.resolved.filter((r) => r.사유.startsWith("구조화 실패"));
    $("#progress").textContent = `완료 · ${res.summary.seconds.toFixed(2)}초` + (extractor.fallbacks ? ` · AI 실패 ${extractor.fallbacks}건은 기본 방식으로 처리` : "");
    if (extractor.stopped) showError(`${extractor.stopped} 남은 주문은 기본 방식으로 처리했습니다.`);
    else if (failed.length) showError(`${failed.length}건은 해석하지 못해 확인 큐로 보냈습니다. 첫 오류: ${failed[0].line.메모}`);
    touch();
  } catch (e) {
    showError(e.message);
    $("#progress").textContent = "";
  } finally {
    processing = false;
    btn.disabled = false;
    if (queued) { queued = false; process(); }
  }
}

// ============================================================ 결과 렌더링
function isAdded(r) {
  const s = state.ws.session;
  return !!s.confirmedAt && s.confirmedKeys && !s.confirmedKeys.includes(r.key);
}

function render(res) {
  const s = res.summary;
  const ws = state.ws;
  $("#results").hidden = false;
  $("#k-orders").textContent = `${s.orders}건`;
  $("#k-orders-note").textContent = `품목 ${s.lines}줄 · 거래처 ${s.clients}곳 · ${labelDate(res.mainDate)} 납품`;
  const autoRate = pct(s.autoLines, s.lines);
  $("#k-auto").textContent = `${autoRate}%`;
  $("#k-auto-note").textContent = `${s.autoLines}/${s.lines}줄 · 목표 85%`;
  $("#k-auto-tile").classList.toggle("good", autoRate >= 85);
  $("#k-pending").textContent = `${s.pendingLines}줄`;
  $("#k-pending-note").textContent = s.pendingLines ? `${pct(s.pendingLines, s.lines)}% · 주문 ${s.pendingOrders}건 · 목표 15% 이하` : "남은 확인 없음";
  $("#k-pending-tile").classList.toggle("warn", s.pendingLines > 0);
  $("#k-resolved").textContent = `${s.resolvedLines}줄`;
  const added = ws.session.confirmedAt ? res.resolved.filter(isAdded).length : 0;
  $("#k-resolved-note").textContent = [s.excludedLines ? `제외 ${s.excludedLines}줄` : "", added ? `확정 후 추가분 ${added}줄` : ""].filter(Boolean).join(" · ") || "확인 큐에서 고른 것";
  $("#k-time").textContent = `${s.seconds.toFixed(2)}초`;
  $("#k-engine").textContent = s.engine + (s.cachedOrders ? ` · 캐시 ${s.cachedOrders}건` : "");
  $("#tab-queue").textContent = `확인 큐 (${s.pendingLines})`;

  const evalEl = $("#eval");
  if (state.gold && state.sample && ws.settings.sample && $("#orders").value.trim() === state.sample.orders.trim() && !Object.keys(ws.session.resolutions).length) {
    const ev = ON.evaluate(res.resolved, res.orders, state.gold);
    evalEl.className = `eval ${ev.wrong.length ? "fail" : "pass"}`;
    evalEl.textContent = `샘플 정답셋 비교 — 잘못 매칭 ${ev.wrong.length}건 · 누락 ${ev.missed.length}건 · 확인필요 개수 불일치 ${ev.pendingDiff.length}건`;
    evalEl.hidden = false;
  } else evalEl.hidden = true;

  const cs = $("#confirm-state");
  cs.textContent = ws.session.confirmedAt ? `${labelDate(res.mainDate)} 납품분 확정됨 ${new Date(ws.session.confirmedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} · 추가 처리 후 다시 확정하면 덮어씁니다` : "";
  $("#confirm-day").textContent = ws.session.confirmedAt ? `${labelDate(res.mainDate)} 납품분 다시 확정` : `${labelDate(res.mainDate)} 납품분 확정`;

  renderQueue(res);
  renderConfirm(res);
  renderPicking(res);
  renderDetail(res);
}

function table(headers, rows, rowClass = () => "", stack = false) {
  return `<div class="table-wrap"><table class="${stack ? "stack" : ""}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r, i) => `<tr class="${rowClass(i)}">${r.map((c, j) => `<td data-label="${esc(headers[j])}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function queueRows(res) {
  return res.resolved.filter((r) => r.status === "확인필요");
}

function renderQueue(res) {
  const rows = queueRows(res);
  const panel = $('[data-panel="queue"]');
  if (!rows.length) { panel.innerHTML = `<p class="empty">확인할 줄이 없습니다. 배송표를 내려받고 납품분을 확정하세요.</p>`; return; }
  // 같은 표현끼리 묶어서 보여준다(한 번 고르면 함께 해결)
  const groups = new Map();
  for (const r of rows) { const k = `${norm(r.line.품목명_원문)}|${ON.canonicalUnit(r.line.단위) || ""}|${r.사유.startsWith("수량") ? "q" : ""}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  panel.innerHTML = `<p class="hint">자동으로 확정하지 않은 줄입니다. <strong>해결</strong>을 눌러 품목과 수량을 고르면 바로 배송표에 들어가고, 고른 표현은 품목 사전이 기억합니다. 같은 표현은 한 번에 함께 해결됩니다.</p>` +
    `<div class="row" style="margin-bottom:8px"><button type="button" class="primary small" id="queue-start">처음부터 차례로 해결 (${rows.length}줄)</button></div>` +
    table(["주문", "거래처", "원문", "사유", "후보", ""], rows.map((r) => {
      const same = groups.get(`${norm(r.line.품목명_원문)}|${ON.canonicalUnit(r.line.단위) || ""}|${r.사유.startsWith("수량") ? "q" : ""}`).length;
      return [
        `#${r.order.순번} <span class="muted">${esc(r.order.수신시각.text.slice(11))}</span>${isAdded(r) ? ' <span class="badge add">추가분</span>' : ""}`,
        esc(r.order.거래처),
        `<strong>${esc(ON.rawText(r))}</strong>${same > 1 ? ` <span class="badge">같은 표현 ${same}건</span>` : ""}<div class="muted small">${esc(r.order.본문)}</div>`,
        esc(r.사유),
        r.후보.length ? r.후보.map((c) => `<span class="chip">${esc(c)}</span>`).join(" ") : `<span class="muted">없음</span>`,
        `<button type="button" class="small primary" data-resolve="${esc(r.key)}">해결</button>`,
      ];
    }), () => "pending", true);
  panel.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", () => openResolve(b.dataset.resolve)));
  $("#queue-start")?.addEventListener("click", () => openResolve(rows[0].key));
}

function renderConfirm(res) {
  const panel = $('[data-panel="confirm"]');
  const list = ON.confirmations(res.resolved).sort((a, b) => a.client.localeCompare(b.client, "ko"));
  const sent = state.ws.session.sent || {};
  const done = list.filter((c) => sent[c.client]).length;
  $("#tab-confirm").textContent = `거래처 확인서 (${done}/${list.length})`;
  panel.innerHTML = `<p class="hint">거래처 카톡에 그대로 붙여넣는 확인 문구입니다. 복사하면 '보냄'으로 표시되고 다음 거래처로 넘어갑니다. 확인 큐가 남은 거래처는 "확인 중" 품목이 함께 적힙니다. (알림톡 자동 발송은 비즈니스 채널 심사 후 지원)</p>
    <div class="confirm-grid">${list.map((c, i) => `
    <article class="confirm ${sent[c.client] ? "sent" : ""}" id="confirm-card-${i}">
      <header><strong>${esc(c.client)}</strong>${c.pending ? `<span class="badge warn">확인 중 ${c.pending}</span>` : ""}
        <label><input type="checkbox" data-sent="${esc(c.client)}" ${sent[c.client] ? "checked" : ""}> 보냄</label>
        <button type="button" class="ghost small" data-copy="${i}">복사</button></header>
      <pre id="confirm-${i}">${esc(c.text)}</pre>
    </article>`).join("")}</div>`;
  panel.querySelectorAll("[data-sent]").forEach((cb) => cb.addEventListener("change", () => {
    state.ws.session.sent[cb.dataset.sent] = cb.checked; touch(); renderConfirm(res);
  }));
  panel.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const i = +b.dataset.copy;
    let ok = true;
    try { await navigator.clipboard.writeText(list[i].text); b.textContent = "복사됨"; }
    catch {
      ok = false;
      const range = document.createRange(); range.selectNodeContents($(`#confirm-${i}`));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      b.textContent = "선택됨 · Ctrl+C";
    }
    if (ok) {
      state.ws.session.sent[list[i].client] = true; touch();
      setTimeout(() => { renderConfirm(res); const next = list.findIndex((c, j) => j > i && !state.ws.session.sent[c.client]); if (next >= 0) $(`#confirm-card-${next}`)?.scrollIntoView({ block: "center" }); }, 600);
    } else setTimeout(() => (b.textContent = "복사"), 2000);
  }));
}

function renderPicking(res) {
  const rows = ON.pickingList(res.resolved);
  const pending = res.summary.pendingLines;
  $('[data-panel="picking"]').innerHTML = `<h3 class="print-title">${esc(state.ws.settings.유통사명)} 피킹리스트 — ${labelDate(res.mainDate)} 납품</h3>` +
    table(["품목코드", "품목명", "규격", "단위", "합계", "거래처수", "거래처별"], rows.map((r) => [
      esc(r.item.품목코드), esc(r.item.품목명), esc(r.item.규격), esc(r.item.단위), `<strong>${ON.fmtNum(r.total)}</strong>`, r.perClient.size,
      esc([...r.perClient].map(([k, v]) => `${k} ${ON.fmtNum(v)}`).join(", ")),
    ])) + (pending ? `<p class="hint">※ 확인 큐 ${pending}줄은 피킹에서 제외됐습니다.</p>` : "");
}

function statusCell(r) {
  if (r.status === "정상") return r.resolved ? `<span class="ok-text">정상</span> <span class="muted small">담당자</span>` : `<span class="ok-text">정상</span>`;
  if (r.status === "제외") return `<span class="excluded">제외</span>`;
  return `<span class="warn-text">확인필요</span>`;
}

function renderDetail(res) {
  const groups = ON.groupBy(res.resolved, (r) => r.order.거래처);
  const panel = $('[data-panel="detail"]');
  panel.innerHTML = `<h3 class="print-title">${esc(state.ws.settings.유통사명)} 배송표 — ${labelDate(res.mainDate)} 납품</h3>` + [...groups].map(([client, rs]) => {
    const pend = rs.filter((r) => r.status === "확인필요").length;
    const okey = ON.orderKey(rs[0].order);
    const cue = rs.map((r) => ON.messageCue(r.order.본문)).find(Boolean);
    return `<details open><summary><strong>${esc(client)}</strong> <span class="muted">${rs.length}줄${pend ? ` · 확인필요 ${pend}` : ""}</span>${cue ? ` <span class="badge warn">${esc(cue)}</span>` : ""}
        <button type="button" class="ghost small" data-add="${esc(okey)}">품목 추가</button></summary>` +
      table(["품목코드", "품목명", "규격", "수량", "단위", "상태", "사유", "원문", "주문", ""], rs.map((r) => [
        esc(r.item?.품목코드 ?? ""), esc(r.item?.품목명 ?? ""), esc(r.item?.규격 ?? ""),
        r.수량 == null ? "" : ON.fmtNum(r.수량), esc(r.단위 ?? ""), statusCell(r) + (isAdded(r) ? ' <span class="badge add">추가분</span>' : ""),
        esc(r.사유), esc(ON.rawText(r)), `#${r.order.순번} ${esc(r.order.수신시각.text.slice(11))}`,
        r.resolved ? `<button type="button" class="ghost small" data-undo="${esc(r.key)}">되돌리기</button>`
          : `<button type="button" class="ghost small" data-resolve="${esc(r.key)}">${r.status === "확인필요" ? "해결" : "수정"}</button>`,
      ]), (i) => (rs[i].status === "확인필요" ? "pending" : rs[i].status === "제외" ? "excluded" : "")) + `</details>`;
  }).join("");
  panel.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", () => openResolve(b.dataset.resolve)));
  panel.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", () => { delete state.ws.session.resolutions[b.dataset.undo]; touch(); process(); }));
  panel.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", (ev) => { ev.preventDefault(); openAdd(b.dataset.add); }));
}

// ============================================================ 확인 큐 해결 창
const rd = { key: null, r: null, code: null, add: false };
const dlg = () => $("#resolve-dialog");
const itemLabel = (i) => `${esc(i.품목명)} <span class="muted small">${esc(i.규격)}·${esc(i.단위)} · ${esc(i.품목코드)}</span>`;

function sameExpressionLines(r) {
  if (!state.result || !r.line.품목명_원문 || r.line.품목명_원문.startsWith("(")) return [];
  const k = norm(r.line.품목명_원문), u = ON.canonicalUnit(r.line.단위) || "";
  return queueRows(state.result).filter((x) => x.key !== r.key && norm(x.line.품목명_원문) === k && (ON.canonicalUnit(x.line.단위) || "") === u);
}

function openResolve(key) {
  const r = state.result?.resolved.find((x) => x.key === key);
  if (!r) return;
  Object.assign(rd, { key, r, code: null, add: false });
  const q = queueRows(state.result);
  const pos = q.findIndex((x) => x.key === key);
  $("#rd-title").textContent = r.status === "확인필요" ? "확인 큐 해결" : "줄 수정";
  $("#rd-pos").textContent = pos >= 0 ? `${pos + 1} / ${q.length}` : "";
  $("#rd-raw").textContent = ON.rawText(r);
  $("#rd-reason").textContent = r.사유 ? `— ${r.사유}` : "";
  $("#rd-ctx").textContent = `${r.order.거래처} · ${r.order.수신시각.text}\n${r.order.본문}`;
  $("#rd-dismiss").hidden = false;
  const cands = r.후보.map((c) => c.split(" ")[0]).filter((c) => state.ws.items.some((i) => i.품목코드 === c));
  if (r.item && !cands.includes(r.item.품목코드)) cands.unshift(r.item.품목코드);
  renderCands(cands);
  $("#rd-search").value = "";
  renderSearch("");
  $("#rd-qty").value = "";
  $("#rd-error").hidden = true;
  $("#rd-scope").checked = false;
  const same = sameExpressionLines(r);
  $("#rd-same-wrap").hidden = !same.length;
  if (same.length) { $("#rd-same").checked = true; $("#rd-same-label").textContent = `같은 표현 '${r.line.품목명_원문}' ${same.length}건에 함께 적용 (${[...new Set(same.map((x) => x.order.거래처))].slice(0, 4).join(", ")}${same.length > 4 ? " 등" : ""})`; }
  $("#rd-ok").textContent = pos >= 0 && pos < q.length - 1 ? "확정 → 다음" : "확정";
  selectCode(r.item ? r.item.품목코드 : cands[0] || null);
  if (!dlg().open) dlg().showModal();
  (rd.code ? $("#rd-qty") : $("#rd-search")).focus();
}

function openAdd(orderKey) {
  const order = state.result?.orders.find((o) => ON.orderKey(o) === orderKey);
  if (!order) return;
  const n = Object.keys(state.ws.session.resolutions).filter((k) => k.startsWith(`${orderKey}#add-`)).length + 1;
  Object.assign(rd, { key: `${orderKey}#add-${n}`, r: { order, line: { 품목명_원문: "", 수량: null, 단위: null }, 후보: [] }, code: null, add: true });
  $("#rd-title").textContent = "품목 추가";
  $("#rd-pos").textContent = "";
  $("#rd-raw").textContent = `${order.거래처} 주문에 품목을 더합니다`;
  $("#rd-reason").textContent = "";
  $("#rd-ctx").textContent = order.본문;
  $("#rd-dismiss").hidden = true;
  $("#rd-same-wrap").hidden = true;
  renderCands([]);
  $("#rd-search").value = "";
  renderSearch("");
  $("#rd-qty").value = "";
  $("#rd-error").hidden = true;
  $("#rd-ok").textContent = "추가";
  selectCode(null);
  if (!dlg().open) dlg().showModal();
  $("#rd-search").focus();
}

function renderCands(codes) {
  const box = $("#rd-cands");
  if (!codes.length) { box.innerHTML = `<span class="muted small">없음 — 아래에서 찾거나 새 품목으로 등록하세요</span>`; return; }
  box.innerHTML = codes.map((c, i) => {
    const it = state.ws.items.find((x) => x.품목코드 === c);
    return `<button type="button" class="chip" data-code="${esc(c)}" aria-pressed="false"><span class="muted">${i + 1}</span> ${esc(it.품목명)} <span class="muted">${esc(it.규격)}·${esc(it.단위)}</span></button>`;
  }).join("");
  box.querySelectorAll("[data-code]").forEach((b) => b.addEventListener("click", () => selectCode(b.dataset.code)));
}

function renderSearch(q) {
  const box = $("#rd-list");
  const n = norm(q);
  const items = n ? state.ws.items.filter((i) => norm(i.품목명).includes(n) || norm(i.품목코드).includes(n) || i.별칭.some((a) => norm(a).includes(n))) : [];
  box.innerHTML = items.slice(0, 8).map((i) => `<button type="button" data-code="${esc(i.품목코드)}" aria-pressed="false">${itemLabel(i)}</button>`).join("");
  if (n && !items.length) box.innerHTML = `<span class="muted small">'${esc(q)}' 에 맞는 품목이 없습니다. "새 품목으로 등록"을 누르면 바로 만듭니다.</span>`;
  box.querySelectorAll("[data-code]").forEach((b) => b.addEventListener("click", () => selectCode(b.dataset.code)));
}

function selectCode(code) {
  rd.code = code;
  $$("#rd-cands [data-code], #rd-list [data-code]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.code === code)));
  const item = code ? state.ws.items.find((i) => i.품목코드 === code) : null;
  const line = rd.r.line;
  $("#rd-unit").textContent = item ? `(${item.단위}${item.규격 && item.규격 !== `1${item.단위}` ? ` · ${item.규격}` : ""})` : "";
  const qtyEl = $("#rd-qty");
  const hint = $("#rd-qty-hint");
  if (item) {
    if (!qtyEl.value) {
      if (line.수량 != null) { const conv = ON.convert(line.수량, line.단위, item); qtyEl.value = conv != null ? conv : ""; }
      else { const prev = state.ws.clients[rd.r.order.거래처]?.직전주문?.[item.품목코드]; if (prev) qtyEl.value = prev; }
    }
    hint.textContent = line.수량 != null && line.단위 ? `주문 표현: ${ON.fmtNum(line.수량)}${line.단위}` : (qtyEl.value && line.수량 == null ? "직전 주문 수량을 채워 두었습니다" : "");
  } else hint.textContent = "";
  const raw = String(line.품목명_원문 || "").trim();
  const canLearn = item && raw && !raw.startsWith("(") && !rd.add && ![item.품목명, ...item.별칭].some((n) => norm(n) === norm(raw));
  $("#rd-learn-wrap").hidden = !canLearn;
  $("#rd-scope-wrap").hidden = !canLearn;
  if (canLearn) $("#rd-learn-label").textContent = `'${raw}'을(를) ${item.품목명}의 별칭으로 기억 (다음부터 자동)`;
  updateConvLabel();
}

function updateConvLabel() {
  const item = rd.code ? state.ws.items.find((i) => i.품목코드 === rd.code) : null;
  const line = rd.r.line;
  const qty = parseFloat($("#rd-qty").value);
  const unit = ON.canonicalUnit(line.단위);
  const show = item && unit && unit !== item.단위 && line.수량 > 0 && qty > 0 && !rd.add;
  $("#rd-conv-wrap").hidden = !show;
  if (show) $("#rd-conv-label").textContent = `${item.품목명}은(는) 1${unit} = ${Math.round((qty / line.수량) * 1000) / 1000}${item.단위}로 기억 (다음부터 자동 환산)`;
}

function closeResolve() { if (dlg().open) dlg().close(); }

function newItemFromDialog() {
  const line = rd.r.line;
  const name = ($("#rd-search").value.trim() || String(line.품목명_원문 || "").trim()).replace(/^\(|\)$/g, "");
  if (!name) { $("#rd-error").textContent = "품목명을 검색란에 적은 뒤 누르세요."; $("#rd-error").hidden = false; return; }
  try {
    const unit = ON.canonicalUnit(line.단위) || "개";
    const item = Store.addItem(state.ws, { 품목명: name, 규격: `1${unit}`, 단위: unit });
    touch(); renderChrome();
    renderCands([item.품목코드]);
    $("#rd-search").value = "";
    renderSearch("");
    selectCode(item.품목코드);
    $("#rd-qty").focus();
  } catch (e) { $("#rd-error").textContent = e.message; $("#rd-error").hidden = false; }
}

async function commitResolve() {
  const ws = state.ws;
  const item = rd.code ? ws.items.find((i) => i.품목코드 === rd.code) : null;
  const qty = parseFloat($("#rd-qty").value);
  const err = $("#rd-error");
  if (!item) { err.textContent = "품목을 고르세요."; err.hidden = false; return; }
  if (!(qty > 0)) { err.textContent = "수량을 0보다 크게 입력하세요."; err.hidden = false; return; }
  const line = rd.r.line;
  const res = { code: item.품목코드, qty, learned: false };
  if (rd.add) res.원문 = $("#rd-search").value.trim() || "(담당자 추가)";
  const clientOnly = !$("#rd-scope-wrap").hidden && $("#rd-scope").checked;
  if (!$("#rd-learn-wrap").hidden && $("#rd-learn").checked) {
    const l = Store.learnAlias(ws, item.품목코드, line.품목명_원문, { client: rd.r.order.거래처, clientOnly });
    if (l.ok && !l.already) res.learned = true;
    if (!l.ok) showError(`별칭으로 기억하지 못했습니다: ${l.reason}`);
  }
  if (!$("#rd-conv-wrap").hidden && $("#rd-conv").checked) Store.learnConversion(ws, item.품목코드, ON.canonicalUnit(line.단위), qty / line.수량);
  ws.session.resolutions[rd.key] = res;
  // 같은 표현의 다른 줄도 함께: 수량은 각 줄의 주문 표현을 같은 품목 단위로 환산(안 되면 그 줄은 큐에 남긴다)
  if (!$("#rd-same-wrap").hidden && $("#rd-same").checked && !clientOnly) {
    for (const x of sameExpressionLines(rd.r)) {
      const q2 = x.line.수량 != null ? ON.convert(x.line.수량, x.line.단위, item) : (line.수량 == null ? qty : null);
      if (q2 > 0) ws.session.resolutions[x.key] = { code: item.품목코드, qty: q2, learned: false };
    }
  }
  touch();
  renderChrome();
  const wasQueue = rd.r.status === "확인필요";
  await process();
  const next = wasQueue && state.result ? queueRows(state.result)[0] : null;
  if (next) openResolve(next.key); else closeResolve();
}

async function dismissResolve() {
  state.ws.session.resolutions[rd.key] = { dismissed: true };
  touch();
  await process();
  const next = state.result ? queueRows(state.result)[0] : null;
  if (next) openResolve(next.key); else closeResolve();
}

// ============================================================ 확정 / 새 날
async function confirmDay() {
  const ws = state.ws;
  const res = state.result;
  if (!res) return;
  for (const o of res.orders) Store.ensureClient(ws, o.거래처, o.발신자);
  const rec = Store.confirmDay(ws, res);
  touch(true);
  renderChrome();
  render(res);
  $("#progress").textContent = `${labelDate(rec.납품일)} 납품분 확정 · 거래처 직전 주문 갱신됨${rec.소요분 ? ` · 소요 ${rec.소요분}분` : ""}`;
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }
  if (ws.settings.autoBackup && !ws.settings.sample && !IN_CLAUDE) await exportBackup();
}

let newDayArmed = null;
function newDay() {
  const btn = $("#new-day");
  if (!newDayArmed) {
    newDayArmed = setTimeout(() => { newDayArmed = null; btn.textContent = "새 날 시작"; }, 5000);
    btn.textContent = state.ws.session.confirmedAt || !state.result ? "정말요? 한 번 더" : "확정 안 했어요 — 그래도 지우려면 한 번 더";
    return;
  }
  clearTimeout(newDayArmed); newDayArmed = null; btn.textContent = "새 날 시작";
  Store.newDay(state.ws);
  state.result = null;
  $("#orders").value = "";
  $("#delivery-date").value = defaultDeliveryDate();
  $("#results").hidden = true;
  $("#progress").textContent = "";
  touch(true);
  parseInput();
}

// ============================================================ 다운로드 / 백업
async function saveFile(blob, filename) {
  if (IN_CLAUDE) {
    const dl = await window.claude.use("downloads");
    if (!dl) return showError("이 화면에서는 파일 저장을 쓸 수 없습니다.");
    try { await dl.save({ filename, data: blob }); return true; }
    catch (e) { if (e?.code !== "declined") showError(`파일 저장 실패 (${e?.code || "unknown"}). 잠시 후 다시 눌러 주세요.`); return false; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}

async function exportBackup() {
  const ok = await saveFile(new Blob([Store.exportJson(state.ws)], { type: "application/json" }), `오더노트_백업_${Store.today()}.json`);
  if (ok) { state.ws.lastBackupAt = new Date().toISOString(); touch(true); renderBanners(); renderBackupStatus(); }
}

function renderBackupStatus() {
  const el = $("#backup-status");
  if (!el || !state.ws) return;
  el.textContent = state.ws.lastBackupAt ? `마지막 백업 ${new Date(state.ws.lastBackupAt).toLocaleString("ko-KR")}.` : "아직 백업한 적이 없습니다.";
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.ExcelJS) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`${src} 불러오기 실패`));
    document.head.appendChild(s);
  });
}

const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF59D" } };
function addSheet(wb, name, header, rows, highlight = []) {
  const ws = wb.addWorksheet(name.replace(/[[\]:*?/\\]/g, "").slice(0, 31) || "시트", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(header).font = { bold: true };
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    if (highlight[i]) for (let c = 1; c <= header.length; c++) row.getCell(c).fill = YELLOW;
  });
  ws.columns.forEach((col, i) => {
    const width = Math.max(String(header[i]).length, ...rows.map((r) => String(r[i] ?? "").length));
    col.width = Math.min(Math.max(8, width * 1.6 + 2), 60);
  });
  return ws;
}

const DETAIL_HEAD = ["품목코드", "품목명", "규격", "수량", "단위", "상태", "사유", "원문", "메모", "주문"];
const detailRow = (r) => [r.item?.품목코드 ?? "", r.item?.품목명 ?? "", r.item?.규격 ?? "", r.수량, r.단위, r.status, r.사유, ON.rawText(r), r.line.메모 ?? "", `#${r.order.순번} ${r.order.수신시각.text.slice(11)}`];

async function withExcel(btn, fn) {
  btn.disabled = true;
  try { await loadScript(CONFIG.exceljs || "web/vendor/exceljs.min.js"); await fn(new window.ExcelJS.Workbook()); }
  catch (e) { showError(`엑셀 생성 실패: ${e.message}`); }
  finally { btn.disabled = false; }
}

function downloadXlsx() {
  const res = state.result;
  return withExcel($("#dl-xlsx"), async (wb) => {
    const pick = ON.pickingList(res.resolved);
    const ws = addSheet(wb, "피킹리스트", ["품목코드", "품목명", "규격", "단위", "합계수량", "거래처수", "거래처별"],
      pick.map((r) => [r.item.품목코드, r.item.품목명, r.item.규격, r.item.단위, r.total, r.perClient.size, [...r.perClient].map(([k, v]) => `${k} ${ON.fmtNum(v)}`).join(", ")]));
    if (res.summary.pendingLines) { ws.addRow([]); ws.addRow([`※ 확인 큐 ${res.summary.pendingLines}줄은 피킹 제외 — 확인큐.csv 참고`]).getCell(1).fill = YELLOW; }
    const added = res.resolved.filter((r) => r.status !== "제외" && isAdded(r));
    if (added.length) addSheet(wb, "추가분(확정 후)", ["거래처", ...DETAIL_HEAD], added.map((r) => [r.order.거래처, ...detailRow(r)]), added.map((r) => r.status === "확인필요"));
    for (const [client, rs] of ON.groupBy(res.resolved.filter((r) => r.status !== "제외"), (r) => r.order.거래처)) {
      addSheet(wb, client, DETAIL_HEAD, rs.map(detailRow), rs.map((r) => r.status === "확인필요"));
    }
    const buf = await wb.xlsx.writeBuffer();
    await saveFile(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `배송표_${res.mainDate.replace(/-/g, "")}.xlsx`);
  });
}

// 이카운트 "판매입력 → 웹자료올리기" 서식의 공통 골격. 같은 거래처 = 같은 순번(한 전표), 거래유형 11(과세매출), 단가·금액은 비움.
const ECOUNT_HEAD = ["일자", "순번", "거래처코드", "거래처명", "담당자", "출하창고", "거래유형", "통화", "환율", "품목코드", "품목명", "규격", "수량", "단가(vat포함)", "단가", "외화금액", "공급가액", "부가세", "적요"];
function ecountRows(res) {
  const ws = state.ws;
  const rows = [];
  let seq = 0;
  for (const [client, rs] of ON.groupBy(res.resolved.filter((r) => r.status === "정상"), (r) => r.order.거래처)) {
    seq++;
    const c = ws.clients[client];
    for (const r of rs) {
      const note = [ON.rawText(r), c?.ERP코드 ? "" : "거래처코드 없음", r.resolved ? "담당자 확인" : ""].filter(Boolean).join(" / ");
      rows.push([(r.line.납품일 || res.mainDate).replace(/-/g, ""), seq, c?.ERP코드 || "", client, "", ws.settings.warehouse || "", "11", "", "", r.item.ERP코드 || r.item.품목코드, r.item.품목명, r.item.규격, ON.fmtNum(r.수량), "", "", "", "", "", note]);
    }
  }
  return rows;
}

function downloadErp() {
  const res = state.result;
  return withExcel($("#dl-erp"), async (wb) => {
    const rows = ecountRows(res);
    const sheet = addSheet(wb, "판매입력", ECOUNT_HEAD, rows);
    sheet.getColumn(1).numFmt = "@"; sheet.getColumn(3).numFmt = "@"; sheet.getColumn(10).numFmt = "@";
    const buf = await wb.xlsx.writeBuffer();
    await saveFile(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `이카운트_판매입력_${res.mainDate.replace(/-/g, "")}.xlsx`);
  });
}

async function copyErp() {
  const rows = ecountRows(state.result);
  const tsv = rows.map((r) => r.map((c) => String(c ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");
  const btn = $("#copy-erp");
  try { await navigator.clipboard.writeText(tsv); btn.textContent = `복사됨 (${rows.length}줄, 제목행 없음)`; }
  catch { showError("클립보드를 쓸 수 없는 화면입니다. '이카운트 업로드 엑셀'을 내려받아 쓰세요."); }
  setTimeout(() => (btn.textContent = "이카운트 붙여넣기용 복사"), 2500);
}

const downloadCsv = () => saveFile(new Blob([ON.queueCsv(state.result.resolved)], { type: "text/csv;charset=utf-8" }), "확인큐.csv");

function printPanel(which) {
  document.body.classList.add(`print-${which}`);
  const after = () => document.body.classList.remove(`print-${which}`);
  window.addEventListener("afterprint", after, { once: true });
  window.print();
  setTimeout(after, 2000);
}

// ============================================================ 품목 사전 화면
function renderItems() {
  const ws = state.ws;
  const q = norm($("#items-search").value);
  const items = ws.items.filter((i) => !q || norm(i.품목명).includes(q) || norm(i.품목코드).includes(q) || i.별칭.some((a) => norm(a).includes(q)));
  const aliases = ws.items.reduce((n, i) => n + i.별칭.length, 0);
  const learned = ws.items.reduce((n, i) => n + i.학습.length, 0);
  $("#items-status").textContent = `품목 ${ws.items.length}개 · 별칭 ${aliases}개 (확인 큐에서 학습 ${learned}개)${q ? ` · 검색 ${items.length}개` : ""}`;
  const box = $("#items-table");
  if (!ws.items.length) { box.innerHTML = `<p class="empty">품목이 없습니다. CSV를 올리거나 품목 추가를 누르세요.</p>`; return; }
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>코드</th><th>품목명</th><th>규격</th><th>단위</th><th>별칭 (; 구분)</th><th>환산</th><th>ERP코드</th><th class="num">학습</th><th></th></tr></thead><tbody>` +
    items.map((i) => `<tr data-code="${esc(i.품목코드)}">
      <td><code>${esc(i.품목코드)}</code></td>
      <td><input type="text" data-f="품목명" value="${esc(i.품목명)}" aria-label="품목명"></td>
      <td><input type="text" class="short" data-f="규격" value="${esc(i.규격)}" aria-label="규격"></td>
      <td><input type="text" class="short" data-f="단위" value="${esc(i.단위)}" aria-label="단위"></td>
      <td><input type="text" data-f="별칭" value="${esc(i.별칭.join("; "))}" aria-label="별칭"></td>
      <td><input type="text" class="short" data-f="환산" value="${esc(Object.entries(i.환산).map(([u, f]) => `${u}=${f}`).join("; "))}" placeholder="박스=10" aria-label="환산"></td>
      <td><input type="text" class="short" data-f="ERP코드" value="${esc(i.ERP코드 || "")}" aria-label="ERP코드"></td>
      <td class="num">${i.학습.length || ""}</td>
      <td><button type="button" class="ghost small danger" data-del="${esc(i.품목코드)}">삭제</button></td>
    </tr>`).join("") + `</tbody></table></div>`;
  box.querySelectorAll("input[data-f]").forEach((inp) => inp.addEventListener("change", () => {
    const item = ws.items.find((x) => x.품목코드 === inp.closest("tr").dataset.code);
    const f = inp.dataset.f, v = inp.value.trim();
    if (f === "별칭") item.별칭 = v.split(";").map((a) => a.trim()).filter(Boolean);
    else if (f === "환산") {
      item.환산 = {};
      for (const part of v.split(";")) { const m = part.trim().match(/^(.+?)\s*=\s*([\d.]+)$/); if (m && parseFloat(m[2]) > 0) item.환산[ON.canonicalUnit(m[1])] = parseFloat(m[2]); }
      inp.value = Object.entries(item.환산).map(([u, f2]) => `${u}=${f2}`).join("; ");
    } else if (f === "품목명" && !v) { inp.value = item.품목명; return; }
    else item[f] = v;
    touch(); renderChrome();
  }));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.armed) { Store.removeItem(ws, b.dataset.del); touch(); renderChrome(); renderItems(); return; }
    b.dataset.armed = "1"; b.textContent = "정말 삭제";
    setTimeout(() => { delete b.dataset.armed; b.textContent = "삭제"; }, 3000);
  }));
}

function addItemRow() {
  const item = Store.addItem(state.ws, { 품목명: "새 품목", 규격: "", 단위: "개" });
  touch(); renderChrome();
  $("#items-search").value = "";
  renderItems();
  const inp = $(`#items-table tr[data-code="${CSS.escape(item.품목코드)}"] input[data-f="품목명"]`);
  if (inp) { inp.scrollIntoView({ block: "center" }); inp.focus(); inp.select(); }
}

async function importItems(input) {
  try {
    const r = Store.importItemsCsv(state.ws, await readFile(input));
    touch(); renderChrome(); renderItems();
    $("#items-status").textContent = `CSV 가져오기: 추가 ${r.added}개 · 갱신 ${r.updated}개 · 총 ${r.total}개`;
  } catch (e) { showError(`CSV 가져오기 실패: ${e.message}. 첫 줄에 품목명(또는 품명) 열이 있어야 합니다.`); }
  finally { input.value = ""; }
}

// ============================================================ 거래처 화면
function summarizeOrder(ws, order) {
  const byCode = Object.fromEntries(ws.items.map((i) => [i.품목코드, i]));
  return Object.entries(order || {}).map(([c, q]) => byCode[c] ? `${byCode[c].품목명} ${ON.fmtNum(q)}${byCode[c].단위}` : `${c} ${q}`).join(", ");
}

/** "대파 2단, 양파 1망" → {코드: 수량}. 규칙 엔진으로 읽고 사전에 있는 것만 받는다. */
async function parseLastOrder(ws, text) {
  const catalog = new ON.Catalog(ws.items, ws.clientAliases);
  const ext = await new ON.RuleExtractor(catalog, {}).extract({ 거래처: "", 수신시각: { y: 2026, mo: 1, d: 1, h: 0, mi: 0, text: "" }, 본문: text });
  const out = {}, miss = [];
  for (const l of ext.lines) {
    const m = catalog.match(l.품목명_원문);
    const q = m.item && l.수량 != null ? ON.convert(l.수량, l.단위, m.item) : null;
    if (m.item && q > 0) out[m.item.품목코드] = (out[m.item.품목코드] || 0) + q; else miss.push(l.품목명_원문);
  }
  return { out, miss };
}

function renderClients() {
  const ws = state.ws;
  const names = Object.keys(ws.clients).sort((a, b) => a.localeCompare(b, "ko"));
  const box = $("#clients-table");
  if (!names.length) { box.innerHTML = `<p class="empty">거래처가 없습니다. 납품분을 확정하면 자동으로 생기고, 직접 추가할 수도 있습니다.</p>`; return; }
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>거래처명</th><th>카톡 이름</th><th>ERP 거래처코드</th><th>직전 주문</th><th>직전 주문일</th><th class="num">주문 횟수</th><th></th></tr></thead><tbody>` +
    names.map((n) => { const c = ws.clients[n]; return `<tr data-name="${esc(n)}">
      <td><input type="text" data-f="name" value="${esc(n)}" aria-label="거래처명"></td>
      <td><input type="text" data-f="kakao" value="${esc((c.표시이름 || []).join(", "))}" placeholder="카톡에 보이는 이름" aria-label="카톡 이름"></td>
      <td><input type="text" class="short" data-f="erp" value="${esc(c.ERP코드 || "")}" aria-label="ERP 거래처코드"></td>
      <td class="small">${esc(summarizeOrder(ws, c.직전주문)) || `<span class="muted">없음</span>`}
        <div class="inline-edit"><input type="text" data-f="last" placeholder="직접 입력: 대파 2단, 양파 1망" aria-label="직전 주문 입력"></div></td>
      <td>${esc(c.직전주문일 || "")}</td>
      <td class="num">${c.주문횟수 || 0}</td>
      <td><button type="button" class="ghost small danger" data-del="${esc(n)}">삭제</button></td>
    </tr>`; }).join("") + `</tbody></table></div>`;
  box.querySelectorAll("input[data-f]").forEach((inp) => inp.addEventListener("change", async () => {
    const name = inp.closest("tr").dataset.name;
    try {
      if (inp.dataset.f === "name") Store.renameClient(ws, name, inp.value);
      else if (inp.dataset.f === "kakao") ws.clients[name].표시이름 = inp.value.split(",").map((s) => s.trim()).filter((s) => s && s !== name);
      else if (inp.dataset.f === "erp") ws.clients[name].ERP코드 = inp.value.trim();
      else if (inp.dataset.f === "last") {
        if (!inp.value.trim()) return;
        const { out, miss } = await parseLastOrder(ws, inp.value);
        if (!Object.keys(out).length) throw new Error(`알아들은 품목이 없습니다 (${miss.join(", ")}). 품목 사전의 이름과 수량·단위를 써 주세요.`);
        ws.clients[name].직전주문 = out; ws.clients[name].직전주문일 = Store.today();
        if (miss.length) showError(`사전에 없는 표현은 뺐습니다: ${miss.join(", ")}`);
      }
      touch(); renderClients();
    } catch (e) { showError(e.message); if (inp.dataset.f === "name") inp.value = name; }
  }));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.armed) { delete ws.clients[b.dataset.del]; delete ws.clientAliases[b.dataset.del]; touch(); renderChrome(); renderClients(); return; }
    b.dataset.armed = "1"; b.textContent = "정말 삭제";
    setTimeout(() => { delete b.dataset.armed; b.textContent = "삭제"; }, 3000);
  }));
}

function addClientRow() {
  const ws = state.ws;
  let name = "새 거래처", n = 1;
  while (ws.clients[name]) name = `새 거래처 ${++n}`;
  Store.ensureClient(ws, name);
  touch(); renderChrome(); renderClients();
  const inp = $(`#clients-table tr[data-name="${CSS.escape(name)}"] input[data-f="name"]`);
  if (inp) { inp.scrollIntoView({ block: "center" }); inp.focus(); inp.select(); }
}

// ============================================================ 기록 화면
function renderHistory() {
  const ws = state.ws;
  const st = Store.stats(ws);
  const k = $("#history-kpis");
  const days = ws.days.filter((d) => !d.sample || ws.settings.sample).slice().reverse();
  if (!days.length) {
    k.innerHTML = `<p class="empty">아직 확정한 날이 없습니다. 주문 처리 화면에서 "납품분 확정"을 누르면 여기에 쌓입니다.${ws.days.length ? " (샘플 모드에서 확정한 기록은 빠집니다)" : ""}</p>`;
    $("#history-table").innerHTML = "";
    return;
  }
  const before = ws.settings.beforeMinutes || 0;
  const avgMin = st.minuteDays ? Math.round(st.minutes / st.minuteDays) : null;
  const cut = before && avgMin ? Math.round((1 - avgMin / before) * 100) : null;
  k.innerHTML = `
    <div class="row" style="align-items:flex-end; gap:24px; margin-bottom:14px; flex-wrap:wrap">
      <div><div class="muted small">누적 자동 처리율 (큐 없이 바로 확정된 줄 / 전체 줄)</div><div class="hero">${Math.round(st.autoRate * 100)}%</div></div>
      <div class="kpis" style="flex:1; margin:0; grid-template-columns: repeat(4, 1fr)">
        <div class="kpi"><span class="label">확정한 날</span><span class="value">${st.days}일</span><span class="note">주문 ${st.orders}건 · ${st.lines}줄</span></div>
        <div class="kpi ${st.pendingRate <= 0.15 ? "good" : "warn"}"><span class="label">확인 큐 비율</span><span class="value">${Math.round(st.pendingRate * 100)}%</span><span class="note">확정 시점에 남은 줄 / 전체 · 목표 15%</span></div>
        <div class="kpi"><span class="label">하루 처리 시간</span><span class="value">${avgMin == null ? "–" : `${avgMin}분`}</span><span class="note">${cut == null ? (before ? "첫 붙여넣기~확정" : "설정에 도입 전 시간을 넣으면 단축률 표시") : `도입 전 ${before}분 대비 ${cut}% 단축`}</span></div>
        <div class="kpi"><span class="label">학습된 별칭</span><span class="value">${st.aliasesLearned}개</span><span class="note">담당자 확인 ${st.resolved}줄에서</span></div>
      </div>
    </div>`;
  $("#history-table").innerHTML = `<div class="table-wrap"><table><thead><tr><th>납품일</th><th class="num">주문</th><th class="num">줄</th><th>자동 처리율</th><th class="num">담당자 확인</th><th class="num">확인 큐 남음</th><th class="num">제외</th><th class="num">소요(분)</th><th class="num">학습</th><th>해석</th></tr></thead><tbody>` +
    days.map((d) => { const rate = d.라인 ? Math.round((d.자동 / d.라인) * 100) : 0; return `<tr>
      <td>${esc(d.납품일)}${d.sample ? ' <span class="badge">샘플</span>' : ""}</td><td class="num">${d.주문}</td><td class="num">${d.라인}</td>
      <td><span class="meter" aria-hidden="true"><i style="width:${rate}%"></i></span>${rate}%</td>
      <td class="num">${d.담당자확인 || 0}</td><td class="num">${d.확인}</td><td class="num">${d.제외 || 0}</td><td class="num">${d.소요분 ?? ""}</td><td class="num">${d.학습 || 0}</td><td class="small">${esc(d.engine)}</td>
    </tr>`; }).join("") + `</tbody></table></div>`;
}

// ============================================================ 설정 화면
function renderSettings() {
  const s = state.ws.settings;
  $("#s-name").value = s.유통사명;
  $("#s-me").value = s.담당자이름.join(", ");
  $("#s-footer").value = s.confirmFooter ?? "";
  $("#s-merge").value = s.mergeGapMin;
  $("#s-lead").value = s.leadDays;
  $("#s-before").value = s.beforeMinutes || "";
  $("#s-warehouse").value = s.warehouse || "";
  $("#s-key").value = s.apiKey || "";
  $("#s-model").value = s.model || "claude-opus-5-5";
  $("#s-remember").checked = !!s.rememberKey;
  $("#s-autobackup").checked = !!s.autoBackup;
  $("#s-nodays").innerHTML = DAY_NAMES.map((n, i) => `<label class="chip"><input type="checkbox" data-day="${i}" ${(s.noDeliveryDays || []).includes(i) ? "checked" : ""}> ${n}</label>`).join("");
  $$("#s-nodays input").forEach((cb) => cb.addEventListener("change", () => { s.noDeliveryDays = $$("#s-nodays input:checked").map((x) => +x.dataset.day); touch(); }));
  const avail = availableEngines().map((e) => e.id);
  $("#engine-llm-btn").hidden = !avail.includes("llm");
  $("#engine-claude-btn").hidden = !avail.includes("claude");
  $$("#engine-choice button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.engine === s.engine)));
  $("#llm-opts").hidden = s.engine !== "llm" || !avail.includes("llm");
  renderBackupStatus();
}

function bindSettings() {
  const s = () => state.ws.settings;
  $("#s-name").addEventListener("change", (e) => { s().유통사명 = e.target.value.trim() || s().유통사명; e.target.value = s().유통사명; ON.setDistributor(s().유통사명, s().confirmFooter); touch(); renderChrome(); });
  $("#s-me").addEventListener("change", (e) => { s().담당자이름 = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); });
  $("#s-footer").addEventListener("change", (e) => { s().confirmFooter = e.target.value.trim(); ON.setDistributor(s().유통사명, s().confirmFooter); touch(); });
  $("#s-merge").addEventListener("change", (e) => { s().mergeGapMin = Math.max(0, Math.min(180, +e.target.value || 0)); e.target.value = s().mergeGapMin; touch(); });
  $("#s-lead").addEventListener("change", (e) => { s().leadDays = Math.max(0, Math.min(7, +e.target.value || 0)); e.target.value = s().leadDays; touch(); });
  $("#s-before").addEventListener("change", (e) => { s().beforeMinutes = Math.max(0, +e.target.value || 0); touch(); });
  $("#s-warehouse").addEventListener("change", (e) => { s().warehouse = e.target.value.trim(); touch(); });
  $("#s-key").addEventListener("change", (e) => { s().apiKey = e.target.value.trim(); touch(); });
  $("#s-model").addEventListener("change", (e) => { s().model = e.target.value.trim() || "claude-opus-5-5"; e.target.value = s().model; touch(); });
  $("#s-remember").addEventListener("change", (e) => { s().rememberKey = e.target.checked; touch(); });
  $("#s-autobackup").addEventListener("change", (e) => { s().autoBackup = e.target.checked; touch(); });
  $$("#engine-choice button").forEach((b) => b.addEventListener("click", () => { s().engine = b.dataset.engine; touch(); renderSettings(); }));
  $("#s-export").addEventListener("click", exportBackup);
  $("#backup-now").addEventListener("click", exportBackup);
  $("#s-import").addEventListener("click", () => $("#s-import-file").click());
  $("#s-import-file").addEventListener("change", async (e) => {
    try { startWorkspace(Store.importJson(await readFile(e.target))); }
    catch (err) { showError(`백업 가져오기 실패: ${err.message}`); }
    finally { e.target.value = ""; }
  });
  let resetArmed = null;
  $("#s-reset").addEventListener("click", () => {
    const hint = $("#s-reset-hint");
    if (!resetArmed) { resetArmed = setTimeout(() => { resetArmed = null; hint.hidden = true; }, 5000); hint.hidden = false; return; }
    clearTimeout(resetArmed); resetArmed = null; hint.hidden = true;
    try { localStorage.removeItem(Store.KEY); } catch { /* ignore */ }
    state.ws = null; state.result = null;
    $("#orders").value = "";
    $("#results").hidden = true;
    renderChrome();
    showView("onboard");
  });
  $("#leave-sample").addEventListener("click", () => {
    Store.leaveSample(state.ws);
    state.result = null;
    $("#orders").value = "";
    $("#results").hidden = true;
    $("#progress").textContent = "샘플을 지웠습니다. 기본 식자재 사전은 남아 있습니다. 카톡 주문을 붙여넣으세요.";
    touch(true); renderChrome(); showView("inbox"); parseInput();
  });
}

// ============================================================ 이벤트 연결
function bind() {
  $$("#nav button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  // 온보딩
  $("#ob-default").addEventListener("click", async () => {
    try { const ws = Store.loadDefaultItems(Store.blank(), await loadSampleData()); startWorkspace(ws); $("#progress").textContent = `기본 식자재 사전 ${ws.items.length}개를 불러왔습니다. 카톡 주문을 붙여넣으세요.`; }
    catch (e) { showError(`기본 사전을 불러오지 못했습니다: ${e.message}`); }
  });
  $("#ob-sample").addEventListener("click", async () => {
    try { const ws = Store.loadSample(Store.blank(), await loadSampleData()); ws.settings.유통사명 = $("#ob-name").value.trim() || ws.settings.유통사명; startWorkspace(ws); await process(); }
    catch (e) { showError(`샘플을 불러오지 못했습니다: ${e.message}`); }
  });
  $("#ob-csv").addEventListener("click", () => $("#ob-csv-file").click());
  $("#ob-csv-file").addEventListener("change", async (e) => {
    try {
      const ws = Store.blank();
      const r = Store.importItemsCsv(ws, await readFile(e.target));
      if (!r.total) throw new Error("품목을 읽지 못했습니다");
      startWorkspace(ws);
      $("#progress").textContent = `품목 ${r.total}개를 불러왔습니다. 이제 카톡 주문을 붙여넣으세요.`;
    } catch (err) { showError(`CSV 읽기 실패: ${err.message}. 첫 줄에 품목명(또는 품명) 열이 있어야 합니다.`); }
    finally { e.target.value = ""; }
  });
  $("#ob-import").addEventListener("click", () => $("#ob-import-file").click());
  $("#ob-import-file").addEventListener("change", async (e) => {
    try { startWorkspace(Store.importJson(await readFile(e.target))); }
    catch (err) { showError(`백업 가져오기 실패: ${err.message}`); }
    finally { e.target.value = ""; }
  });
  // 주문 입력: 타이핑은 인식만, 붙여넣기는 기본 방식일 때 바로 처리
  let t = null;
  $("#orders").addEventListener("input", () => { clearTimeout(t); t = setTimeout(parseInput, 250); });
  $("#orders").addEventListener("paste", () => { setTimeout(() => { parseInput(); if (effectiveEngine() === "rule" && state.orders.length) process(); }, 50); });
  $("#load-sample-orders").addEventListener("click", async () => {
    try { const s = await loadSampleData(); $("#orders").value = s.orders; parseInput(); if (effectiveEngine() === "rule") process(); }
    catch (e) { showError(`샘플을 불러오지 못했습니다: ${e.message}`); }
  });
  $("#clear-orders").addEventListener("click", () => { $("#orders").value = ""; parseInput(); });
  $("#delivery-date").addEventListener("change", (e) => { state.ws.session.deliveryDate = e.target.value || null; touch(); parseInput(); if (state.result) process(); });
  $("#run").addEventListener("click", process);
  // 결과
  $$('[role="tab"]').forEach((tab) => tab.addEventListener("click", () => {
    $$('[role="tab"]').forEach((x) => x.setAttribute("aria-selected", String(x === tab)));
    $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  }));
  $("#dl-xlsx").addEventListener("click", downloadXlsx);
  $("#dl-erp").addEventListener("click", downloadErp);
  $("#copy-erp").addEventListener("click", copyErp);
  $("#dl-csv").addEventListener("click", downloadCsv);
  $("#print-picking").addEventListener("click", () => printPanel("picking"));
  $("#print-detail").addEventListener("click", () => printPanel("detail"));
  $("#confirm-day").addEventListener("click", confirmDay);
  $("#new-day").addEventListener("click", newDay);
  // 해결 창
  $("#rd-search").addEventListener("input", (e) => renderSearch(e.target.value));
  $("#rd-qty").addEventListener("input", updateConvLabel);
  $("#rd-ok").addEventListener("click", commitResolve);
  $("#rd-cancel").addEventListener("click", closeResolve);
  $("#rd-dismiss").addEventListener("click", dismissResolve);
  $("#rd-new").addEventListener("click", newItemFromDialog);
  $("#rd-form").addEventListener("submit", (e) => { e.preventDefault(); commitResolve(); });
  dlg().addEventListener("keydown", (e) => {
    const inField = !!e.target.closest("input, textarea, select");
    if (!inField && /^[1-9]$/.test(e.key)) { const b = $$("#rd-cands [data-code]")[+e.key - 1]; if (b) { e.preventDefault(); selectCode(b.dataset.code); $("#rd-qty").focus(); } }
  });
  // 품목·거래처
  $("#items-search").addEventListener("input", renderItems);
  $("#items-add").addEventListener("click", addItemRow);
  $("#items-import").addEventListener("click", () => $("#items-file").click());
  $("#items-file").addEventListener("change", (e) => importItems(e.target));
  $("#items-export").addEventListener("click", () => saveFile(new Blob([Store.itemsCsv(state.ws)], { type: "text/csv;charset=utf-8" }), "품목사전.csv"));
  $("#clients-add").addEventListener("click", addClientRow);
  bindSettings();
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (state.ws && VIEWS.includes(v) && v !== "onboard") showView(v); });
}

// ============================================================ 시작
async function boot() {
  bind();
  setupClaude(); // 기다리지 않는다 — 준비되면 엔진 목록이 바뀐다
  loadSampleData().catch(() => { /* 샘플 없이도 동작 */ });
  const ws = Store.load();
  if (!ws) { showView("onboard"); return; }
  state.ws = ws;
  ON.setDistributor(ws.settings.유통사명, ws.settings.confirmFooter);
  renderChrome();
  $("#orders").value = ws.session.ordersText || "";
  $("#delivery-date").value = ws.session.deliveryDate || defaultDeliveryDate();
  const v = location.hash.slice(1);
  showView(VIEWS.includes(v) && v !== "onboard" ? v : "inbox");
  parseInput();
  // 이어서 작업할 수 있게, 비용이 없을 때(규칙 엔진이거나 AI 결과가 캐시돼 있을 때)만 자동으로 다시 처리한다
  if (state.orders.length && (effectiveEngine() === "rule" || Object.keys(ws.session.extracted).length)) await process();
}

// 키를 저장하지 않는 설정이면 저장 직전에 키를 뺀다
const _save = Store.save;
Store.save = (ws, st) => _save(ws.settings.rememberKey ? ws : { ...ws, settings: { ...ws.settings, apiKey: "" } }, st);

boot();
