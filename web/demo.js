/* 데모 영상용 자동 재생. 주소 뒤에 ?demo=auto 를 붙였을 때만 동작하고, 평소 사용자에게는 아무 영향이 없다.
 *   ?demo=seed      3주치 기록·거래처·배운 표현을 채운 작업공간으로 시작 (손으로 클릭하며 찍을 때)
 *   ?demo=auto      seed + 붙여넣기 → 확인할 줄 해결 → 확인서 복사 → 확정 → 거래처 → 기록 순서로 자동 클릭
 *   ?demo=restore   데모 전에 있던 작업공간으로 되돌리기
 *   &speed=1.5      재생 속도(기본 1). &loop=1 끝나면 처음부터 다시
 * 데모를 시작하면 기존 작업공간은 ordernote.workspace.v1.prev 에 보관한다.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get("demo");
  if (!mode) return;
  const Store = window.OrderNoteStore, ON = window.OrderNote;
  const PREV = `${Store.KEY}.prev`;
  const FLAG = `${Store.KEY}.demo`;                 // 지금 저장된 작업공간이 데모용이라는 표시
  const speed = Math.max(0.3, parseFloat(params.get("speed")) || 1);
  const loop = params.get("loop") === "1";
  const rnd = (a, b) => a + Math.random() * (b - a);
  const wait = (ms) => new Promise((r) => setTimeout(r, (ms * rnd(0.85, 1.2)) / speed));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (mode === "restore") {
    const prev = localStorage.getItem(PREV);
    if (prev) { localStorage.setItem(Store.KEY, prev); localStorage.removeItem(PREV); }
    else localStorage.removeItem(Store.KEY);
    localStorage.removeItem(FLAG);
    location.replace(location.pathname);
    return;
  }

  // ------------------------------------------------------------ 1. 3주치 기록이 쌓인 작업공간 만들기
  async function seed() {
    const [items, history, orders] = await Promise.all(["data/items.csv", "data/history.json", "input/orders.txt"].map((p) => fetch(p).then((r) => r.text())));
    seed.orders = orders;
    const ws = Store.loadSample(Store.blank(), { items, history, orders });
    ws.settings.sample = false;                     // 실제 유통사처럼 보이게 (샘플 배너·정답 배지 없음)
    ws.settings.유통사명 = "새벽들유통";
    ws.settings.beforeMinutes = 90;                 // 도입 전 하루 입력 시간 → 단축률 표시
    ws.session.ordersText = "";                     // 영상에서 직접 붙여넣는다
    // 오늘까지 3주치(일요일 제외). 영상에서 확정하는 납품분은 내일 날짜가 된다
    const days = [];
    const d = new Date();
    while (days.length < 18) { if (d.getDay() !== 0) days.unshift(fmt(d)); d.setDate(d.getDate() - 1); }
    const clients = Object.keys(ws.clients);
    const learnedBy = {};
    ws.days = days.map((date, i) => {
      const p = i / (days.length - 1);                                   // 0 → 1 (도입 초기 → 지금)
      const orders = Math.round(rnd(15, 22));
      const lines = Math.round(orders * rnd(3.0, 3.6));
      const autoRate = 0.62 + 0.29 * p + rnd(-0.03, 0.03);               // 62% → 91%
      const auto = Math.round(lines * Math.min(0.93, autoRate));
      const pending = Math.max(0, Math.round(lines * (0.02 + 0.05 * (1 - p)) + rnd(-1, 1)));
      const excluded = Math.round(rnd(0, 2));
      const resolved = Math.max(0, lines - auto - pending - excluded);
      const learned = Math.max(0, Math.round(7 * (1 - p) + rnd(-1, 1.5)));
      learnedBy[date] = learned;
      return {
        납품일: date, 확정시각: `${date}T${String(21 + (i % 3)).padStart(2, "0")}:${String(Math.round(rnd(5, 55))).padStart(2, "0")}:00+09:00`,
        주문: orders, 라인: lines, 자동: auto, 담당자확인: resolved, 확인: pending, 제외: excluded,
        처리초: Math.round(rnd(0.4, 1.2) * 100) / 100, 소요분: Math.round(48 - 26 * p + rnd(-4, 4)), 학습: learned, engine: "기본(규칙)", sample: false,
      };
    });
    // 거래처: 주문 횟수·직전 주문일
    clients.forEach((name, i) => { const c = ws.clients[name]; c.주문횟수 = days.length - (i % 3); c.직전주문일 = days[days.length - 1]; });
    // 배운 표현: 날짜를 기록에 맞춰 흩뿌린다 (샘플 주문의 확인할 줄은 그대로 남도록 거기 안 나오는 표현만)
    const learn = [["V012", "청고추"], ["V001", "대파단"], ["V015", "깐마늘봉"], ["M001", "삼겹 생거"], ["M008", "차돌배기"], ["V003", "양파 망"], ["P001", "식용유 말통"], ["V007", "조선무우"], ["V009", "양배추통"], ["V019", "깻잎 상자"], ["M012", "계란판"], ["P010", "두부 판"]];
    let di = 0;
    for (const [code, alias] of learn) {
      if (!ws.items.some((it) => it.품목코드 === code)) continue;
      while (di < days.length && !learnedBy[days[di]]) di++;
      const date = days[Math.min(di, days.length - 1)];
      const r = Store.learnAlias(ws, code, alias, { client: clients[di % clients.length], date });
      if (r.ok && !r.already) { learnedBy[date]--; }
    }
    ws.createdAt = `${days[0]}T20:00:00+09:00`;
    return ws;
  }

  // ------------------------------------------------------------ 2. 보이는 커서로 클릭
  const $ = (s) => document.querySelector(s);
  let cursor, badge, stopped = false;
  function ui() {
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;width:26px;height:30px;z-index:99999;pointer-events:none;transition:transform .55s cubic-bezier(.3,.8,.3,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
      #demo-cursor.click svg{transform:scale(.8)} #demo-cursor svg{transition:transform .12s}
      #demo-ripple{position:fixed;width:36px;height:36px;border-radius:50%;border:3px solid #1f6feb;z-index:99998;pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(.3)}
      #demo-ripple.go{animation:demo-rip .5s ease-out} @keyframes demo-rip{0%{opacity:.9;transform:translate(-50%,-50%) scale(.3)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.6)}}
      #demo-badge{position:fixed;right:14px;bottom:14px;z-index:99997;background:rgba(27,31,36,.85);color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;display:flex;gap:10px;align-items:center}
      #demo-badge button{font:inherit;padding:3px 10px;border-radius:6px;border:1px solid #aaa;background:#fff;color:#111;cursor:pointer}
      body.demo-hide-badge #demo-badge{display:none}`;
    document.head.appendChild(style);
    cursor = document.createElement("div"); cursor.id = "demo-cursor";
    cursor.innerHTML = `<svg viewBox="0 0 26 30" width="26" height="30"><path d="M3 2 L3 24 L9 18 L13 28 L17 26 L13 17 L21 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(cursor);
    const rip = document.createElement("div"); rip.id = "demo-ripple"; document.body.appendChild(rip);
    badge = document.createElement("div"); badge.id = "demo-badge";
    badge.innerHTML = `<span id="demo-step">데모 재생 중 · Esc 멈춤 · H 안내 숨김</span><button type="button" id="demo-stop">멈춤</button>`;
    document.body.appendChild(badge);
    $("#demo-stop").addEventListener("click", stop);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") stop(); if (e.key === "h" || e.key === "H") document.body.classList.toggle("demo-hide-badge"); });
    cursor.style.transform = `translate(${innerWidth / 2}px, ${innerHeight / 2}px)`;
  }
  function stop() { stopped = true; if (badge) $("#demo-step").textContent = "데모 멈춤 — 이제 직접 써 보세요"; }
  function step(text) { if (badge) $("#demo-step").textContent = text; }
  async function moveTo(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await wait(350);
    const r = el.getBoundingClientRect();
    cursor.style.transform = `translate(${r.left + Math.min(r.width / 2, 60) - 3}px, ${r.top + r.height / 2 - 2}px)`;
    await wait(600);
  }
  async function click(sel, label) {
    if (stopped) throw new Error("stopped");
    const el = typeof sel === "string" ? $(sel) : sel;
    if (!el) throw new Error(`없음: ${sel}`);
    if (label) step(label);
    await moveTo(el);
    const r = el.getBoundingClientRect();
    const rip = $("#demo-ripple"); rip.style.left = `${r.left + Math.min(r.width / 2, 60)}px`; rip.style.top = `${r.top + r.height / 2}px`;
    rip.classList.remove("go"); void rip.offsetWidth; rip.classList.add("go");
    cursor.classList.add("click"); await wait(120); cursor.classList.remove("click");
    el.click();
    await wait(450);
  }
  async function type(sel, text, perChar = 45) {
    const el = $(sel);
    await moveTo(el); el.focus(); el.click();
    el.value = "";
    for (const ch of text) { if (stopped) throw new Error("stopped"); el.value += ch; el.dispatchEvent(new Event("input", { bubbles: true })); await wait(perChar); }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function pasteOrders(text) {
    const el = $("#orders");
    await moveTo(el); el.focus();
    const blocks = text.split(/\n(?=\[)/);               // 주문 단위로 '붙여넣기'되는 것처럼
    el.value = "";
    for (const b of blocks) { if (stopped) throw new Error("stopped"); el.value += (el.value ? "\n" : "") + b; el.dispatchEvent(new Event("input", { bubbles: true })); el.scrollTop = el.scrollHeight; await wait(140); }
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true }));
  }
  const until = (fn, ms = 15000) => new Promise((res, rej) => { const t0 = Date.now(); (function poll() { if (stopped) return rej(new Error("stopped")); if (fn()) return res(); if (Date.now() - t0 > ms) return rej(new Error("timeout")); setTimeout(poll, 100); })(); });

  // ------------------------------------------------------------ 3. 시나리오
  const PICK = { "고추": "V012", "다리살": "M003" };    // 후보가 여럿인 줄에서 고를 품목
  async function play(orders) {
    await until(() => $("#view-inbox") && !$("#view-inbox").hidden);
    await wait(900);
    step("카톡 주문 붙여넣기");
    await pasteOrders(orders);
    await until(() => !$("#results").hidden && /^\d/.test($("#k-orders").textContent));
    await wait(600);
    await moveTo($("#k-pending-tile")); await wait(1200);
    await click("#queue-start", "확인할 줄 차례로 해결");
    for (let i = 0; i < 12; i++) {
      await until(() => $("#resolve-dialog").open, 8000).catch(() => {});
      if (!$("#resolve-dialog").open) break;
      await wait(900);
      const raw = $("#rd-raw").textContent.trim();
      const cands = [...document.querySelectorAll("#rd-cands [data-code]")];
      if (raw.startsWith("떡볶이떡")) { await click("#rd-dismiss", `'${raw}' 는 주문이 아님`); continue; }
      const want = Object.keys(PICK).find((k) => raw.startsWith(k));
      const target = want ? cands.find((b) => b.dataset.code === PICK[want]) : (cands.length === 1 ? cands[0] : null);
      if (target) await click(target, `'${raw}' → 품목 고르기`);
      else if (!cands.length) await click("#rd-new", `'${raw}' 새 품목으로 등록`);
      else await click(cands[0], `'${raw}' → 품목 고르기`);
      if (!$("#rd-qty").value) await type("#rd-qty", raw.includes("2근") ? "1" : "2", 120);
      if (!$("#rd-conv-wrap").hidden && !$("#rd-conv").checked) await click("#rd-conv", "단위 환산 기억하기");
      await wait(500);
      await click("#rd-ok", "확정 → 다음");
    }
    await until(() => !$("#resolve-dialog").open, 5000).catch(() => {});
    await moveTo($("#k-auto")); await wait(1200);
    await click("#tab-confirm", "거래처 확인서");
    const copies = [...document.querySelectorAll('[data-panel="confirm"] [data-copy]')].slice(0, 2);
    for (const b of copies) { await click(b, "확인서 복사 → 카톡에 붙여넣기"); await wait(700); }
    await click('[data-tab="picking"]', "피킹리스트"); await wait(1500);
    await click("#confirm-day", "오늘 납품분 확정");
    await wait(1800);
    await click('#nav button[data-view="clients"]', "거래처 — 직전 주문이 갱신됨"); await wait(2200);
    await click('#nav button[data-view="history"]', "기록 — 3주간 지표"); await wait(3000);
    step("데모 끝 · H 안내 숨김");
  }

  async function prepare() {
    if (localStorage.getItem(Store.KEY) && !localStorage.getItem(FLAG)) localStorage.setItem(PREV, localStorage.getItem(Store.KEY)); // 진짜 작업공간만 보관
    const ws = await seed();
    Store.save(ws);
    localStorage.setItem(FLAG, "1");
    if (mode !== "auto") history.replaceState(null, "", location.pathname + `?demo=seed`);
  }
  async function main() {
    await window.__demoReady;                       // 앱이 부팅된 뒤에 재생
    if (mode !== "auto") return;
    ui();
    window.__demo = { stop };
    try { await play(seed.orders); if (loop && !stopped) { await wait(2500); location.reload(); } }
    catch (e) { if (e.message !== "stopped") { console.error(e); step(`데모 중단: ${e.message}`); } }
  }
  // seed 가 끝나기 전에 app.js 가 부팅되지 않도록, app.js 는 window.__demoReady 를 기다린다(재생은 기다리지 않는다).
  window.__demoReady = prepare();
  main();
})();
