/* 카카오톡 '대화 내보내기' / 메시지 복사본 / 오더노트 기본 형식 → 메시지 → 주문(OrderMessage).
 *
 * 지원 형식 (2024~2026 실제 내보내기 파일로 검증된 모양. 한 줄에 안 맞는 줄은 앞 메시지에 이어붙임)
 *  - android : 헤더 "가람식당 님과 카카오톡 대화" / "저장한 날짜 : 2026년 10월 20일 오전 10:12"
 *              날짜 표시줄 "2026년 10월 17일 오후 8:12" (쉼표 없음)
 *              메시지   "2026년 10월 17일 오후 8:12, 가람식당 : 본문"
 *              시스템   "2026년 10월 17일 오후 8:14, 가람식당님이 박민수님을 초대했습니다." (" : " 없음)
 *  - ios     : 첫 줄 "Talk_2026.10.20 10:12-1.txt" / "저장한 날짜 : 2026. 10. 20. 오전 10:12"
 *              날짜줄 "2026년 10월 17일 금요일" / 메시지 "2026. 10. 17. 오후 8:12, 가람식당 : 본문"
 *              시스템 "2026. 10. 17. 오후 8:12: 텍스트"
 *  - pc      : 헤더 / "저장한 날짜 : 2026-10-20 10:12:34" / "--------------- 2026년 10월 17일 금요일 ---------------"
 *              메시지 "[가람식당] [오후 8:12] 본문" / 시스템 "박민수님이 들어왔습니다." (시각 없음)
 *  - mac     : CSV "Date,User,Message" (날짜는 따옴표 없음, 이름·본문은 "..." 로 감싸고 줄바꿈 포함)
 *  - copy    : "[가람식당] [오후 8:12] 본문" 만 있고 날짜줄 없음 → baseDate 사용
 *  - ours    : [거래처] [YYYY-MM-DD HH:MM] 다음 줄부터 본문, 주문 사이 ---
 *  - iso     : "2026-10-17 20:12(:34), 가람식당 : 본문"
 * 같은 발신자의 연속 메시지는 mergeGapMin 분 안이면 한 주문으로 합친다. 같은 메시지를 두 번 붙여넣으면 한 번만 센다. */
(function (root) {
  "use strict";

  const DATE_SEP = /^-{3,}\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일.*?-{3,}\s*$/;
  const DATE_ONLY = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(\s*[월화수목금토일]요일)?\s*$/;
  const DATE_MARK = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*\d{1,2}:\d{2}\s*$/; // 안드로이드 날짜 표시줄
  const OURS_HEAD = /^\[([^\]]+)\]\s*\[(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\]\s*(.*)$/;
  const ANDROID = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s(.+?)\s:\s?(.*)$/;
  const ANDROID_SYS = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s(.*)$/;
  const IOS = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?,\s(.+?)\s:\s?(.*)$/;
  const IOS_SYS = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)?\s*(\d{1,2}):(\d{2})(?::\d{2})?:\s(.*)$/;
  const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?,?\s*(.+?)\s:\s?(.*)$/;
  const BRACKET = /^\[([^\]]+)\]\s*\[(오전|오후)?\s*(\d{1,2}):(\d{2})\]\s?(.*)$/;
  const HEADER = /^(.+?)\s*님과(의)?\s*카카오톡\s*대화\s*$|^(.+?)\s+카카오톡\s*대화\s*$|^저장한\s*날짜\s*:|^Date Saved\s*:|^Talk_\d{4}\.\d{1,2}\.\d{1,2}\s/;
  const SYSTEM = /(님이 들어왔습니다|님을 초대했습니다|님이 나갔습니다|님을 내보냈습니다|채팅방 관리자가|메시지가 삭제되었습니다|삭제된 메시지입니다|님과 카카오톡 대화를 시작)\.?\s*$/;
  const SKIP_BODY = /^(이모티콘|스티커|삭제된 메시지입니다\.?|메시지가 삭제되었습니다\.?|보이스톡 (해요|종료.*)|페이스톡 .*|카카오톡 프로필|연락처|[\d,]+원을 보냈어요\.?|[\d,]+원 받기 완료!?|[\d,]+원 자동환불 예정)$/;
  const PAY_NOTICE = /^(송금 받기 전까지|※ \(안내\)|내일 낮 12시에 자동 환불)/;
  const PHOTO = /^(사진( \d+장)?|동영상|파일: .*|지도: .*|샵검색: .*|음성메시지)$/;

  function hour24(ampm, h) {
    h = Number(h);
    if (ampm === "오후" && h < 12) h += 12;
    if (ampm === "오전" && h === 12) h = 0;
    return h;
  }

  function ts(y, mo, d, h, mi) {
    const pad = (n) => String(n).padStart(2, "0");
    return { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, text: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}` };
  }

  function minutes(t) {
    return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi) / 60000;
  }

  /** RFC 4180 CSV (따옴표 안 줄바꿈·"" 허용) → 행 배열 */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseMacCsv(text) {
    const rows = parseCsv(text);
    const msgs = [];
    for (const r of rows.slice(1)) {
      if (r.length < 3) continue;
      const m = String(r[0]).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
      if (!m) continue;
      msgs.push({ sender: String(r[1]).trim(), time: ts(m[1], m[2], m[3], m[4], m[5]), text: r.slice(2).join(","), fmt: "mac" });
    }
    return msgs;
  }

  /** 원문 → { messages:[{sender,time,text}], formats, partner, unknownLines } */
  function parseMessages(text, { baseDate } = {}) {
    const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const formats = new Set();
    let msgs = [];
    const partners = [];     // 각 방 헤더의 상대 이름(1:1 방)
    const roomIds = new Map(); // 헤더 글 → 방 번호 (같은 방을 두 번 붙여넣어도 한 방)
    let room = 0;
    const unknown = [];

    if (/^"?Date"?,"?User"?,"?Message"?/i.test(src.split("\n")[0] || "")) {
      msgs = parseMacCsv(src);
      formats.add("mac");
    } else {
      let cur = null;          // 이어붙일 메시지
      let curDate = null;      // [y, mo, d] (pc 형식 날짜 구분선 / 안드로이드·아이폰 날짜줄)
      let oursBody = false;    // ours 형식: 본문 수집 중
      const base = baseDate ? baseDate.split("-").map(Number) : null;
      const push = (sender, time, body, fmt) => {
        cur = { sender: sender.trim(), time, text: body, fmt, room };
        msgs.push(cur);
        formats.add(fmt);
      };
      for (const raw of src.split("\n")) {
        const line = raw.replace(/\s+$/, "");
        let m;
        if (oursBody) {
          if (/^---\s*$/.test(line)) { oursBody = false; cur = null; continue; }
          if (!line.match(OURS_HEAD)) { if (line.trim()) cur.text = cur.text ? `${cur.text}\n${line}` : line; continue; }
          oursBody = false;
        }
        if (!line.trim()) continue;
        if (/^---\s*$/.test(line)) { cur = null; continue; }
        if ((m = line.match(OURS_HEAD))) { push(m[1], ts(m[2], m[3], m[4], m[5], m[6]), m[7] || "", "ours"); oursBody = true; continue; }
        if ((m = line.match(DATE_SEP)) || (m = line.match(DATE_ONLY)) || (m = line.match(DATE_MARK))) { curDate = [m[1], m[2], m[3]]; cur = null; continue; }
        if ((m = line.match(ANDROID))) { push(m[7], ts(m[1], m[2], m[3], hour24(m[4], m[5]), m[6]), m[8], "android"); continue; }
        if ((m = line.match(IOS))) { push(m[7], ts(m[1], m[2], m[3], hour24(m[4], m[5]), m[6]), m[8], "ios"); continue; }
        if ((m = line.match(ISO))) { push(m[6], ts(m[1], m[2], m[3], m[4], m[5]), m[7], "iso"); continue; }
        if (line.match(ANDROID_SYS) || line.match(IOS_SYS)) { cur = null; continue; } // 초대·나감 등 시스템 줄
        if ((m = line.match(BRACKET))) {
          const d = curDate || base;
          if (!d) formats.add("copy-nodate");
          const date = d || [1970, 1, 1];
          push(m[1], ts(date[0], date[1], date[2], hour24(m[2], m[3]), m[4]), m[5], curDate ? "pc" : "copy");
          continue;
        }
        if ((m = line.match(HEADER))) {
          const p = (m[1] || m[3] || "").trim();
          if (p || /^Talk_/.test(line)) {                  // 방 제목 줄(또는 아이폰 파일명 줄)마다 방을 구분
            const id = p || line.trim();
            if (!roomIds.has(id)) roomIds.set(id, roomIds.size + 1);
            room = roomIds.get(id);
          }
          if (p && !/,/.test(p) && !partners.includes(p)) partners.push(p);
          cur = null;
          continue;
        }
        if (SYSTEM.test(line) || PAY_NOTICE.test(line)) { continue; }
        if (cur) { cur.text = cur.text ? `${cur.text}\n${line}` : line; continue; }
        unknown.push(line);
      }
      if (unknown.length) {
        formats.add("plain");
        push("(발신자 없음)", ts(...(base || [1970, 1, 1]), 0, 0), unknown.join("\n"), "plain");
      }
    }
    // 이모티콘·통화·송금·삭제 메시지 제거, 같은 메시지 중복 제거(같은 방을 두 번 붙여넣은 경우)
    const seen = new Set();
    const kept = [];
    let duplicates = 0;
    for (const x of msgs) {
      const body = x.text.replace(/\s+$/, "");
      x.text = body;
      if (!body.trim() || SYSTEM.test(body.trim()) || SKIP_BODY.test(body.trim())) continue;
      const k = `${x.sender}|${x.time.text}|${body}`;
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k);
      kept.push(x);
    }
    return { messages: kept, formats: [...formats], partner: partners.length === 1 ? partners[0] : null, partners, rooms: roomIds.size, duplicates };
  }

  function senderStats(messages) {
    const map = new Map();
    for (const m of messages) {
      const e = map.get(m.sender) || { count: 0, rooms: new Set() };
      e.count++; e.rooms.add(m.room ?? 0);
      map.set(m.sender, e);
    }
    return [...map.entries()].map(([name, e]) => ({ name, count: e.count, rooms: e.rooms.size })).sort((a, b) => b.count - a.count);
  }

  /** 메시지 → 주문. roles: 발신자 → "order" | "me" | "skip". clientNameFor: 카톡 이름 → 거래처명. */
  function toOrders(messages, { roles = {}, mergeGapMin = 10, clientNameFor = (s) => s, deliveryDate = null } = {}) {
    const orders = [];
    const lastBy = new Map(); // 발신자 → 마지막 주문 (사이에 다른 사람 메시지가 끼어도 같은 사람 것은 합친다)
    const sorted = messages.slice().sort((a, b) => minutes(a.time) - minutes(b.time));
    for (const m of sorted) {
      const role = Object.prototype.hasOwnProperty.call(roles, m.sender) ? roles[m.sender] : "order"; // 'constructor' 같은 이름도 안전하게
      if (role !== "order") continue;
      const body = m.text.trim();
      const shown = PHOTO.test(body) ? `(${body})` : body;
      const last = lastBy.get(m.sender);
      if (last && minutes(m.time) - minutes(last._lastTime) <= mergeGapMin) {
        last.본문 = `${last.본문}\n${shown}`;
        last.메시지수++;
        last._lastTime = m.time;
        continue;
      }
      const o = { 순번: orders.length + 1, 거래처: clientNameFor(m.sender), 발신자: m.sender, 수신시각: m.time, 본문: shown, 메시지수: 1, 납품일기본: deliveryDate || null, _lastTime: m.time };
      orders.push(o);
      lastBy.set(m.sender, o);
    }
    for (const o of orders) delete o._lastTime;
    return orders;
  }

  function describeFormat(formats) {
    const names = { ours: "오더노트 기본 형식", android: "카톡 내보내기(안드로이드)", ios: "카톡 내보내기(아이폰)", pc: "카톡 내보내기(PC)", mac: "카톡 내보내기(맥 CSV)", copy: "카톡 메시지 복사본", "copy-nodate": "카톡 메시지 복사본(날짜 없음)", iso: "날짜-시간 형식", plain: "형식 없는 줄" };
    return formats.filter((f) => f !== "copy-nodate").map((f) => names[f] || f).join(" + ") || "인식된 메시지 없음";
  }

  const api = { parseMessages, senderStats, toOrders, describeFormat, hour24, parseCsv };
  root.OrderNoteKakao = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
