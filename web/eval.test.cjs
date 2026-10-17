// 웹 포팅 회귀 테스트: node web/eval.test.cjs
// 샘플 20건을 규칙 엔진으로 돌려 정답셋(data/expected.json)과 비교한다. 잘못 매칭이 있으면 exit 1.
const fs = require("fs");
const path = require("path");
const ON = require("./core.js");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

(async () => {
  const catalog = new ON.Catalog(ON.loadItems(read("data/items.csv")));
  const history = ON.loadHistory(JSON.parse(read("data/history.json")));
  const res = await ON.run({ ordersText: read("input/orders.txt"), catalog, history, extractor: new ON.RuleExtractor(catalog, history) });
  const s = res.summary;
  console.log(`주문 ${s.orders}건 / 품목 ${s.lines}줄 / 자동 ${s.autoOrders}/${s.orders}건 / 확인필요 ${s.pendingLines}줄 / ${s.seconds.toFixed(3)}초`);
  for (const r of res.resolved.filter((r) => r.status === "확인필요")) {
    console.log(`  #${r.order.순번} ${r.order.거래처} ${r.line.품목명_원문} — ${r.사유} ${r.후보.join(", ")}`);
  }
  const ev = ON.evaluate(res.resolved, res.orders, JSON.parse(read("data/expected.json")));
  console.log(`잘못 매칭 ${ev.wrong.length}건, 누락 ${ev.missed.length}건, 확인필요 개수 불일치 ${ev.pendingDiff.length}건`);
  if (ev.wrong.length || ev.missed.length || ev.pendingDiff.length) {
    console.log(JSON.stringify(ev));
    process.exit(1);
  }
})();
