// 화면 로직: 데이터 로드, 엔진 선택, 결과 렌더링, 엑셀/CSV 다운로드.
const ON = window.OrderNote;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = { catalog: null, history: null, sample: "", gold: null, result: null };

// ------------------------------------------------------------ LLM 엔진
class LLMExtractor {
  constructor(catalog, history, apiKey, model) {
    this.catalog = catalog;
    this.history = history;
    this.apiKey = apiKey;
    this.model = model;
    this.name = `LLM (${model})`;
  }

  async init() {
    const { default: Anthropic } = await import("./vendor/anthropic-sdk.mjs");
    this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 25000 });
  }

  async extract(order) {
    const resp = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: ON.SYSTEM_PROMPT,
      messages: [{ role: "user", content: ON.llmPrompt(order, this.history, this.catalog) }],
      output_config: { effort: "low", format: { type: "json_schema", schema: ON.ORDER_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (resp.stop_reason === "refusal") throw new Error("모델이 응답을 거절함");
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return ON.validateExtracted(JSON.parse(text));
  }
}

// ------------------------------------------------------------ 데이터 로드
async function fetchText(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path} 불러오기 실패 (${r.status})`);
  return r.text();
}

async function loadData() {
  try {
    const [items, history, orders, gold] = await Promise.all([
      fetchText("data/items.csv"), fetchText("data/history.json"), fetchText("input/orders.txt"), fetchText("data/expected.json"),
    ]);
    state.catalog = new ON.Catalog(ON.loadItems(items));
    state.history = ON.loadHistory(JSON.parse(history));
    state.sample = orders;
    state.gold = JSON.parse(gold);
    $("#orders").value = orders;
    $("#data-info").textContent = `품목 마스터 ${state.catalog.items.length}개 · 직전 주문 ${Object.keys(state.history).length}곳`;
  } catch (e) {
    const local = location.protocol === "file:";
    showError(local
      ? "파일을 직접 열면 데이터를 불러올 수 없습니다. 저장소 폴더에서 python3 -m http.server 를 실행한 뒤 http://localhost:8000 으로 여세요."
      : `데이터를 불러오지 못했습니다: ${e.message}`);
    $("#run").disabled = true;
  }
}

// ------------------------------------------------------------ 실행
function showError(msg) {
  const el = $("#error");
  el.textContent = msg;
  el.hidden = !msg;
}

async function runPipeline() {
  showError("");
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const key = $("#api-key").value.trim();
  if (engine === "llm" && !key) return showError("LLM 엔진을 쓰려면 Anthropic API 키를 입력하세요.");

  const btn = $("#run");
  btn.disabled = true;
  $("#progress").textContent = "처리 중…";
  try {
    let extractor;
    if (engine === "llm") {
      extractor = new LLMExtractor(state.catalog, state.history, key, $("#model").value.trim() || "claude-opus-5-5");
      await extractor.init();
    } else {
      extractor = new ON.RuleExtractor(state.catalog, state.history);
    }
    const res = await ON.run({
      ordersText: $("#orders").value, catalog: state.catalog, history: state.history, extractor,
      onProgress: (done, total) => { $("#progress").textContent = `구조화 ${done}/${total}건`; },
    });
    state.result = res;
    render(res);
    const failed = res.resolved.filter((r) => r.사유.startsWith("구조화 실패"));
    if (failed.length) showError(`${failed.length}건 구조화 실패 → 확인필요로 보냄. 첫 오류: ${failed[0].line.메모}`);
    $("#progress").textContent = `완료 · ${res.summary.seconds.toFixed(2)}초`;
  } catch (e) {
    showError(e.message);
    $("#progress").textContent = "";
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------ 렌더링
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function render(res) {
  const s = res.summary;
  $("#results").hidden = false;
  $("#k-orders").textContent = `${s.orders}건`;
  $("#k-orders-note").textContent = `품목 ${s.lines}줄 · 거래처 ${s.clients}곳`;
  $("#k-auto").textContent = `${pct(s.autoOrders, s.orders)}%`;
  $("#k-auto-note").textContent = `${s.autoOrders}/${s.orders}건 · 라인 기준 ${pct(s.okLines, s.lines)}%`;
  $("#k-pending").textContent = `${s.pendingLines}줄`;
  $("#k-pending-note").textContent = `주문 ${s.pendingOrders}건에서`;
  $("#k-time").textContent = `${s.seconds.toFixed(2)}초`;
  $("#k-engine").textContent = s.engine;
  $("#tab-queue").textContent = `확인필요 (${s.pendingLines})`;

  const evalEl = $("#eval");
  if (state.gold && $("#orders").value.trim() === state.sample.trim()) {
    const ev = ON.evaluate(res.resolved, res.orders, state.gold);
    const ok = !ev.wrong.length;
    evalEl.className = `eval ${ok ? "pass" : "fail"}`;
    evalEl.textContent = `샘플 정답셋 비교 — 잘못 매칭 ${ev.wrong.length}건 · 누락 ${ev.missed.length}건 · 확인필요 개수 불일치 ${ev.pendingDiff.length}건`;
    evalEl.hidden = false;
  } else {
    evalEl.hidden = true;
  }

  renderQueue(res);
  renderConfirm(res);
  renderPicking(res);
  renderDetail(res);
}

// stack=true 이면 모바일에서 행을 카드처럼 세로로 쌓는다 (td 앞에 열 이름 표시)
function table(headers, rows, rowClass = () => "", stack = false) {
  return `<div class="table-wrap"><table class="${stack ? "stack" : ""}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r, i) => `<tr class="${rowClass(i)}">${r.map((c, j) => `<td data-label="${esc(headers[j])}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderQueue(res) {
  const rows = res.resolved.filter((r) => r.status === "확인필요");
  const panel = document.querySelector('[data-panel="queue"]');
  if (!rows.length) {
    panel.innerHTML = `<p class="empty">확인필요 건이 없습니다. 전부 자동 처리됐어요.</p>`;
    return;
  }
  panel.innerHTML = `<p class="hint">자동 확정하지 않은 줄입니다. 후보 중 맞는 품목을 고르거나 거래처에 다시 물어보세요.</p>` +
    table(["주문", "거래처", "원문", "사유", "후보 품목"], rows.map((r) => [
      `#${r.order.순번} <span class="muted">${esc(r.order.수신시각.text.slice(11))}</span>`,
      esc(r.order.거래처),
      `<strong>${esc(ON.rawText(r))}</strong><div class="muted small">${esc(r.order.본문)}</div>`,
      esc(r.사유),
      r.후보.length ? r.후보.map((c) => `<span class="chip">${esc(c)}</span>`).join(" ") : `<span class="muted">없음</span>`,
    ]), () => "pending", true);
}

function renderConfirm(res) {
  const panel = document.querySelector('[data-panel="confirm"]');
  panel.innerHTML = `<div class="confirm-grid">${ON.confirmations(res.resolved).map((c, i) => `
    <article class="confirm">
      <header><strong>${esc(c.client)}</strong>${c.pending ? `<span class="badge">확인 중 ${c.pending}</span>` : ""}
        <button type="button" class="ghost small" data-copy="${i}">복사</button></header>
      <pre>${esc(c.text)}</pre>
    </article>`).join("")}</div>`;
  const list = ON.confirmations(res.resolved);
  panel.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(list[+b.dataset.copy].text);
      b.textContent = "복사됨";
    } catch {
      b.textContent = "복사 실패";
    }
    setTimeout(() => (b.textContent = "복사"), 1500);
  }));
}

function renderPicking(res) {
  const rows = ON.pickingList(res.resolved);
  const pending = res.summary.pendingLines;
  document.querySelector('[data-panel="picking"]').innerHTML =
    table(["품목코드", "품목명", "규격", "단위", "합계", "거래처수", "거래처별"], rows.map((r) => [
      esc(r.item.품목코드), esc(r.item.품목명), esc(r.item.규격), esc(r.item.단위),
      `<strong>${ON.fmtNum(r.total)}</strong>`, r.perClient.size,
      esc([...r.perClient].map(([k, v]) => `${k} ${ON.fmtNum(v)}`).join(", ")),
    ])) + (pending ? `<p class="hint pending-note">※ 확인필요 ${pending}줄은 피킹에서 제외됐습니다.</p>` : "");
}

function detailRows(rs) {
  return rs.map((r) => [
    esc(r.item?.품목코드 ?? ""), esc(r.item?.품목명 ?? ""), esc(r.item?.규격 ?? ""),
    r.수량 == null ? "" : ON.fmtNum(r.수량), esc(r.단위 ?? ""),
    r.status === "정상" ? `<span class="ok">정상</span>` : `<span class="warn-text">확인필요</span>`,
    esc(r.사유), esc(ON.rawText(r)), esc(r.line.메모 ?? ""), `#${r.order.순번} ${esc(r.order.수신시각.text.slice(11))}`,
  ]);
}

function renderDetail(res) {
  const groups = ON.groupBy(res.resolved, (r) => r.order.거래처);
  document.querySelector('[data-panel="detail"]').innerHTML = [...groups].map(([client, rs]) => {
    const pend = rs.filter((r) => r.status === "확인필요").length;
    return `<details open><summary><strong>${esc(client)}</strong> <span class="muted">${rs.length}줄${pend ? ` · 확인필요 ${pend}` : ""}</span></summary>` +
      table(["품목코드", "품목명", "규격", "수량", "단위", "상태", "사유", "원문", "메모", "주문"], detailRows(rs),
        (i) => (rs[i].status === "확인필요" ? "pending" : "")) + `</details>`;
  }).join("");
}

// ------------------------------------------------------------ 다운로드
function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.ExcelJS) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} 불러오기 실패`));
    document.head.appendChild(s);
  });
}

const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF59D" } };

function addSheet(wb, name, header, rows, highlight = []) {
  const ws = wb.addWorksheet(name.replace(/[[\]:*?/\\]/g, "").slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
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

async function downloadXlsx() {
  const res = state.result;
  const btn = $("#dl-xlsx");
  btn.disabled = true;
  try {
    await loadScript("web/vendor/exceljs.min.js");
    const wb = new window.ExcelJS.Workbook();
    const pick = ON.pickingList(res.resolved);
    const ws = addSheet(wb, "피킹리스트", ["품목코드", "품목명", "규격", "단위", "합계수량", "거래처수", "거래처별"],
      pick.map((r) => [r.item.품목코드, r.item.품목명, r.item.규격, r.item.단위, r.total, r.perClient.size,
        [...r.perClient].map(([k, v]) => `${k} ${ON.fmtNum(v)}`).join(", ")]));
    if (res.summary.pendingLines) {
      ws.addRow([]);
      const note = ws.addRow([`※ 확인필요 ${res.summary.pendingLines}줄은 피킹 제외 — 확인큐.csv 참고`]);
      note.getCell(1).fill = YELLOW;
    }
    for (const [client, rs] of ON.groupBy(res.resolved, (r) => r.order.거래처)) {
      addSheet(wb, client, ["품목코드", "품목명", "규격", "수량", "단위", "상태", "사유", "원문", "메모", "주문"],
        rs.map((r) => [r.item?.품목코드 ?? "", r.item?.품목명 ?? "", r.item?.규격 ?? "", r.수량, r.단위, r.status, r.사유,
          ON.rawText(r), r.line.메모 ?? "", `#${r.order.순번} ${r.order.수신시각.text.slice(11)}`]),
        rs.map((r) => r.status === "확인필요"));
    }
    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      `배송표_${res.mainDate.replace(/-/g, "")}.xlsx`);
  } catch (e) {
    showError(`엑셀 생성 실패: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function downloadCsv() {
  download(new Blob([ON.queueCsv(state.result.resolved)], { type: "text/csv;charset=utf-8" }), "확인큐.csv");
}

function downloadTxt() {
  const text = ON.confirmations(state.result.resolved).map((c) => c.text).join("\n\n────────\n\n") + "\n";
  download(new Blob([text], { type: "text/plain;charset=utf-8" }), "확인서_전체.txt");
}

// ------------------------------------------------------------ 이벤트
document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener("change", () => {
  $("#llm-opts").hidden = document.querySelector('input[name="engine"]:checked').value !== "llm";
}));
document.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
}));
$("#load-sample").addEventListener("click", () => { $("#orders").value = state.sample; });
$("#run").addEventListener("click", runPipeline);
$("#dl-xlsx").addEventListener("click", downloadXlsx);
$("#dl-csv").addEventListener("click", downloadCsv);
$("#dl-txt").addEventListener("click", downloadTxt);

loadData();
