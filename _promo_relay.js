/* 晋升报名 Supabase 浏览器中继（10/16）：本机 TCP TLS 被 SNI 阻断、
   但真实浏览器内核（QUIC/ECH）能通 → 用无头 Edge 页面内 fetch 转发。
   输入(stdin JSON)：{method, qs, body}；service key 由本脚本自行读取，不落日志不外传。
   输出(stdout)：{status, data} */
const { chromium } = require("C:/Users/Rain/.workbuddy/binaries/node/workspace/node_modules/playwright-core");
const fs = require("fs");
const path = require("path");

(async () => {
  let req = { method: "GET", qs: "", body: null };
  try { req = Object.assign(req, JSON.parse(fs.readFileSync(0, "utf8"))); } catch (e) {}
  const sec = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "_promo_secrets.json"), "utf8"));
  const H = { apikey: sec.serviceKey, Authorization: "Bearer " + sec.serviceKey, "Content-Type": "application/json" };
  const base = sec.url + "/rest/v1/puzzle_records";
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage();
  /* 网络是分钟级抖动（时好时坏）→ 循环重试直到成功（最多 8 次 × 6s ≈ 48s） */
  let out = null;
  for (let i = 0; i < 8; i++) {
    out = await p.evaluate(async ({ base, H, method, qs, body }) => {
      try {
        const r = await fetch(base + qs, { headers: H, method, body: body == null ? undefined : JSON.stringify(body) });
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        return { status: r.status, data };
      } catch (e) { return { status: 0, data: { relayError: String(e).slice(0, 200) } }; }
    }, { base, H, method: req.method, qs: req.qs, body: req.body });
    if (out.status > 0) break;
    await new Promise(r => setTimeout(r, 6000));
  }
  await b.close();
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ status: 0, data: { relayError: String(e).slice(0, 200) } })); process.exit(0); });
