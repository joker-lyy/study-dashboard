// 晋升提报通知：轮询 Supabase puzzle_records(game=promo_signup) 新提报，
// 从 data.json 学习地图判定学习进度，推送到企微机器人。
// 用法：node _promo_notify.js [--dry]   （--dry 只打印不推送、不写状态）
// 状态：data/promo_state.json { lastTs } —— 只处理 time > lastTs 的提报
const fs = require("fs");
const path = require("path");
const https = require("https");

const SUPABASE_URL = "https://furiqmhvflnjllrwfhyw.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cmlxbWh2ZmxuamxscndmaHl3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTY4MzU3NywiZXhwIjoyMTAxMjU5NTc3fQ.XVZGKGRWhaLG7ZyaYJzPmGI8SJxxBqYZy-fq7bvKz_E"; // service_role，仅本机脚本使用
const WECOM_KEY = "a09cfa00-21e5-46b1-8316-84a90f726bac"; // 晋升提报机器人
const HERE = __dirname;
const DRY = process.argv.includes("--dry");

function req(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    r.on("error", reject);
    r.setTimeout(25000, () => { r.destroy(new Error("timeout")); });
    if (body) r.write(body);
    r.end();
  });
}

// ---------- 学习进度判定 ----------
function byteLen(s) { return Buffer.byteLength(s, "utf8"); }

function judgeProgress(data, store, name) {
  const maps = data.maps || [];
  const dmEmps = (data.directMaps && data.directMaps.emps) || {};
  const norm = s => (s || "").replace(/\s+/g, "");
  const sN = norm(store), nN = norm(name);
  // 在晋升类地图中找 姓名+门店 匹配的学员
  const hits = [];
  for (const mp of maps) {
    if ((mp.categoryName || "") !== "晋升") continue;
    for (const e of mp.emps || []) {
      if (norm(e.employeeName) !== nN) continue;
      const esN = norm(e.storeName || "");
      if (!esN || (esN !== sN && !esN.includes(sN) && !sN.includes(esN))) continue;
      hits.push({ map: mp, emp: e });
    }
  }
  if (!hits.length) return { status: "notfound", text: "未在学习地图中找到该员工，请核对姓名与门店后重新提报" };
  // 取进度最高的一张图（同人多图时汇报全部关键信息）
  hits.sort((a, b) => (parseFloat(b.emp.completionSchedule) || 0) - (parseFloat(a.emp.completionSchedule) || 0));
  const lines = [];
  let allDone = true;
  for (const h of hits) {
    const mp = h.map, e = h.emp;
    const prog = parseFloat(e.completionSchedule) || 0;
    const done = prog >= 100;
    if (!done) allDone = false;
    let detail = null;
    // 直营组有任务级明细：列出未完成任务
    const rec = dmEmps[String(e.employeeId)];
    const mRec = rec && (rec.maps || []).find(m => String(m.mapId) === String(mp.mapId));
    if (mRec && (mRec.stages || []).length) {
      detail = [];
      for (const st of mRec.stages) {
        for (const t of st.tasks || []) {
          if (String(t.status) !== "3") detail.push(`${st.stageName || ""}：${t.taskName || "?"}（未完成）`);
          else if ((t.realScore || "-") !== "-" && parseFloat(t.realScore) < 80 && /考核|考试|练习/.test(t.taskName || "")) {
            detail.push(`${st.stageName || ""}：${t.taskName || "?"} ${t.realScore}分（未达标）`);
            if (done) allDone = false;
          }
        }
      }
    }
    lines.push({ mapName: mp.mapName, prog, done, stage: e.stageName || "", detail });
  }
  if (allDone) {
    const extra = lines.length > 1 ? `（${lines.map(l => `${l.mapName} ${l.prog}%`).join("、")}）` : "";
    return { status: "done", text: `已完成 ✅${extra}` };
  }
  const parts = ["未完成 ❌"];
  for (const l of lines) {
    parts.push(`【${l.mapName}】进度 ${l.prog}%${l.stage ? `（当前阶段：${l.stage}）` : ""}`);
    if (l.detail && l.detail.length) l.detail.forEach(d => parts.push("· " + d));
    else if (l.detail === null) parts.push("· 非直营组学员，未完成任务明细需在学习地图后台查看");
  }
  let text = parts.join("\n");
  if (byteLen(text) > 1600) text = text.slice(0, 700) + "\n·（明细过长已截断，请到学习地图后台查看）";
  return { status: "undone", text };
}

(async () => {
  if (process.argv.includes("--selftest")) {
    const data = JSON.parse(fs.readFileSync(path.join(HERE, "data", "data.json"), "utf8"));
    const dm = (data.directMaps && data.directMaps.emps) || {};
    const ids = Object.keys(dm).slice(0, 3);
    for (const eid of ids) {
      const prof = dm[eid];
      const m0 = (prof.maps || [])[0];
      if (!m0) continue;
      const j = judgeProgress(data, prof.store || "", prof.name || "");
      console.log(`---- ${prof.name} / ${prof.store} / 图:${m0.mapName} ----\n${j.text}\n`);
    }
    return;
  }
  const statePath = path.join(HERE, "data", "promo_state.json");
  let lastTs = 0;
  try { lastTs = JSON.parse(fs.readFileSync(statePath, "utf8")).lastTs || 0; } catch (e) {}

  const q = `${SUPABASE_URL}/rest/v1/puzzle_records?game=eq.promo_signup&time=gt.${lastTs}&order=time.asc&limit=50`;
  const res = await req(q, { method: "GET", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (res.status !== 200) { console.error("[promo-notify] 读取提报失败 HTTP", res.status, res.text.slice(0, 200)); process.exit(1); }
  const rows = JSON.parse(res.text || "[]").filter(r => !(r.store || "").includes("测试"));
  if (!rows.length) { console.log("[promo-notify] 无新提报"); return; }

  const data = JSON.parse(fs.readFileSync(path.join(HERE, "data", "data.json"), "utf8"));
  let maxTs = lastTs;
  const msgs = [];
  for (const r of rows) {
    let sig = {};
    try { sig = JSON.parse(r.name || "{}"); } catch (e) {}
    const store = (r.store || "").trim();
    const name = (sig.name || "").trim();
    const pos = (sig.position || "").trim();
    const ts = Number(r.time) || 0;
    if (ts > maxTs) maxTs = ts;
    if (!store || !name) continue;
    const j = judgeProgress(data, store, name);
    const md = `📢 **晋升提报**\n门店：${store}\n姓名：${name}\n提报职位：${pos || "-"}\n学习进度：${j.text}`;
    msgs.push({ md, status: j.status });
  }
  if (!msgs.length) { console.log("[promo-notify] 新增行均无效"); if (!DRY) { fs.writeFileSync(statePath, JSON.stringify({ lastTs: maxTs })); } return; }

  if (DRY) {
    msgs.forEach(m => console.log("---- [DRY] ----\n" + m.md + "\nbytes=" + byteLen(m.md)));
    return;
  }
  // 推送（逐条，超 2048 字节拆分兜底）
  for (const m of msgs) {
    const body = JSON.stringify({ msgtype: "markdown", markdown: { content: m.md } });
    const r2 = await req(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${WECOM_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }
    }, body);
    let ok = false, err = "";
    try { const j = JSON.parse(r2.text); ok = j.errcode === 0; err = j.errmsg || ""; } catch (e) { err = r2.text.slice(0, 120); }
    console.log(`[promo-notify] push ${ok ? "OK" : "FAIL"}: ${err || r2.text.slice(0, 120)}`);
    if (!ok) process.exit(2);
  }
  fs.writeFileSync(statePath, JSON.stringify({ lastTs: maxTs }));
  console.log(`[promo-notify] 处理 ${msgs.length} 条提报，lastTs=${maxTs}`);
})().catch(e => { console.error("[promo-notify] 异常:", e.message); process.exit(1); });
