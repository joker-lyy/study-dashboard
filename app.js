/* 学习看板 app.js v9
数据源 data/data.json（fetch_study.py 生成）
一级菜单：概述 / 新加盟商培训 / 裂变加盟商培训 / 线上线下培训 / 员工培训/晋升 / 公开课学习 / 评价管理 / 离职管理档案
评价管理目录：新加盟商培训讲师评价 / 课程满意度调研（含慧运营问卷数据 + H5链接/二维码生成）
任务状态：W=已完成 S=未完成；taskType 3=课程 4=考试 5=作业 7=表单 8=实操
离职员工（empStatus != zc）不参与任何统计，统一归入「离职管理档案」
*/
let DATA = null;
let state = { tab: "概述", cat: null, planIdx: 0, sub: "全部", empFilter: "全部", stageKey: null, range: "本月", rFrom: null, rTo: null, gFilter: "全部",
  promoSub: "学习地图", promoMapIdx: 0, promoSince: "2026-09-01", evalSub: "新加盟商培训讲师评价",
  pRegion: "全部", pGroup: "全部", pStore: "全部", dStatus: "全部", dGroups: {}, dRegions: {} };
const PLAN_EXCLUDE = ["测试", "XX", "xx", "课前准备", "174期", "煲饭"];
const SURVEY_RE = /问卷|调查/; // 调查问卷类计划 → 归入 评价管理·课程满意度调研
const TYPE_NAME = { 3: "必修课", 4: "考试", 5: "作业", 7: "表单", 8: "实操" };

const STATUS_MAP = { 0: ["未开始", "b-gray"], 1: ["进行中", "b-orange"], 2: ["已完成", "b-green"] };
const CORE_CATS = ["新加盟商培训", "线上线下培训", "员工培训/晋升"];

function pct(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace("%", "")) || 0;
}
function barHtml(v) {
  const cls = v >= 80 ? "g" : v >= 40 ? "o" : "r";
  return `<span class="bar"><i class="${cls}" style="width:${Math.min(v, 100)}%"></i></span>${v.toFixed(1)}%`;
}
// 单科考试分数展示：未考红字、0分红字、未过红字、<80红字
function scoreCell(t, suffix) {
  const suf = suffix === false ? "" : "分";
  if (!t || t[2] !== "W") return `<span style="color:#e64340;font-weight:600">未考</span>`;
  const n = +t[3];
  if (isNaN(n)) return `<span style="color:#e64340;font-weight:600">未考</span>`;
  const bad = n < 80 || t[4] === "否";
  return `<span style="${bad ? "color:#e64340;font-weight:600" : ""}">${n}${suf}${t[4] === "否" ? "(未过)" : ""}</span>`;
}
function esc(s) { return (s == null ? "" : String(s)).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])); }

// 把学员的区域链路 "总经办/加盟服务部/新店运营组/刘浩区域" 拆出层级
function orgParts(emp) {
  const s = emp.organizeNames || emp.storeNames || "";
  return s.split("/").map(x => x.trim()).filter(Boolean);
}
function regionOf(emp) { const p = orgParts(emp); return p[p.length - 1] || "未分配"; }
function groupOf(emp) { const p = orgParts(emp); return p.length >= 2 ? p[p.length - 2] : "未分配"; }
function storeOf(emp) { return emp.storeNames || "无门店"; }
function uniqSort(a) { return [...new Set(a)].sort(); }

function statusOf(emp) {
  if (emp.empStatus && emp.empStatus !== "zc") return null; // 不在职不显示
  return emp.trainingStatus;
}

// 计划内按 key 聚合学员（状态以员工明细 done/total 为准，trainingStatus 不可靠）
function aggregate(plan, keyFn) {
  const map = {};
  (plan.emps || []).forEach(e => {
    const st = statusOf(e);
    if (st == null) return;
    const s = empStat(plan, e);
    const status = s ? s.status : st; // 有明细用明细，无明细回退列表状态
    const k = keyFn(e);
    if (!map[k]) map[k] = { name: k, total: 0, done: 0, doing: 0, todo: 0 };
    map[k].total++;
    if (status === 2) map[k].done++;
    else if (status === 1) map[k].doing++;
    else map[k].todo++;
  });
  const arr = Object.values(map);
  arr.forEach(a => a.rate = a.total ? a.done / a.total * 100 : 0);
  arr.sort((a, b) => b.rate - a.rate || b.total - a.total);
  return arr;
}

function isSurvey(p) { return SURVEY_RE.test(p.planName || ""); }
const PUB_GROUPS = ["培训组(直营组)", "新店运营组", "加盟营运组", "新店筹建组"];
function plansOf(cat, gOverride) {
  let arr = DATA.plans.filter(p => p.category === cat && !isSurvey(p) && !PLAN_EXCLUDE.some(k => (p.planName || "").includes(k)));
  // 其他 Tab：只保留四个组发布的计划，支持组别导航筛选
  if (cat === "其他") { const g = gOverride || state.gFilter; arr = arr.filter(p => p.pubGroup && (g === "全部" || p.pubGroup === g)); }
  return arr;
}
function setGFilter(v) { state.gFilter = v; state.planIdx = 0; render(); }
function surveysOf() {
  return DATA.plans.filter(p => p.category === "线上线下培训" && isSurvey(p) && !PLAN_EXCLUDE.some(k => (p.planName || "").includes(k)));
}

/* ---------- 右上角区间筛选（按计划开始日期 / 评估提交时间） ---------- */
const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function monthStart(offset) { // offset 0=本月1日, -1=上月1日（本地时区，不能用 toISOString 的 UTC）
  const n = new Date();
  return fmtLocal(new Date(n.getFullYear(), n.getMonth() + offset, 1));
}
function monthRange(offset) { // offset 0=本月, -1=上月
  const n = new Date();
  const y = n.getFullYear(), m = n.getMonth() + offset;
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 0);
  return [fmtLocal(from), fmtLocal(to)];
}
function dateInrange(dateStr) {
  if (state.range === "全部" || !dateStr) return state.range === "全部";
  const d = String(dateStr).slice(0, 10);
  let from, to;
  if (state.range === "本月") [from, to] = monthRange(0);
  else if (state.range === "上月") [from, to] = monthRange(-1);
  else { from = state.rFrom; to = state.rTo; if (!from && !to) return true; }
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
function plansInRange(cat, gOverride) { return plansOf(cat, gOverride).filter(p => dateInrange(p.startDate)); }
function setRange(r) {
  state.range = r;
  if (r === "区间") {
    state.rFrom = document.getElementById("rFrom").value || null;
    state.rTo = document.getElementById("rTo").value || null;
    if (!state.rFrom && !state.rTo) return;
  }
  state.planIdx = 0;
  document.querySelectorAll("#rangeBar button").forEach(b => b.classList.toggle("active", b.dataset.r === r));
  render();
}

/* ---------- 员工真实进度（以员工明细接口为准） ---------- */
function empStat(p, e) {
  const det = p.empDetails && p.empDetails[String(e.employeeId)];
  if (!det || det.total == null) return null;
  const done = det.done || 0, total = det.total || 0;
  const status = total > 0 && done >= total ? 2 : done > 0 ? 1 : 0;
  return { det, done, total, rate: total ? done / total * 100 : 0, status };
}

/* ---------- 概述 ---------- */
function renderOverview() {
  const el = document.getElementById("main");
  const catCards = CORE_CATS.map(cat => {
    const plans = plansInRange(cat);
    let emps = 0, done = 0;
    plans.forEach(p => (p.emps || []).forEach(e => {
      if (statusOf(e) == null) return;
      const st = empStat(p, e);
      emps++;
      if (st ? st.status === 2 : e.trainingStatus === 2) done++;
    }));
    const rate = emps ? done / emps * 100 : 0;
    const latest = plans.slice(0, 5).map(p => {
      const st = empStat(p, p.emps[0] || {}) && null; // noop
      // 整体完成率优先用平台概述，否则按员工明细均摊
      let ovRate = p.overview && p.overview.percentageComplete;
      if (ovRate == null) {
        let t = 0, d2 = 0;
        (p.emps || []).forEach(e => { const s = empStat(p, e); if (s) { t += s.total; d2 += s.done; } });
        ovRate = t ? (d2 / t * 100).toFixed(0) + "%" : "-";
      }
      return `<tr><td>${esc(p.planName)}</td><td>${p.startDate || "-"}</td><td>${ovRate}</td></tr>`;
    }).join("") || `<tr><td colspan=3 class=empty>暂无计划</td></tr>`;
    return `<div class="sec">
      <h3>${cat} <span class="badge b-blue">${plans.length} 个计划</span></h3>
      <div class="cards">
        <div class="card"><div class="k">学员总数</div><div class="v">${emps}</div></div>
        <div class="card"><div class="k">已完成</div><div class="v">${done}</div></div>
        <div class="card"><div class="k">完成率</div><div class="v">${rate.toFixed(1)}<small>%</small></div></div>
      </div>
      <table><tr><th>最近计划</th><th>开始日期</th><th>整体完成率</th></tr>${latest}</table>
    </div>`;
  }).join("");
  el.innerHTML = `<div class="summary-sec">${catCards}</div>`;
}

/* ---------- 分类页 ---------- */
function renderCat() {
  const el = document.getElementById("main");
  // 其他 Tab：组别固定导航（始终可见，带数量），避免筛选到空组别后"回不去"
  const gnav = state.cat === "其他" ? `<div class="planbar" style="flex-wrap:wrap">
    ${["全部", ...PUB_GROUPS].map(g => {
      const n = plansInRange("其他", g).length;
      return `<button class="btn" style="padding:7px 14px;font-size:13px;${state.gFilter === g ? "" : "background:var(--line);color:var(--t1)"}" onclick="setGFilter('${g}')">${g === "全部" ? "全部组别" : g}<span style="opacity:.75;margin-left:4px">${n}</span></button>`;
    }).join("")}</div>` : "";
  const plans = plansInRange(state.cat);
  if (!plans.length) { el.innerHTML = gnav + `<div class="sec empty">该组别暂无计划数据</div>`; return; }
  state.planIdx = Math.min(state.planIdx, plans.length - 1);
  const p = plans[state.planIdx];

  const opts = plans.map((x, i) => `<option value="${i}" ${i === state.planIdx ? "selected" : ""}>${esc(x.planName)}（${x.startDate || "?"}）</option>`).join("");
  const ov = p.overview || {};

  // 学习时间：优先平台有效期（"起 至 止"），否则计划起止日期，两行显示
  const validRaw = ov.periodOfValidity || "";
  const [vFrom, vTo] = validRaw.includes("至") ? validRaw.split("至").map(x => x.trim()) : [p.startDate, p.endDate];
  const timeCard = `<div class="card"><div class="k">学习时间</div><div class="v" style="font-size:14px;line-height:2;text-align:left">开始：${esc(vFrom || "-")}<br>结束：${esc(vTo || "-")}</div></div>`;

  // 概述卡片
  const cards = `
    <div class="cards">
      <div class="card"><div class="k">应学人数</div><div class="v">${ov.numberOfPersonsDueToComplete ?? (p.emps || []).length}</div></div>
      <div class="card"><div class="k">已完成</div><div class="v">${ov.numberOfPeopleCompleted ?? "-"}</div></div>
      <div class="card"><div class="k">完成率</div><div class="v">${pct(ov.percentageComplete).toFixed(1) || 0}<small>%</small></div></div>
      <div class="card"><div class="k">应学门店</div><div class="v">${ov.shouldTrainStoreCount ?? (p.storeStats || []).length}</div></div>
      <div class="card"><div class="k">已参训门店</div><div class="v">${ov.trainedStoreCount ?? "-"}</div></div>
      ${timeCard}
    </div>`;

  // 阶段统计（行可点 -> 阶段学员明细）
  const stageRows = (p.stageStats || []).map((s, i) => {
    const key = s.phaseName;
    return `<tr class="clickable" onclick="openStage('${esc(key).replace(/'/g, "")}')"><td>${esc(s.phaseName)}</td><td>${s.numberOfPersonsDueToComplete}</td><td>${s.uninitiatedNumber}</td><td>${s.numberOfPeopleInProgress}</td><td>${s.numberOfPeopleCompleted}</td><td>${barHtml(pct(s.phaseCompletionRate))}</td></tr>`;
  }).join("");

  // 二级
  const SUBS = state.cat === "线上线下培训" ? ["区域汇总", "组别汇总", "门店分数排名及明细"] : ["全部", "区域汇总", "组别汇总", "门店分数排名及明细"];
  if (!SUBS.includes(state.sub)) state.sub = SUBS[0];
  let body = "";
  if (state.sub === "区域汇总") body = aggTable(aggregate(p, regionOf), "区域");
  else if (state.sub === "组别汇总") body = aggTable(aggregate(p, groupOf), "组别");
  else if (state.sub === "门店分数排名及明细") body = storeRankTable(p);
  else body = (() => {
    const emps = (p.emps || []).filter(e => statusOf(e) != null);
    return emps.length ? `<div style="font-size:12px;color:var(--t2);margin-bottom:6px">全体学习明细（门店列可区分所属门店），同「查看明细」格式</div>${aggDetailTable(p, emps)}` : `<div class="empty">暂无学员数据</div>`;
  })();

  el.innerHTML = `
    ${gnav}
    <div class="planbar">
      <select onchange="state.planIdx=+this.value;renderCat()">${opts}</select>
      <span class="badge b-gray">学员 ${(p.emps || []).length} 人</span>
      ${p.overview ? "" : `<span class="badge b-red">概述数据无权限（非计划管理员）</span>`}
    </div>
    ${cards}
    ${stageRows ? `<div class="sec"><h3>阶段完成情况</h3><div style="font-size:12px;color:var(--t2);margin-bottom:6px">点击阶段行可查看该阶段每位学员的学习 / 考试 / 实操完成情况</div><table><tr><th>阶段</th><th>应完成</th><th>未开始</th><th>进行中</th><th>已完成</th><th>完成率</th></tr>${stageRows}</table></div>` : ""}
    <div class="sec">
      <h3>二级汇总</h3>
      <div class="subtabs">
        ${SUBS.map(s => `<button class="${state.sub === s ? "active" : ""}" onclick="state.sub='${s}';renderCat()">${s}</button>`).join("")}
      </div>
      ${body}
    </div>`;
}

function aggTable(arr, label) {
  if (!arr.length) return `<div class="empty">暂无学员数据</div>`;
  return `<table><tr><th>${label}</th><th>总人数</th><th>已完成</th><th>进行中</th><th>未开始</th><th>完成率</th><th style="width:90px">操作</th></tr>
    ${arr.map(a => `<tr><td>${esc(a.name)}</td><td>${a.total}</td><td>${a.done}</td><td>${a.doing}</td><td>${a.todo}</td><td>${barHtml(a.rate)}</td>
      <td><button class="btn" style="padding:5px 12px;font-size:12px" onclick="openAgg('${label}','${encodeURIComponent(a.name)}')">查看明细</button></td></tr>`).join("")}</table>`;
}
/* 二级汇总行明细：区域/组别 -> 学员整计划学习明细 */
let aggFilter = "全部";
function planTasks(p, e) { // 整计划所有阶段任务拍平
  const det = p.empDetails && p.empDetails[String(e.employeeId)];
  if (!det || !det.stages) return [];
  return det.stages.reduce((a, s) => a.concat(s.t || []), []);
}
let aggReopen = null;
function openAgg(label, nameEnc, keep) {
  const name = decodeURIComponent(nameEnc);
  if (!keep) aggFilter = "全部";
  const plans = plansInRange(state.cat);
  const p = plans[state.planIdx];
  const keyFn = label === "区域" ? regionOf : groupOf;
  let emps = (p.emps || []).filter(e => statusOf(e) != null && keyFn(e) === name);
  emps = aggFilterEmps(p, emps);
  aggReopen = () => openAgg(label, nameEnc, true);
  aggDetailRender(p, emps, (p.planName || "") + " · " + name + " · 学习明细");
}
function aggFilterEmps(p, emps) {
  const isDone = e => {
    const st = empStat(p, e);
    if (st) return st.total > 0 && st.done >= st.total;
    return statusOf(e) === 2; // 无明细计划回退平台完成状态
  };
  if (aggFilter === "已完成") return emps.filter(isDone);
  if (aggFilter === "未完成") return emps.filter(e => !isDone(e));
  return emps;
}
// 弹窗正文：按天（阶段）一列展示出勤+分数（区域/组别/门店明细共用）
function aggDetailTable(p, emps) {
  // 阶段列表（按计划阶段顺序，去重）；无明细的计划（直播类等）回退完成状态
  const hasDet = p.empDetails && Object.keys(p.empDetails).length > 0;
  const stageNames = [];
  (function () {
    const det0 = p.empDetails && Object.values(p.empDetails)[0];
    (det0 && det0.stages || []).forEach(s => { if (s.n && !stageNames.includes(s.n)) stageNames.push(s.n); });
    // 兜底：汇总所有学员出现的阶段
    Object.values(p.empDetails || {}).forEach(det => (det.stages || []).forEach(s => { if (s.n && !stageNames.includes(s.n)) stageNames.push(s.n); }));
  })();
  const leaveOf = (sn, e) => {
    const lv = p.leaves && p.leaves[sn];
    return !!(lv && (lv.includes(String(e.employeeId)) || lv.includes(e.empName)));
  };
  const rows = emps.map((e, i) => {
    if (!hasDet) {
      const st = statusOf(e);
      const [txt, cls] = st === 2 ? ["已完成", "b-green"] : st === 1 ? ["进行中", "b-orange"] : ["未开始", "b-gray"];
      return `<tr><td>${i + 1}</td><td style="white-space:nowrap">${esc(e.empName)}</td><td style="max-width:130px">${esc(storeOf(e))}</td><td style="text-align:center"><span class="badge ${cls}">${txt}</span></td></tr>`;
    }
    const ts = planTasks(p, e);
    const ops = ts.filter(t => [5, 7, 8].includes(t[1]));
    const cnt = a => `${a.filter(t => t[2] === "W").length}/${a.length}`;
    const stat = empStat(p, e);
    const det = p.empDetails && p.empDetails[String(e.employeeId)];
    const dayCells = stageNames.map(sn => {
      const stg = det && (det.stages || []).find(s => (s.n || "") === sn);
      const sts = stg ? (stg.t || []) : [];
      // 出勤：请假 > 已签到（有任务完成记录）> 未签到（紧凑文字样式）
      let att = `<span style="font-size:11px;font-weight:600;color:var(--orange)">未签到</span>`;
      if (leaveOf(sn, e)) att = `<span style="font-size:11px;color:var(--t2)">请假</span>`;
      else if (sts.some(t => t[5] && t[5] !== "-")) att = `<span style="font-size:11px;font-weight:600;color:var(--green)">已签到</span>`;
      // 分数：该天全部考核，多科/隔开；未考=有考试未完成；—=无考试；红=未达80
      const exams = sts.filter(t => t[1] === 4);
      // 必修课=网课(3)+实操课(8)：实操视频课（手握饭团等）同为强制学习，按必修口径统计
      const learn = sts.filter(t => t[1] === 3 || t[1] === 8);
      let scoreStr = "—";
      if (exams.length) {
        // 多科竖排，每科一行，避免横向超出格子
        scoreStr = exams.map(t => scoreCell(t, false)).join("</div><div>");
      }
      const learnStr = `<div style="font-size:11px;color:${learn.length && learn.every(t => t[2] === "W") ? "var(--t2)" : "#e64340"}">必修课 ${cnt(learn)}</div>`;
      return `<td style="text-align:center;border-left:1px solid var(--line);font-size:12px;line-height:1.5;vertical-align:top"><div>${att}</div><div>${scoreStr}</div>${learnStr}</td>`;
    }).join("");
    return `<tr><td style="white-space:nowrap">${esc(e.empName)}</td><td style="white-space:nowrap">${esc(storeOf(e))}</td><td style="text-align:center">${cnt(ops)}</td><td style="text-align:center">${stat ? `${stat.done}/${stat.total}` : "-"}</td>${dayCells}</tr>`;
  }).join("");
  return !hasDet
    ? `<div style="font-size:12px;color:#b45309;background:#fff7e6;border:1px solid #ffe3a3;border-radius:8px;padding:8px 12px;margin-bottom:8px">⚠️ 该计划为直播/特殊类型，慧运营平台不提供任务明细接口（明细接口对该计划返回失败），无法统计每人的必修课/考试/实操/总进度，仅展示平台返回的完成状态。</div>${rows ? `<table><tr><th>序号</th><th>姓名</th><th>门店</th><th>完成状态</th></tr>${rows}</table>` : `<div class="empty">无符合筛选条件的学员</div>`}`
    : (rows ? `<table><tr><th>姓名</th><th>门店</th><th>实操</th><th>总进度</th>${stageNames.map(sn => `<th style="text-align:center;border-left:1px solid var(--line);white-space:normal;word-break:break-all;min-width:92px">${esc(sn)}</th>`).join("")}</tr>${rows}</table>` : `<div class="empty">无符合筛选条件的学员</div>`);
}

// 线上线下培训的明细版式：姓名/门店/区域/实操/考试分数/阶段进度/完成任务明细（抓取同新加盟商培训）
function flatDetailTable(p, emps) {
  const hasDet = p.empDetails && Object.keys(p.empDetails).length > 0;
  if (!hasDet) return aggDetailTable(p, emps);
  const rows = emps.map(e => {
    const ts = planTasks(p, e);
    const ops = ts.filter(t => [5, 7, 8].includes(t[1]));
    const exams = ts.filter(t => t[1] === 4);
    const cnt = a => `${a.filter(t => t[2] === "W").length}/${a.length}`;
    const stat = empStat(p, e);
    const scoreStr = exams.length ? exams.map(t => scoreCell(t, false)).join("</div><div>") : "—";
    const detail = ts.map(t => {
      const [name, type, st, score, isPass] = t;
      const ok = st === "W";
      let extra = "";
      if (type === 4) extra = score !== "-" && score != null ? `（${score}分${isPass === "否" ? "，未过" : ""}）` : "（未考）";
      return `<div style="padding:1px 0;color:${ok ? "var(--t1)" : "#e64340"}">${esc(name)}：${ok ? "✓ 已完成" : "✗ 未完成"}${extra}</div>`;
    }).join("") || `<div style="color:var(--t2)">无任务数据</div>`;
    return `<tr><td style="white-space:nowrap">${esc(e.empName)}</td><td style="white-space:nowrap">${esc(storeOf(e))}</td><td style="white-space:nowrap">${esc(regionOf(e))}</td><td style="text-align:center">${cnt(ops)}</td><td style="text-align:center"><div>${scoreStr}</div></td><td style="text-align:center">${stat ? `${stat.done}/${stat.total}` : "-"}</td><td>${detail}</td></tr>`;
  }).join("");
  return `<table><tr><th>姓名</th><th>门店</th><th>区域</th><th>实操</th><th>考试分数</th><th>阶段进度</th><th style="min-width:260px">完成任务明细</th></tr>${rows}</table>`;
}

function aggDetailRender(p, emps, title) {
  document.getElementById("mTitle").textContent = title;
  document.getElementById("mBody").innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">
      ${["全部", "已完成", "未完成"].map(f => `<button class="btn" style="padding:5px 14px;font-size:12px;${aggFilter === f ? "" : "background:var(--line);color:var(--t1)"}" onclick="aggFilter='${f}';aggReopen&&aggReopen()">${f}</button>`).join("")}
      <span style="margin-left:auto;font-size:12px;color:var(--t2)">共 ${emps.length} 人</span>
    </div>
    ${state.cat === "线上线下培训" ? flatDetailTable(p, emps) : aggDetailTable(p, emps)}`;
  document.getElementById("mask").classList.add("show");
}

/* ---------- 门店分数排名 ---------- */
function storeScore(s) {
  // 综合分 = 参训率30% + 整体完成率70%（满分100；后续接入考试成绩再加权）
  const train = pct(s.trainRate), comp = pct(s.completionRate || s.ztwclValue);
  return train * 0.3 + comp * 0.7;
}
function storeRankTable(p) {
  // 完成率按员工明细实时联动（done/total），平台字段为0时兜底
  const rows = (p.storeStats || []).map(s => {
    const emps = (p.emps || []).filter(e => storeOf(e) === s.storeName && statusOf(e) != null);
    let done = 0, total = 0, doneN = 0;
    emps.forEach(e => {
      const st = empStat(p, e);
      if (st) { done += st.done; total += st.total; if (st.total && st.done >= st.total) doneN++; }
    });
    const rate = total ? done / total * 100 : pct(s.completionRate || s.ztwclValue);
    const link = (s.organizeLink || "").split("/").filter(Boolean);
    return { s, rate, empN: emps.length, doneN, region: link[link.length - 1] || "" };
  }).sort((a, b) => b.rate - a.rate);
  const kw = (state.storeSearch || "").trim().toLowerCase();
  const shown = kw ? rows.filter(r => (r.s.storeName || "").toLowerCase().includes(kw) || (r.region || "").toLowerCase().includes(kw)) : rows;
  if (!rows.length) return `<div class="empty">暂无门店数据</div>`;
  return `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
    <input id="storeSearch" placeholder="搜索门店 / 区域…" value="${esc(state.storeSearch || "")}" oninput="state.storeSearch=this.value;if(!window.__storeSearchIME)setTimeout(()=>{if(!window.__storeSearchIME){renderCat();var i=document.getElementById('storeSearch');if(i){i.focus();var v=i.value;i.setSelectionRange(v.length,v.length);}}},300)" oncompositionstart="window.__storeSearchIME=1" oncompositionend="window.__storeSearchIME=0;state.storeSearch=this.value;renderCat()" onkeydown="if(event.key==='Enter'){window.__storeSearchIME=0;state.storeSearch=this.value;renderCat()}" style="padding:7px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;width:220px">
    <span style="font-size:12px;color:var(--t2)">${kw ? `匹配 ${shown.length} / ${rows.length} 家` : `共 ${rows.length} 家`}</span>
  </div>
  <table><tr><th>排名</th><th>门店</th><th>区域</th><th>门店参训人数</th><th>已完成人数</th><th>完成率</th><th>状态</th><th style="width:90px">操作</th></tr>
    ${shown.map((r, i) => `<tr>
      <td>${i + 1}</td><td style="white-space:nowrap">${esc(r.s.storeName)}</td>
      <td style="color:var(--t2)">${esc(r.region)}</td>
      <td style="text-align:center">${r.empN}</td><td style="text-align:center">${r.doneN}</td>
      <td>${barHtml(r.rate)}</td>
      <td><span class="badge ${r.s.storeStudyStatus === "已参训" ? "b-green" : "b-orange"}">${esc(r.s.storeStudyStatus || "-")}</span></td>
      <td style="text-align:center"><button class="btn" style="padding:4px 10px;font-size:12px" onclick="event.stopPropagation();openStore('${r.s.storeId}')">查看明细</button></td>
    </tr>`).join("")}</table>
    <div style="margin-top:8px;font-size:12px;color:var(--t2)">完成率 = 门店学员已完成任务 ÷ 应完成任务（按学习明细实时统计），点「查看明细」看门店员工学习明细</div>`;
}

/* ---------- 阶段学员明细弹窗 ---------- */
function taskBadge(t) {
  const [name, type, st, score, isPass] = t;
  const ok = st === "W";
  const label = TYPE_NAME[type] || "任务";
  let txt = `${label}${ok ? "✓" : "✗"}`;
  let cls = ok ? "b-green" : "b-orange";
  let extra = "";
  if (type === 4) extra = score !== "-" && score != null ? ` ${score}分${isPass === "否" ? "(未过)" : ""}` : " 未考";
  return `<span class="badge ${cls}" style="margin:2px 4px 2px 0">${esc(name)}（${label}）${ok ? "已完成" : "未完成"}${extra}</span>`;
}
function openStage(stageName) {
  state.stageKey = stageName;
  renderStageModal();
  document.getElementById("mask").classList.add("show");
}
// 学员组别/区域（从组织链路取四组+区域）
function mGroup(e) {
  const chains = (e.organizeNames || "").split("、");
  for (const ch of chains) {
    const parts = ch.split("/").map(x => x.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const g = parts[i];
      if (g.includes("培训组")) return { g: "培训组(直营组)", r: parts[i + 1] || "-" };
      if (g === "新店运营组" || g === "加盟营运组") return { g, r: parts[i + 1] || "-" };
      if (g.includes("筹建组")) return { g: "新店筹建组", r: parts[i + 1] || "-" };
    }
  }
  return { g: "其他", r: regionOf(e) || "-" };
}
function toggleDFilter(kind, val, cb) {
  const set = state["d" + kind];
  if (cb.checked) set[val] = 1; else delete set[val];
  renderStageModal();
}
function setDStatus(v) { state.dStatus = v; renderStageModal(); }
function renderStageModal() {
  const stageName = state.stageKey;
  const plans = plansInRange(state.cat);
  const p = plans[state.planIdx];
  document.getElementById("mTitle").textContent = (p.planName || "") + " · " + stageName + " · 学习明细";
  let emps = (p.emps || []).filter(e => statusOf(e) != null);
  const allGroups = ["培训组(直营组)", "新店运营组", "加盟营运组", "新店筹建组"];
  const gset = state.dGroups, rset = state.dRegions;
  if (gset && Object.keys(gset).length) emps = emps.filter(e => gset[mGroup(e).g]);
  if (rset && Object.keys(rset).length) emps = emps.filter(e => rset[mGroup(e).r]);
  // 已完成/未完成 —— 按该阶段口径（阶段内全部任务完成才算已完成）
  const stageOf = e => {
    const det = p.empDetails && p.empDetails[String(e.employeeId)];
    return det && (det.stages || []).find(s => (s.n || "") === stageName);
  };
  const stageDone = e => {
    const stg = stageOf(e);
    if (!stg) return false;
    const ts = stg.t || [];
    return ts.length > 0 && ts.every(t => t[2] === "W");
  };
  if (state.dStatus === "已完成") emps = emps.filter(stageDone);
  if (state.dStatus === "未完成") emps = emps.filter(e => !stageDone(e));
  const regions = uniqSort(emps.map(e => mGroup(e).r));
  const boxes = (kind, set, opts) => opts.map(o => `<label style="margin:0 10px 0 0;white-space:nowrap;cursor:pointer"><input type="checkbox" ${set[o] ? "checked" : ""} onclick="toggleDFilter('${kind}','${esc(o)}',this)" style="vertical-align:-2px"> ${esc(o)}</label>`).join("");
  // 出勤：请假（data/leave.json 手工名单）> 已签到（该阶段有任务完成记录）> 未签到
  const attOf = e => {
    const lv = p.leaves && p.leaves[stageName];
    if (lv && (lv.includes(String(e.employeeId)) || lv.includes(e.empName))) return ["请假", "b-gray"];
    const stg = stageOf(e);
    if (stg && (stg.t || []).some(t => t[5] && t[5] !== "-")) return ["已签到", "b-green"];
    return ["未签到", "b-orange"];
  };
  const rows = emps.map(e => {
    const stage = stageOf(e);
    const ts = stage ? stage.t : [];
    // 必修课=网课(3)+实操课(8)：实操视频课同为强制学习；作业/表单(5/7)单列
    const learn = ts.filter(t => t[1] === 3 || t[1] === 8), exams = ts.filter(t => t[1] === 4), ops = ts.filter(t => [5, 7].includes(t[1]));
    const cnt = a => a.length ? `${a.filter(t => t[2] === "W").length}/${a.length}` : "—";
    // 分数：该阶段全部考核，多科以/隔开；未考=有考试未完成；—=无考试；红=未达80
    let scoreStr = "—";
    if (exams.length) {
      scoreStr = exams.map(t => scoreCell(t)).join("/");
    }
    const stageDoneCnt = `${ts.filter(t => t[2] === "W").length}/${ts.length}`;
    const [attTxt, attCls] = attOf(e);
    const mg = mGroup(e);
    // 任务明细：一行一个课题「课题名：完成情况」
    const detail = ts.map(t => {
      const [name, type, st, score, isPass] = t;
      const ok = st === "W";
      let extra = "", bad = !ok;
      if (type === 4) {
        if (score !== "-" && score != null && !isNaN(+score)) { extra = `（${score}分${isPass === "否" ? "，未过" : ""}）`; if (+score < 80 || +score === 0 || isPass === "否") bad = true; }
        else extra = "（未考）";
      }
      return `<div style="padding:1px 0;color:${bad ? "#e64340" : "var(--t1)"}">${esc(name)}：${ok ? "✓ 已完成" : "✗ 未完成"}${extra}</div>`;
    }).join("") || `<div style="color:var(--t2)">无任务数据</div>`;
    return `<tr>
      <td>${esc(e.empName)}</td>
      <td style="max-width:130px">${esc(storeOf(e))}</td>
      <td>${esc(mg.r)}</td>
      <td><span class="badge ${attCls}">${attTxt}</span></td>
      <td>${cnt(learn)}</td>
      <td>${scoreStr}</td>
      <td>${cnt(ops)}</td>
      <td>${stageDoneCnt}</td>
      <td>${detail}</td>
    </tr>`;
  }).join("");
  document.getElementById("mBody").innerHTML = `
    <div style="font-size:12px;color:var(--t2);margin-bottom:8px">说明：必修课/考试/实操/进度均为<b>该阶段</b>口径；出勤=该阶段有任务完成记录（已签到），请假以培训部登记为准；分数为当天全部考核成绩（多科以 / 隔开），未考=当天有考试但未完成，—=当天无考试安排，红色=该科未达80分。</div>
    <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px">
      <b>组别：</b>${boxes("Groups", gset, allGroups)}
    </div>
    <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px">
      <b>区域：</b>${boxes("Regions", rset, regions)}
    </div>
    <div style="margin-bottom:8px;font-size:13px;display:flex;align-items:center;gap:6px">
      <b>完成状态：</b>
      ${["全部", "已完成", "未完成"].map(f => `<button class="btn" style="padding:5px 14px;font-size:12px;${state.dStatus === f ? "" : "background:var(--line);color:var(--t1)"}" onclick="setDStatus('${f}')">${f}</button>`).join("")}
      <span style="color:var(--t2);margin-left:8px">共 ${emps.length} 人</span>
    </div>
    ${rows ? `<table><tr><th>姓名</th><th>门店</th><th>区域</th><th>出勤</th><th>必修课</th><th>考试分数</th><th>实操</th><th>阶段进度</th><th>完成任务明细</th></tr>${rows}</table>` : `<div class="empty">无符合筛选条件的学员</div>`}`;
}

/* ---------- 门店明细弹窗 ---------- */
let empsCache = [];
function openStore(storeId) {
  const plans = plansInRange(state.cat);
  const p = plans[state.planIdx];
  const st = (p.storeStats || []).find(s => String(s.storeId) === String(storeId));
  let emps = (p.emps || []).filter(e => storeOf(e) === (st && st.storeName) && statusOf(e) != null);
  emps = aggFilterEmps(p, emps);
  aggReopen = () => openStore(storeId);
  aggDetailRender(p, emps, (st ? st.storeName : "门店") + " · 学习明细");
}
function empStatusBadge(stat, e) {
  const [txt, cls] = stat
    ? (stat.status === 2 ? ["已完成", "b-green"] : stat.status === 1 ? ["进行中", "b-orange"] : ["未开始", "b-gray"])
    : (((STATUS_MAP[e.trainingStatus]) || ["未知", "b-gray"]));
  return `<span class="badge ${cls}">${txt}</span>${stat ? `<span style="color:var(--t2);font-size:12px"> ${stat.done}/${stat.total}</span>` : ""}`;
}
function renderStoreModal() {
  const p = plansInRange(state.cat)[state.planIdx];
  const cats = ["全部", "新加盟商培训", "裂变加盟商培训", "线上线下培训", "员工培训/晋升", "公开课学习"];
  let body = "";
  if (state.empFilter === "全部") {
    const rows = empsCache.map(e => {
      const stat = empStat(p, e);
      return `<tr><td>${esc(e.empName)}</td><td>${esc(e.empCode || "")}</td><td>${esc(e.positionName || "")}</td>
        <td style="color:var(--t2)">${esc((e.organizeNames || "").split("/").pop() || "")}</td>
        <td>${empStatusBadge(stat, e)}</td></tr>`;
    }).join("");
    body = rows ? `<table><tr><th>姓名</th><th>工号</th><th>职位</th><th>区域</th><th>学习进度</th></tr>${rows}</table>` : `<div class="empty">该门店在本计划下无在职学员</div>`;
  } else {
    // 跨计划档案：该员工在所选学习方式下所有计划的完成情况
    const plans = plansInRange(state.empFilter).slice(0, 20);
    const rows = [];
    empsCache.forEach(e => {
      plans.forEach(pl => {
        const pe = (pl.emps || []).find(x => x.employeeId === e.employeeId);
        if (!pe || statusOf(pe) == null) return;
        const stat = empStat(pl, pe);
        rows.push(`<tr><td>${esc(e.empName)}</td><td>${esc(pl.planName)}</td><td>${pl.startDate || "-"}</td><td>${empStatusBadge(stat, pe)}</td></tr>`);
      });
    });
    body = rows.length
      ? `<table><tr><th>姓名</th><th>计划</th><th>开始日期</th><th>学习进度</th></tr>${rows.join("")}</table>`
      : `<div class="empty">该门店学员在「${state.empFilter}」下暂无学习记录</div>`;
  }
  document.getElementById("mBody").innerHTML = `
    <div class="filters">${cats.map(c => `<button class="${state.empFilter === c ? "active" : ""}" onclick="state.empFilter='${c}';renderStoreModal()">${c}</button>`).join("")}</div>
    ${body}`;
}
function closeModal() { document.getElementById("mask").classList.remove("show"); }

/* ---------- 员工培训/晋升 · 学习地图 ---------- */
function setPRegion(v) { state.pRegion = v; state.pGroup = "全部"; state.pStore = "全部"; renderPromo(); }
function setPGroup(v) { state.pGroup = v; state.pStore = "全部"; renderPromo(); }
function setPStore(v) { state.pStore = v; renderPromo(); }
function renderPromo() {
  const el = document.getElementById("main");
  const maps = DATA.maps || [];
  if (state.promoSub === "培训计划") { state.cat = state.tab; renderCat(); return; }
  if (!maps.length) { el.innerHTML = `<div class="sec empty">暂无学习地图数据，请先运行 fetch_study.py 更新</div>`; return; }
  state.promoMapIdx = Math.min(state.promoMapIdx, maps.length - 1);
  const mp = maps[state.promoMapIdx];
  const all = (mp.emps || []).filter(e => !((e.storeName || "").includes("测试")));
  // 注册日期筛选（issueDate = 地图发放/注册时间）
  const all0 = state.promoSince ? all.filter(e => (e.issueDate || "").slice(0, 10) >= state.promoSince) : all;
  // 区域 / 组别 / 门店 级联导航筛选（作用于下方卡片与两张表）
  const uniqSort = a => [...new Set(a)].sort();
  // 区域口径同新加盟商培训板块：只认组织链路里的「XX区域」，总部部门（招商部/工程/营销组等）不作为区域
  const promoRegionOf = e => {
    const segs = orgParts(e).filter(s => s.endsWith("区域"));
    return segs.length ? segs[segs.length - 1] : null;
  };
  const fRegion = all0.filter(e => state.pRegion === "全部" || promoRegionOf(e) === state.pRegion);
  const fGroup = fRegion.filter(e => state.pGroup === "全部" || groupOf(e) === state.pGroup);
  const emps = fGroup.filter(e => state.pStore === "全部" || storeOf(e) === state.pStore);
  const navSel = (label, opts, cur, fn) => `<span style="font-size:13px;color:var(--t2)">${label}</span>
    <select onchange="${fn}(this.value)" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;max-width:200px">
      ${opts.map(o => `<option value="${esc(o)}" ${cur === o ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select>`;
  const navBar = `<div class="planbar">
    ${navSel("区域", ["全部", ...uniqSort(all0.map(promoRegionOf).filter(Boolean))], state.pRegion, "setPRegion")}
    ${navSel("组别", ["全部", ...uniqSort(fRegion.map(groupOf))], state.pGroup, "setPGroup")}
    ${navSel("门店", ["全部", ...uniqSort(fGroup.map(storeOf))], state.pStore, "setPStore")}
    ${(state.pRegion !== "全部" || state.pGroup !== "全部" || state.pStore !== "全部") ? `<button class="btn" style="padding:6px 12px;font-size:12px;background:var(--navy)" onclick="setPRegion('全部');setPGroup('全部');setPStore('全部')">清空筛选</button>` : ""}
  </div>`;
  const num = e => parseFloat(e.completionSchedule) || 0;
  const doneN = emps.filter(e => num(e) >= 100).length;
  const avgP = emps.length ? emps.reduce((a, e) => a + num(e), 0) / emps.length : 0;
  // 岗位汇总
  const byPos = {};
  emps.forEach(e => {
    const k = e.positionName || "未定岗";
    (byPos[k] = byPos[k] || { n: 0, sum: 0, done: 0 });
    byPos[k].n++; byPos[k].sum += num(e); if (num(e) >= 100) byPos[k].done++;
  });
  const posRows = Object.entries(byPos).sort((a, b) => b[1].n - a[1].n).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${v.done}</td><td>${barHtml(v.sum / v.n)}</td></tr>`).join("")
    || `<tr><td colspan=4 class=empty>无符合筛选条件的人员</td></tr>`;
  // 员工明细
  const empRows = emps.slice().sort((a, b) => num(b) - num(a)).map(e => {
    const p = num(e);
    const st = p >= 100 ? ["已完成", "b-green"] : p > 0 ? ["进行中", "b-orange"] : ["未开始", "b-gray"];
    return `<tr><td>${esc(e.employeeName)}</td><td>${esc(e.positionName || "")}</td><td>${esc(e.storeName || "")}</td>
      <td style="color:var(--t2)">${esc(e.stageName || "")}</td>
      <td>${barHtml(p)}</td><td><span class="badge ${st[1]}">${st[0]}</span></td>
      <td style="color:var(--t2);font-size:12px">${(e.issueDate || "").slice(0, 10)}</td></tr>`;
  }).join("") || `<tr><td colspan=7 class=empty>无符合筛选条件的人员</td></tr>`;
  el.innerHTML = `
    <div class="planbar">
      <select onchange="state.promoMapIdx=+this.value;renderPromo()">${maps.map((m, i) => `<option value="${i}" ${i === state.promoMapIdx ? "selected" : ""}>${esc(m.mapName)}（${m.empCount}人）</option>`).join("")}</select>
      <span style="font-size:13px;color:var(--t2)">注册日期≥</span>
      <button class="btn" style="padding:6px 12px;font-size:12px;background:${state.promoSince === monthStart(0) ? "#186BEB" : "var(--navy)"}" onclick="state.promoSince=monthStart(0);renderPromo()">当月</button>
      <button class="btn" style="padding:6px 12px;font-size:12px;background:${state.promoSince === monthStart(-1) ? "#186BEB" : "var(--navy)"}" onclick="state.promoSince=monthStart(-1);renderPromo()">上月</button>
      <input type="date" value="${state.promoSince}" onchange="state.promoSince=this.value;renderPromo()" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px">
      ${state.promoSince ? `<button class="btn" style="padding:6px 12px;font-size:12px;background:var(--navy)" onclick="state.promoSince='';renderPromo()">看全部</button>` : ""}
    </div>
    ${navBar}
    <div class="cards">
      <div class="card"><div class="k">注册人数（${state.promoSince ? state.promoSince + " 起" : "全部"}）</div><div class="v">${emps.length}</div></div>
      <div class="card"><div class="k">已完成</div><div class="v">${doneN}</div></div>
      <div class="card"><div class="k">平均进度</div><div class="v">${avgP.toFixed(1)}<small>%</small></div></div>
      <div class="card"><div class="k">地图总人数</div><div class="v">${mp.empCount}</div></div>
    </div>
    <div class="sec"><h3>岗位应学汇总</h3>
      <div style="font-size:12px;color:var(--t2);margin-bottom:6px">按职位统计注册人员的应学完成情况（该职位对应此学习地图）</div>
      <table><tr><th>岗位</th><th>人数</th><th>已完成</th><th>平均进度</th></tr>${posRows}</table>
    </div>
    <div class="sec"><h3>学员学习进度</h3>
      <table><tr><th>姓名</th><th>岗位</th><th>门店</th><th>当前阶段</th><th>进度</th><th>状态</th><th>注册日期</th></tr>${empRows}</table>
    </div>`;
}

/* ---------- 评价管理（讲师评价 / 课程满意度调研） ---------- */
function evalTabsHtml() {
  return `<div class="subtabs" style="margin-bottom:16px">
    <button class="${state.evalSub === "新加盟商培训讲师评价" ? "active" : ""}" onclick="state.evalSub='新加盟商培训讲师评价';render()">新加盟商培训讲师评价</button>
    <button class="${state.evalSub === "课程满意度调研" ? "active" : ""}" onclick="state.evalSub='课程满意度调研';render()">课程满意度调研</button>
  </div>`;
}
function renderEval() {
  document.getElementById("main").innerHTML = evalTabsHtml() + `<div id="evalBody"></div>`;
  if (state.evalSub === "课程满意度调研") renderSurvey(); else renderLectureEval();
}

/* 生成链接 + 二维码（课程名称 + 链接 + 复制文本带字样） */
function qrHtml(text) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return `<div style="background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;display:inline-block;text-align:center">
      ${qr.createSvgTag({ cellSize: 3, margin: 2 })}
      <div style="font-size:12px;color:var(--t1);font-weight:600;margin-top:6px;max-width:180px;word-break:break-all">${esc(qrLabel)}</div>
    </div>`;
  } catch (e) { return `<span class="badge b-red">二维码生成失败：${esc(e)}</span>`; }
}
let qrLabel = "";
function baseOrigin() {
  // 本地预览用 localhost，线上用当前站点根
  return location.origin + location.pathname.replace(/[^/]*$/, "");
}
function buildFormLink(params) {
  return baseOrigin() + "eval_form.html?" + params;
}
function genLink(kind) { // kind: "lecture"（老师评价门店，需选门店） | "survey"（门店填，无需选门店）
  const c = document.getElementById("genCourse").value;
  const out = document.getElementById("genOut");
  if (!c) { out.textContent = "请先选择课程"; return; }
  const isSurvey = kind === "survey";
  let s = "";
  if (!isSurvey) {
    s = document.getElementById("genStore").value.trim();
    if (!s) { out.textContent = "请先选择门店"; return; }
  }
  const label = isSurvey ? (c + " · 满意度调查") : (c + " · 讲师评价");
  const link = buildFormLink((isSurvey ? "type=sat&" : "type=lecture&") + (s ? "store=" + encodeURIComponent(s) + "&" : "") + "course=" + encodeURIComponent(c));
  const copyText = `【${label}】\n${s ? "评价门店：" + s + "\n" : ""}填写链接：${link}\n（手机打开即可填写，提交）`;
  qrLabel = label;
  lastLink = link;
  out.innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;margin-top:6px">
      <div style="flex:1;min-width:260px">
        <div style="font-size:13px;margin-bottom:6px"><b>${esc(label)}</b></div>
        <div style="font-size:12px;color:var(--t2);word-break:break-all;margin-bottom:8px">门店链接：<a href="${link}" target="_blank" style="color:#186BEB">${link}</a></div>
        <button class="btn" style="padding:6px 14px;font-size:13px" onclick="copyText()">复制链接及名称</button>
      </div>
      ${qrHtml(link)}
    </div>`;
  lastCopyText = copyText;
}
let lastLink = "", lastCopyText = "";
function copyText() {
  navigator.clipboard.writeText(lastCopyText).then(() => {
    const btn = event && event.target;
    if (btn) { const t = btn.textContent; btn.textContent = "已复制"; setTimeout(() => btn.textContent = t, 1500); }
  });
}
function storesOfPlanName(planName) {
  const p = (DATA.plans || []).find(x => x.planName === planName);
  if (!p) return [];
  let stores = [...new Set((p.storeStats || []).map(s => s.storeName).filter(Boolean))];
  if (!stores.length) stores = [...new Set((p.emps || []).map(e => (e.storeNames || "").trim()).filter(Boolean))]; // 直播课无门店统计时从学员列表兜底
  return stores.sort((a, b) => a.localeCompare(b, "zh"));
}
function syncStores() { // 讲师评价链接：门店下拉自动关联该课程参训门店
  const sel = document.getElementById("genStore");
  if (!sel) return;
  const stores = storesOfPlanName(document.getElementById("genCourse").value);
  sel.innerHTML = stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("") || `<option value="">（该课程暂无门店数据）</option>`;
}
function linkGenHtml(kind, plans) {
  const opts = plans.map((p, i) => `<option value="${esc(p.planName)}">${esc(p.planName)}（${p.startDate || "?"}）</option>`).join("");
  const storeSel = kind === "survey" ? "" :
    `<select id="genStore" onchange="" style="flex:1;min-width:160px;padding:9px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:13px;background:#fff"></select>`;
  return `<div class="sec">
    <h3>${kind === "survey" ? "满意度调查链接生成（课程嫁接）" : "讲师评价链接生成（课程嫁接）"}</h3>
    <div style="font-size:12px;color:var(--t2);margin-bottom:8px">${kind === "survey" ? "课程取自「线上线下培训」板块计划，门店由填写人打开链接后自行填写" : "课程取自「新加盟商培训」板块计划，门店自动关联参训门店；链接发给<strong>授课老师</strong>，由老师评价对应门店，理论/技术/实操由老师勾选后填写"}；链接与二维码均带课程名称+${kind === "survey" ? "满意度调查" : "讲师评价"}字样</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <select id="genCourse" ${kind === "survey" ? "" : `onchange="syncStores()"`} style="flex:2;min-width:240px;padding:9px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:13px;background:#fff">${opts}</select>
      ${storeSel}
      <button class="btn" onclick="genLink('${kind}')">生成链接+二维码</button>
    </div>
    <div id="genOut" style="font-size:13px;color:var(--t2);word-break:break-all"></div>
  </div>`;
}

/* 目录一：新加盟商培训讲师评价 */
function renderLectureEval() {
  const allEvals = DATA.evaluations || [];
  const evals = allEvals.filter(v => dateInrange(new Date(v.time).toISOString().slice(0, 10)));
  const byStore = {};
  evals.forEach(v => { (byStore[v.store] = byStore[v.store] || []).push(v); });
  const stores = Object.keys(byStore);
  const modBadge = (label, txt) => txt ? `<div class="mod-line"><span class="badge b-blue">${label}</span><span class="mod-txt">${esc(txt)}</span></div>` : "";
  const rows = stores.map(s => {
    const list = byStore[s];
    return `<tr><td style="vertical-align:top"><b>${esc(s)}</b></td><td>${list.map(v => `
      <div class="eval-card">
        <div style="font-size:12px;color:var(--t2);margin-bottom:6px">${new Date(v.time).toLocaleString("zh-CN")} · 授课老师：${esc(v.by) || "-"}${v.course ? ` · 课程：${esc(v.course)}` : ""}</div>
        ${modBadge("理论", v.th)}${modBadge("技术", v.tech)}${modBadge("实操", v.prac) || (!v.th && !v.tech && !v.prac ? '<i style="color:var(--t2);font-size:12px">（无文字评价）</i>' : "")}
      </div>`).join("")}</td></tr>`;
  }).join("") || `<tr><td class="empty" colspan="2">暂无授课老师提交评价</td></tr>`;
  const lecturePlans = plansOf("新加盟商培训");
  document.getElementById("evalBody").innerHTML = `
    <div class="sec">
      <h3>讲师评价（新加盟商培训 · 授课老师评门店）</h3>
      <div class="cards">
        <div class="card"><div class="k">已收评价门店</div><div class="v">${stores.length}</div></div>
        <div class="card"><div class="k">评价总数</div><div class="v">${evals.length}</div></div>
        <div class="card"><div class="k">理论评语</div><div class="v">${evals.filter(v => v.th).length}</div></div>
        <div class="card"><div class="k">技术评语</div><div class="v">${evals.filter(v => v.tech).length}</div></div>
        <div class="card"><div class="k">实操评语</div><div class="v">${evals.filter(v => v.prac).length}</div></div>
      </div>
      <div class="note" style="font-size:12px;color:var(--t2)">评价由授课老师通过 H5 链接提交（按门店自动整合），跑一次 fetch_study.py 后在此更新；右上角区间筛选同时生效。</div>
    </div>
    ${linkGenHtml("lecture", lecturePlans)}
    <div class="sec">
      <h3>各门店评价内容</h3>
      <table><tr><th style="width:180px">门店</th><th>评价内容</th></tr>${rows}</table>
    </div>`;
  syncStores();
}

/* 目录二：课程满意度调研（慧运营问卷 + 自建课题调研 + H5满意度提交） */
const SCORE_NUM = { "非常满意（5分）": 5, "满意（4分）": 4, "良好（3分）": 3, "一般（2分）": 2, "不满意（1分）": 1, "很满意": 5, "满意": 4, "一般": 3, "不满意": 2 };
function lessonNum(s) { // 提取"第X节/讲"的序号（支持中文数字），用于问卷计划与H5提交课程匹配
  const CN = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
  const m = (s || "").match(/第([一二三四五六七八九十\d]+)[节讲]/);
  if (!m) return null;
  const t = m[1];
  if (/^\d+$/.test(t)) return String(+t);
  if (t === "十") return "10";
  const a = CN[t[0]], b = CN[t[t.length - 1]];
  return String(t.includes("十") ? (a || 1) * 10 + (b || 0) : a);
}
function surveySubs(planName) { // 与该问卷同场次课程的 H5 满意度提交
  const n = lessonNum(planName);
  return (DATA.courseSurveys || []).filter(v => n && lessonNum(v.course) === n);
}
function avgScore(subs) { // 满意度平均分（5分制，按"是否满意"选项）
  const s = subs.filter(v => SCORE_NUM[v.score]);
  if (!s.length) return null;
  return s.reduce((a, v) => a + SCORE_NUM[v.score], 0) / s.length;
}
function surveyAvgScore(planName) { return avgScore(surveySubs(planName)); }
/* 自建课题调研（存 localStorage，仅看板端管理） */
function customSurveysOf() { try { return JSON.parse(localStorage.getItem("customSurveys") || "[]"); } catch (e) { return []; } }
function saveCustomSurveys(list) { localStorage.setItem("customSurveys", JSON.stringify(list)); }
function addCustomSurvey() {
  const name = (document.getElementById("csName").value || "").trim();
  const date = document.getElementById("csDate").value || new Date().toISOString().slice(0, 10);
  if (!name) { document.getElementById("csTip").textContent = "请先填写调研名称"; return; }
  const list = customSurveysOf();
  if (list.some(c => c.name === name)) { document.getElementById("csTip").textContent = "该调研已存在"; return; }
  list.push({ name, date });
  saveCustomSurveys(list);
  document.getElementById("csTip").textContent = "";
  render();
}
function delCustomSurvey(i) {
  const list = customSurveysOf();
  if (!confirm("删除自建调研「" + list[i].name + "」？（不影响已提交的问卷数据）")) return;
  list.splice(i, 1);
  saveCustomSurveys(list);
  render();
}
function subsForTopic(name) { // 自建调研的提交：先按课程名精确匹配，再按场次序号兜底
  const exact = (DATA.courseSurveys || []).filter(v => v.course === name);
  if (exact.length) return exact;
  const n = lessonNum(name);
  return (DATA.courseSurveys || []).filter(v => n && lessonNum(v.course) === n);
}
function adviceTable(subs) { // 建议明细：姓名/门店/区域/课程节奏/课程内容/讲解清晰度/是否满意/建议/课程建议
  const rows = subs.map(v => `<tr>
    <td>${esc(v.by) || "-"}</td><td>${esc(v.store)}</td><td>${esc(v.region) || "-"}</td>
    <td>${esc(v.rhythm) || "-"}</td><td>${esc(v.content) || "-"}</td><td>${esc(v.clarity) || "-"}</td>
    <td><span class="badge ${(v.score || "").startsWith("非常满意") || v.score === "很满意" ? "b-green" : (v.score || "").startsWith("不满意") ? "b-red" : "b-blue"}">${esc(v.score) || "-"}</span></td>
    <td style="white-space:normal">${esc(v.comment) || "-"}</td>
    <td style="white-space:normal">${esc(v.next) || "-"}</td></tr>`).join("");
  return `<table><tr><th>姓名</th><th>门店</th><th>区域</th><th>课程节奏</th><th>课程内容</th><th>讲解清晰度</th><th>是否满意</th><th>建议</th><th>课程建议</th></tr>${rows}</table>`;
}
function renderSurvey() {
  const surveys = surveysInRange();
  const survRows = surveys.map((p, i) => {
    const emps = (p.emps || []).filter(e => statusOf(e) != null);
    const done = emps.filter(e => (empStat(p, e) || {}).status === 2 || e.trainingStatus === 2).length;
    const avg = surveyAvgScore(p.planName);
    const subs = surveySubs(p.planName);
    return `<tr class="clickable" onclick="openSurvey(${i})">
      <td>${esc(p.planName)}</td><td>${p.startDate || "-"}</td><td>${done}</td>
      <td>${avg != null ? `<span class="badge b-green">${avg.toFixed(1)} 分</span><span style="color:var(--t2);font-size:12px">（${subs.length}份）</span>` : `<span style="color:var(--t2)">—</span>`}</td>
      <td onclick="event.stopPropagation()">${subs.length ? `<button class="btn" style="padding:5px 12px;font-size:12px" onclick="openAdvice(${i})">查看建议${subs.filter(v => (v.comment || "").trim() || (v.next || "").trim()).length ? `（${subs.filter(v => (v.comment || "").trim() || (v.next || "").trim()).length}）` : ""}</button>` : `<span style="color:var(--t2);font-size:12px">暂无</span>`}</td></tr>`;
  }).join("");
  const customs = customSurveysOf().filter(c => dateInrange(c.date));
  const customRows = customs.map((c, i) => {
    const subs = subsForTopic(c.name).filter(v => dateInrange(new Date(v.time).toISOString().slice(0, 10)));
    const avg = avgScore(subs);
    return `<tr>
      <td><b>${esc(c.name)}</b><span class="badge b-blue" style="margin-left:6px">自建</span></td><td>${c.date || "-"}</td><td>${subs.length}</td>
      <td>${avg != null ? `<span class="badge b-green">${avg.toFixed(1)} 分</span><span style="color:var(--t2);font-size:12px">（${subs.length}份）</span>` : `<span style="color:var(--t2)">—</span>`}</td>
      <td>${subs.length ? `<button class="btn" style="padding:5px 12px;font-size:12px" onclick="openAdviceC(${i})">查看建议${subs.filter(v => (v.comment || "").trim() || (v.next || "").trim()).length ? `（${subs.filter(v => (v.comment || "").trim() || (v.next || "").trim()).length}）` : ""}</button>` : `<span style="color:var(--t2);font-size:12px">暂无</span>`}
        <button class="btn" style="padding:5px 10px;font-size:12px;background:var(--line)" onclick="delCustomSurvey(${i})">删</button></td></tr>`;
  }).join("");

  const onlinePlans = plansOf("线上线下培训");
  document.getElementById("evalBody").innerHTML = `
    <div class="sec">
      <h3>课程满意度 · 调研列表</h3>
      <div style="font-size:12px;color:var(--t2);margin-bottom:6px">含慧运营调查问卷（已从培训统计中移入本板块，点击行查看答题明细）与自建课题调研；评分取「是否满意」平均分（非常满意5分～不满意1分），括号内为收到份数</div>
      <table><tr><th>问卷名称</th><th>日期</th><th>已提交</th><th>评分</th><th>查看建议</th></tr>${survRows}${customRows}</table>
    </div>
    <div class="sec">
      <h3>新增课题调研（自建）</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:4px">
        <input id="csName" placeholder="调研名称（建议含课程/期数，如：第X节直播课满意度调研）" style="flex:2;min-width:240px;padding:9px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:13px;background:#fff" />
        <input id="csDate" type="date" style="padding:9px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:13px;background:#fff" />
        <button class="btn" onclick="addCustomSurvey()">添加调研</button>
      </div>
      <div id="csTip" style="font-size:12px;color:#D9363E"></div>
      <div style="font-size:12px;color:var(--t2)">添加后自动汇总该名称课程（或同场次序号课程）的 H5 满意度提交，生成链接可到下方「满意度调查链接生成」处生成后发给伙伴填写</div>
    </div>
    ${linkGenHtml("survey", onlinePlans)}`;
  syncStores();
}
function surveysInRange() { return surveysOf().filter(p => dateInrange(p.startDate)); }
let surveyFilter = "全部";
function openSurvey(idx, keepFilter) {
  const p = surveysInRange()[idx];
  if (!keepFilter) surveyFilter = "全部";
  document.getElementById("mTitle").textContent = p.planName + " · 答题明细";
  let emps = (p.emps || []).filter(e => statusOf(e) != null).map(e => {
    const stat = empStat(p, e);
    const ok = (stat && stat.status === 2) || e.trainingStatus === 2;
    return { e, stat, ok };
  });
  if (surveyFilter !== "全部") emps = emps.filter(x => surveyFilter === "已完成" ? x.ok : !x.ok);
  const doneAll = (p.emps || []).filter(e => statusOf(e) != null && ((empStat(p, e) || {}).status === 2 || e.trainingStatus === 2)).length;
  const rows = emps.map(({ e, stat, ok }) => `<tr><td>${esc(e.empName)}</td><td>${esc(storeOf(e))}</td>
      <td><span class="badge ${ok ? "b-green" : "b-orange"}">${ok ? "已完成" : "未完成"}</span>${stat ? `<span style="color:var(--t2);font-size:12px"> ${stat.done}/${stat.total}</span>` : ""}</td></tr>`).join("");
  document.getElementById("mBody").innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:10px">
      ${["全部", "已完成", "未完成"].map(f => `<button class="btn" style="padding:5px 14px;font-size:12px;${surveyFilter === f ? "" : "background:var(--line);color:var(--t1)"}" onclick="surveyFilter='${f}';openSurvey(${idx},true)">${f}</button>`).join("")}
      <span style="margin-left:auto;font-size:12px;color:var(--t2);align-self:center">共 ${(p.emps || []).filter(e => statusOf(e) != null).length} 人 · 已完成 ${doneAll} 人</span>
    </div>
    ${rows ? `<table><tr><th>姓名</th><th>门店</th><th>答题状态</th></tr>${rows}</table>` : `<div class="empty">该筛选条件下无人员</div>`}`;
  document.getElementById("mask").classList.add("show");
}
function openAdvice(idx) {
  const p = surveysInRange()[idx];
  const subs = surveySubs(p.planName);
  document.getElementById("mTitle").textContent = p.planName + " · 建议明细（" + subs.length + "份）";
  document.getElementById("mBody").innerHTML = subs.length ? adviceTable(subs) : `<div class="empty">该问卷对应课程暂无提交</div>`;
  document.getElementById("mask").classList.add("show");
}
function openAdviceC(idx) {
  const c = customSurveysOf().filter(x => dateInrange(x.date))[idx];
  if (!c) return;
  const subs = subsForTopic(c.name).filter(v => dateInrange(new Date(v.time).toISOString().slice(0, 10)));
  document.getElementById("mTitle").textContent = c.name + " · 建议明细（" + subs.length + "份）";
  document.getElementById("mBody").innerHTML = subs.length ? adviceTable(subs) : `<div class="empty">该调研暂无提交</div>`;
  document.getElementById("mask").classList.add("show");
}

/* ---------- 离职管理档案（离职员工不参与任何统计） ---------- */
function resignedLearnMap() { // employeeId -> [{name, done, total, pct, kind}]
  const m = {};
  const add = (id, name, done, total, kind) => {
    if (done == null || total == null || !total) return;
    (m[id] = m[id] || []).push({ name, done, total, pct: Math.round(done / total * 1000) / 10, kind });
  };
  (DATA.plans || []).forEach(p => (p.emps || []).forEach(e => {
    const d = (p.empDetails || {})[String(e.employeeId)];
    add(e.employeeId, p.planName, d && d.done, d && d.total, "计划");
  }));
  (DATA.maps || []).forEach(mp => (mp.emps || []).forEach(e =>
    add(e.employeeId, mp.mapName, Number(e.completionSchedule), 100, "地图")));
  return m;
}
function renderResign() {
  const roster = DATA.resigned || [];
  // 兼容旧数据：花名册缺失时回退从计划/地图学员行提取离职员工
  if (!roster.length) {
    const seen = {};
    (DATA.plans || []).forEach(p => (p.emps || []).forEach(e => { if (e.empStatus && e.empStatus !== "zc") seen[e.employeeId] = { employeeName: e.empName, employeeCode: e.empCode, positionName: e.positionName, store: storeOf(e), region: regionOf(e), departureDate: "" }; }));
    (DATA.maps || []).forEach(mp => (mp.emps || []).forEach(e => { if (e.empStatus && e.empStatus !== "zc" && !seen[e.employeeId]) seen[e.employeeId] = { employeeName: e.employeeName, employeeCode: e.employeeCode, positionName: e.positionName, store: e.storeName, region: e.organizeName, departureDate: "" }; }));
    roster.push(...Object.entries(seen).map(([id, v]) => ({ employeeId: id, ...v })));
  }
  const learn = resignedLearnMap();
  // 学习项下拉（全部 / 各计划 / 各地图）
  const items = [];
  (DATA.plans || []).forEach(p => { if ((p.emps || []).length) items.push(p.planName); });
  (DATA.maps || []).forEach(mp => items.push("【地图】" + mp.mapName));
  const sel = state.resignItem || "全部";
  const rows = roster.map(r => {
    const ls = learn[r.employeeId] || [];
    const shown = sel === "全部" ? ls : ls.filter(l => sel === "【地图】" + l.name || l.name === sel);
    const learnHtml = shown.length
      ? shown.map(l => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
          <span style="font-size:12px;color:var(--t2);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${esc(l.name)}">${esc(l.name)}</span>
          ${barHtml(l.pct)}<span style="font-size:12px;color:var(--t2)">${l.done}/${l.total}</span></div>`).join("")
      : `<span style="color:var(--t2);font-size:12px">—</span>`;
    return `<tr>
      <td>${esc(r.store) || "-"}</td><td><b>${esc(r.employeeName)}</b></td><td>${esc(r.positionName) || "-"}</td>
      <td style="color:var(--t2);font-size:12px">${esc(r.region) || "-"}</td>
      <td style="white-space:normal;min-width:240px">${learnHtml}</td>
      <td>${r.departureDate || "-"}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty">当前数据中无离职员工</td></tr>`;
  document.getElementById("main").innerHTML = `
    <div class="sec">
      <h3>离职管理档案</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <span style="font-size:13px;color:var(--t2)">学习项筛选</span>
        <select onchange="state.resignItem=this.value;renderResign()" style="padding:8px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:13px;background:#fff;max-width:420px">
          <option value="全部"${sel === "全部" ? " selected" : ""}>全部学习项</option>
          ${items.map(n => `<option value="${esc(n)}"${sel === n ? " selected" : ""}>${esc(n)}</option>`).join("")}
        </select>
        <span style="font-size:12px;color:var(--t2)">离职员工（${roster.length} 人）单独归档，不参与看板任何统计口径</span>
      </div>
      <table><tr><th>门店</th><th>姓名</th><th>职位</th><th>所属区域</th><th>各项学习汇总</th><th>离职日期</th></tr>${rows}</table>
    </div>`;
}

/* ---------- 公开课 ---------- */
function renderOpen() {
  document.getElementById("main").innerHTML = `<div class="sec"><h3>公开课学习（自由学习课程集合）</h3><div class="empty">公开课为首页导航自由学习，不强制统计；后续可接入课程库与学时排行（staffCourseHoursRanking）</div></div>`;
}

/* ---------- 主渲染 ---------- */
function render() {
  // 隐藏平台上还没有数据的分类（学员/门店全空，如"裂变加盟商培训"配置好后会自动出现）
  const visibleCats = DATA.categories.filter(c => {
    const ps = (DATA.plans || []).filter(p => p.category === c);
    return ps.some(p => (p.emps || []).length > 0 || (p.storeStats || []).length > 0);
  });
  const tabs = [["概述", ""], ...visibleCats.map(c => [c, ""]), ["评价管理", ""], ["离职管理档案", ""]];
  document.getElementById("mainTabs").innerHTML = tabs.map(([t]) => {
    const n = t === "概述" || t === "评价管理" || t === "离职管理档案" ? "" : `<span class="n">${plansInRange(t).length}</span>`;
    return `<button class="${state.tab === t ? "active" : ""}" onclick="state.tab='${t}';state.planIdx=0;render()">${t}${n}</button>`;
  }).join("");
  if (!tabs.some(([t]) => t === state.tab)) { state.tab = "概述"; state.planIdx = 0; }
  if (state.tab === "概述") renderOverview();
  else if (state.tab === "评价管理") renderEval();
  else if (state.tab === "离职管理档案") renderResign();
  else if (state.tab === "公开课学习") renderOpen();
  else if (state.tab === "员工培训/晋升") renderPromo();
  else { state.cat = state.tab; renderCat(); }
  // 学习地图/培训计划 二级切换（仅员工培训/晋升）
  const bar = document.getElementById("promoBar");
  if (state.tab === "员工培训/晋升") {
    bar.style.display = "flex";
    bar.innerHTML = `<button class="${state.promoSub === "学习地图" ? "active" : ""}" onclick="state.promoSub='学习地图';state.promoMapIdx=0;render()">学习地图（晋升阶梯）</button>
      <button class="${state.promoSub === "培训计划" ? "active" : ""}" onclick="state.promoSub='培训计划';render()">晋升培训计划</button>`;
  } else bar.style.display = "none";
}

fetch("data/data.json?v=" + Date.now()).then(r => r.json()).then(d => {
  DATA = d;
  document.getElementById("genTime").textContent = "数据更新于 " + d.generatedAt;
  render();
}).catch(e => {
  document.getElementById("main").innerHTML = `<div class="sec empty">数据加载失败：${esc(e)}<br>请先运行 fetch_study.py，并用「启动看板.bat」打开</div>`;
});
