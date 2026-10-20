// 작업공간·카톡 파서·담당자 확인 흐름 회귀 테스트: node web/store.test.cjs
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const ON = require("./core.js");
const Store = require("./store.js");
const Kakao = require("./kakao.js");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const sample = { items: read("data/items.csv"), history: read("data/history.json"), orders: read("input/orders.txt"), expected: read("data/expected.json") };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

(async () => {
  // --- 1. 샘플 로드 + 기본 형식 파싱 → 처리 (기존 데모와 동일 결과)
  const ws = Store.loadSample(Store.blank(), sample);
  assert.strictEqual(ws.items.length, 50);
  const parsed = Kakao.parseMessages(ws.session.ordersText);
  assert.deepStrictEqual(parsed.formats, ["ours"]);
  assert.strictEqual(parsed.messages.length, 20);
  const orders = Kakao.toOrders(parsed.messages, { mergeGapMin: 0 });
  assert.strictEqual(orders.length, 20);
  assert.strictEqual(orders[3].본문.split("\n").length, 5, "여러 줄 본문 유지");
  const catalog = new ON.Catalog(ws.items);
  const run1 = await ON.runOrders({ orders, catalog, history: Store.history(ws), extractor: new ON.RuleExtractor(catalog, Store.history(ws)), cache: ws.session.extracted, resolutions: ws.session.resolutions });
  const ev = ON.evaluate(run1.resolved, run1.orders, JSON.parse(sample.expected));
  assert.deepStrictEqual([ev.wrong.length, ev.missed.length, ev.pendingDiff.length], [0, 0, 0], JSON.stringify(ev));
  assert.strictEqual(run1.summary.pendingLines, 6);
  assert.strictEqual(Object.keys(ws.session.extracted).length, 20, "추출 결과 캐시");

  // --- 2. 담당자 확인: '고추 한봉' → 청양고추 1봉... 단위는 kg 마스터이므로 1kg 로 입력, 별칭 학습
  const gochu = run1.resolved.find((r) => r.line.품목명_원문 === "고추");
  assert.ok(gochu && gochu.status === "확인필요");
  ws.session.resolutions[gochu.key] = { code: "V012", qty: 1, learned: true };
  const learn = Store.learnAlias(ws, "V012", "고추", { client: "해오름횟집" });
  assert.ok(learn.ok, JSON.stringify(learn));
  // 같은 표현을 다른 품목에 학습시키려 하면 거부
  assert.strictEqual(Store.learnAlias(ws, "V013", "고추").ok, false);
  // 단위 환산 학습: 고춧가루 2근 → 1봉으로 처리하기로 함 (1근 = 0.5봉)
  const gochugaru = run1.resolved.find((r) => r.line.품목명_원문 === "고춧가루" && r.status === "확인필요");
  ws.session.resolutions[gochugaru.key] = { code: "P006", qty: 1 };
  Store.learnConversion(ws, "P006", "근", 0.5);
  // 제외: '떡볶이떡' 은 취급 안 함
  const tteok = run1.resolved.find((r) => r.line.품목명_원문 === "떡볶이떡");
  ws.session.resolutions[tteok.key] = { dismissed: true };

  const catalog2 = new ON.Catalog(ws.items);
  const run2 = await ON.runOrders({ orders, catalog: catalog2, history: Store.history(ws), extractor: new ON.RuleExtractor(catalog2, Store.history(ws)), cache: ws.session.extracted, resolutions: ws.session.resolutions });
  assert.strictEqual(run2.summary.cachedOrders, 20, "LLM 캐시 재사용");
  assert.strictEqual(run2.summary.pendingLines, 3, "6 → 3 (확인 2 + 제외 1)");
  assert.strictEqual(run2.summary.excludedLines, 1);
  assert.strictEqual(run2.summary.resolvedLines, 2);
  const g2 = run2.resolved.find((r) => r.key === gochu.key);
  assert.strictEqual(g2.status, "정상");
  assert.strictEqual(g2.사유, "담당자 확인");
  // 다음날 같은 표현 '고추' 는 별칭으로 자동 매칭된다
  assert.strictEqual(catalog2.match("고추").item.품목코드, "V012");
  // 환산 학습 반영: '고춧가루 2근' 을 새로 처리하면 1봉
  assert.strictEqual(ON.convert(2, "근", catalog2.byCode.P006), 1);

  // --- 3. 확정 → 직전 주문 갱신, 기록 추가. 다음날 '어제 거 그대로' 가 새 직전 주문을 쓴다
  const rec = Store.confirmDay(ws, run2);
  assert.strictEqual(rec.주문, 20);
  assert.strictEqual(ws.days.length, 1);
  const onDal = ws.clients["온달고깃집"].직전주문;
  assert.strictEqual(onDal.M001, 15, "삼겹 15kg 가 직전 주문이 됨");
  assert.strictEqual(onDal.M008, 5);
  assert.ok(!ws.clients["봄내닭갈비"].직전주문.V999);
  Store.newDay(ws);
  const next = Kakao.toOrders(Kakao.parseMessages("[온달고깃집] [2026-10-18 20:00]\n어제 거 그대로요\n---\n").messages);
  const run3 = await ON.runOrders({ orders: next, catalog: catalog2, history: Store.history(ws), extractor: new ON.RuleExtractor(catalog2, Store.history(ws)) });
  assert.ok(run3.resolved.some((r) => r.item && r.item.품목코드 === "M008" && r.수량 === 5), "차돌 5kg 가 직전 주문에서 복사됨");
  assert.strictEqual(run3.mainDate, "2026-10-19");

  // --- 4. 저장/불러오기/백업
  const st = memStorage();
  assert.ok(Store.save(ws, st));
  const back = Store.load(st);
  assert.strictEqual(back.items.find((i) => i.품목코드 === "V012").별칭.includes("고추"), true);
  const imported = Store.importJson(Store.exportJson(ws));
  assert.strictEqual(imported.days.length, 1);
  assert.throws(() => Store.importJson("{}"));

  // --- 5. 카톡 내보내기 형식들
  const android = `가람식당 님과 카카오톡 대화
저장한 날짜 : 2026-10-18 09:12

2026년 10월 17일 오후 8:12, 가람식당 : 사장님 어제 거 그대로 부탁드려요
2026년 10월 17일 오후 8:13, 새벽들유통 : 네 사장님~
2026년 10월 17일 오후 8:15, 가람식당 : 아 그리고
대파 2단 추가요
2026년 10월 17일 오후 8:16, 가람식당 : 이모티콘
2026년 10월 17일 오후 9:40, 가람식당 : 사진
2026년 10월 17일 오후 9:41, 가람식당 : 이것도요
`;
  const pa = Kakao.parseMessages(android);
  assert.deepStrictEqual(pa.formats, ["android"]);
  assert.strictEqual(pa.partner, "가람식당");
  assert.strictEqual(pa.messages.length, 5, "이모티콘 제거");
  assert.strictEqual(pa.messages[2].text, "아 그리고\n대파 2단 추가요");
  const oa = Kakao.toOrders(pa.messages, { roles: { 새벽들유통: "me" }, mergeGapMin: 10 });
  assert.strictEqual(oa.length, 2, "20:12+20:15 병합, 21:40 별도");
  assert.strictEqual(oa[0].본문, "사장님 어제 거 그대로 부탁드려요\n아 그리고\n대파 2단 추가요");
  assert.strictEqual(oa[0].수신시각.text, "2026-10-17 20:12");
  assert.strictEqual(oa[1].본문, "(사진)\n이것도요");

  const pc = `모퉁이국밥 님과 카카오톡 대화
저장한 날짜 : 2026-10-18 오전 9:00

--------------- 2026년 10월 17일 금요일 ---------------
[모퉁이국밥] [오후 8:25] 사장님 내일 대파 3단 무 4개 보내주이소
[새벽들유통] [오후 8:26] 넵
--------------- 2026년 10월 18일 토요일 ---------------
[모퉁이국밥] [오전 12:05] 양지 5키로도요
`;
  const pp = Kakao.parseMessages(pc);
  assert.deepStrictEqual(pp.formats, ["pc"]);
  const op = Kakao.toOrders(pp.messages, { roles: { 새벽들유통: "me" } });
  assert.strictEqual(op.length, 2);
  assert.strictEqual(op[1].수신시각.text, "2026-10-18 00:05", "오전 12시 = 0시, 날짜 구분선 반영");

  const ios = `2026. 10. 17. 오후 8:40, 온달고깃집 : 삼겹 15키로
2026. 10. 17. 20:41, 온달고깃집 : 목살 8키로
`;
  const pi = Kakao.parseMessages(ios);
  assert.deepStrictEqual(pi.formats, ["ios"]);
  assert.strictEqual(Kakao.toOrders(pi.messages).length, 1);

  const copy = `[솔밭분식] [오후 9:40] 콩나무 3봉이랑 대파 한단
[솔밭분식] [오후 9:41] 양배추 2통요`;
  const pcp = Kakao.parseMessages(copy, { baseDate: "2026-10-17" });
  assert.deepStrictEqual(pcp.formats, ["copy"]);
  assert.strictEqual(Kakao.toOrders(pcp.messages)[0].수신시각.text, "2026-10-17 21:40");
  assert.ok(Kakao.parseMessages(copy).formats.includes("copy-nodate"));

  // --- 6. 검증된 실제 내보내기 모양: 안드로이드 날짜 표시줄·시스템 줄, 아이폰 첫 줄·시스템 줄, 맥 CSV, 중복 제거
  const android2 = `\uFEFF가람식당 님과 카카오톡 대화
저장한 날짜 : 2026년 10월 20일 오전 10:12


2026년 10월 17일 오후 8:12
2026년 10월 17일 오후 8:12, 가람식당 : 사장님 내일 쌀 20kg 2포 부탁드려요
2026년 10월 17일 오후 8:12, 가람식당 : 이모티콘
2026년 10월 17일 오후 8:13, 김진성 : 네 알겠습니다
내일 오전 중 배송할게요
2026년 10월 17일 오후 8:14, 가람식당 : 사진
2026년 10월 17일 오후 8:16, 김진성 : 보이스톡 해요
2026년 10월 17일 오후 8:19, 김진성 : 보이스톡 종료 02:52

2026년 10월 18일 오전 9:01
2026년 10월 18일 오전 9:30, 가람식당 : 삭제된 메시지입니다.
2026년 10월 18일 오전 9:31, 가람식당님이 박민수님을 초대했습니다.
2026년 10월 18일 오전 9:32, 박민수 : 안녕하세요
2026년 10월 18일 오전 9:33, 박민수 : 
`;
  const a2 = Kakao.parseMessages(android2);
  assert.deepStrictEqual(a2.formats, ["android"]);
  assert.strictEqual(a2.partner, "가람식당");
  assert.deepStrictEqual(a2.messages.map((m) => `${m.sender}|${m.time.text}|${m.text}`), [
    "가람식당|2026-10-17 20:12|사장님 내일 쌀 20kg 2포 부탁드려요",
    "김진성|2026-10-17 20:13|네 알겠습니다\n내일 오전 중 배송할게요",
    "가람식당|2026-10-17 20:14|사진",
    "박민수|2026-10-18 09:32|안녕하세요",
  ]);
  // 같은 방을 두 번 붙여넣으면 중복 제거
  const twice = Kakao.parseMessages(android2 + "\n" + android2.replace(/^\uFEFF/, ""));
  assert.strictEqual(twice.messages.length, 4);
  assert.ok(twice.duplicates >= 4);

  const ios2 = `\uFEFFTalk_2026.10.20 10:12-1.txt
저장한 날짜 : 2026. 10. 20. 오전 10:12



2026년 10월 17일 금요일
2026. 10. 17. 오후 8:40, 온달고깃집 : 삼겹 15키로
목살 8키로
2026. 10. 17. 오후 8:41, 온달고깃집 : 이모티콘 
2026. 10. 17. 오후 8:42: 온달고깃집님이 들어왔습니다.
2026. 10. 17. 오후 8:43, 온달고깃집 : 이모티콘 어서오세요
`;
  const i2 = Kakao.parseMessages(ios2);
  assert.deepStrictEqual(i2.formats, ["ios"]);
  assert.deepStrictEqual(i2.messages.map((m) => m.text), ["삼겹 15키로\n목살 8키로", "이모티콘 어서오세요"]);

  const pc2 = `가람식당 님과 카카오톡 대화
저장한 날짜 : 2026-10-20 10:12:34

--------------- 2026년 10월 17일 금요일 ---------------
[가람식당] [오후 8:12] 사장님 내일 쌀 20kg 2포 부탁드려요
[가람식당] [오후 8:15] 사진 3장
[가람식당] [오후 8:18] 20,000원을 보냈어요.
송금 받기 전까지 내역 상세화면에서 취소할 수 있어요.
[김진성] [오후 8:20] 20,000원 받기 완료!
※ (안내) 받은 분은 계좌송금도 무료로 이용할 수 있어요. (3분이면 완료)
박민수님이 들어왔습니다.
[가람식당] [오후 8:30] 그리고 대파도 2단
`;
  const p2 = Kakao.parseMessages(pc2);
  assert.deepStrictEqual(p2.messages.map((m) => m.text), ["사장님 내일 쌀 20kg 2포 부탁드려요", "사진 3장", "그리고 대파도 2단"]);
  const po = Kakao.toOrders(p2.messages, { roles: { 김진성: "me" }, mergeGapMin: 30 });
  assert.strictEqual(po.length, 1);
  assert.strictEqual(po[0].본문, "사장님 내일 쌀 20kg 2포 부탁드려요\n(사진 3장)\n그리고 대파도 2단");

  const mac = `\uFEFFDate,User,Message
2026-10-17 20:12:05,"가람식당","사장님 내일 쌀 20kg 2포 부탁드려요"
2026-10-17 20:12:40,"가람식당","이모티콘"
2026-10-17 20:13:11,"김진성","네 알겠습니다
내일 오전 중 배송할게요"
2026-10-17 20:17:00,"가람식당","""르뽀숑"" 이라는 데야"
`;
  const m2 = Kakao.parseMessages(mac);
  assert.deepStrictEqual(m2.formats, ["mac"]);
  assert.deepStrictEqual(m2.messages.map((m) => m.text), ["사장님 내일 쌀 20kg 2포 부탁드려요", "네 알겠습니다\n내일 오전 중 배송할게요", '"르뽀숑" 이라는 데야']);

  // --- 7. 수정·취소 표현은 자동 확정하지 않고 묻는다 / '반' 수량 / 거래처별 별칭
  const edit = Kakao.toOrders(Kakao.parseMessages("[온달고깃집] [2026-10-18 20:00]\n삼겹 10키로 말고 15키로요\n---\n[해오름횟집] [2026-10-18 20:01]\n부추 한단 반\n---\n").messages);
  const run4 = await ON.runOrders({ orders: edit, catalog: catalog2, history: {}, extractor: new ON.RuleExtractor(catalog2, {}) });
  const sam = run4.resolved.find((r) => r.order.거래처 === "온달고깃집");
  assert.strictEqual(sam.status, "확인필요");
  assert.ok(/수정·취소/.test(sam.사유), sam.사유);
  assert.strictEqual(sam.수량, 15, "마지막 수량으로 채워 두고 묻는다");
  const buchu = run4.resolved.find((r) => r.order.거래처 === "해오름횟집");
  assert.strictEqual(buchu.수량, 1.5);
  const ws2 = Store.migrate(JSON.parse(Store.exportJson(ws)));
  assert.ok(Store.learnAlias(ws2, "V002", "파", { client: "해오름횟집", clientOnly: true }).ok);
  const cat3 = new ON.Catalog(ws2.items, ws2.clientAliases);
  assert.strictEqual(cat3.match("파", "해오름횟집").item.품목코드, "V002", "횟집의 '파'는 쪽파");
  assert.strictEqual(cat3.match("파", "가람식당").item.품목코드, "V001", "다른 곳의 '파'는 대파(전체 별칭)");
  // 열 이름이 다른 CSV(이카운트 품목 내보내기 모양)도 읽는다
  const ws3 = Store.blank();
  const r3 = Store.importItemsCsv(ws3, "품목코드,품명,규격명,기본단위\nA1,대파,1단,단\nA2,\"양파, 햇\",15kg,망\n");
  assert.strictEqual(r3.added, 2);
  assert.strictEqual(ws3.items[1].품목명, "양파, 햇");

  console.log("store/kakao tests OK");
})().catch((e) => { console.error(e); process.exit(1); });
