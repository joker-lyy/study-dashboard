/* 学习看板 app.js v3
数据源 data/data.json（fetch_study.py 生成）
一级菜单：概述 / 新加盟商培训 / 裂变加盟商培训 / 线上线下培训 / 员工培训/晋升 / 公开课学习 / 讲师评估
二级菜单：区域汇总 / 组别汇总 / 门店分数排名及明细
任务状态：W=已完成 S=未完成；taskType 3=课程 4=考试 5=作业 7=表单 8=实操
*/
let DATA = null;
let state = { tab: "概述", cat: null, planIdx: 0, sub: "区域汇总", empFilter: "全部", stageKey: null, range: "全部", rFrom: null, rTo: null,
  promoSub: "学习地图", promoMapIdx: 0, promoSince: "2026-09-01" };
const PLAN_EXCLUDE = ["测试", "XX", "xx", "课前准备", "174期"];
const TYPE_NAME = { 3: "学习", 4: "考试", 5: "作业", 7: "表单", 8: "实操" };

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
function esc(s) { return (s == null ? "" : String(s)).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])); }

// 把学员的区域链路 "总经办/加盟服务部/新店运营组/刘浩区域" 拆出层级
function orgParts(emp) {
  const s = emp.organizeNames || emp.storeNames || "";
  return s.split("/").map(x => x.trim()).filter(Boolean);
}
function regionOf(emp) { const p = orgParts(emp); return p[p.length - 1] || "未分配"; }
function groupOf(emp) { const p = orgParts(emp); return p.length >= 2 ? p[p.length - 2] : "未分配"; }
function storeOf(emp) { return emp.storeNames || "无门店"; }

function statusOf(emp) {
  if (emp.empStatus && emp.empStatus !== "zc") return null; // 不在职不显示
  return emp.trainingStatus;
}

// 计划内按 key 聚合学员
function aggregate(plan, keyFn) {
  const map = {};
  (plan.emps || []).forEach(e => {
    const st = statusOf(e);
    if (st == null) return;
    const k = keyFn(e);
    if (!map[k]) map[k] = { name: k, total: 0, done: 0, doing: 0, todo: 0 };
    map[k].total++;
    if (st === 2) map[k].done++;
    else if (st === 1) map[k].doing++;
    else map[k].todo++;
  });
  const arr = Object.values(map);
  arr.forEach(a => a.rate = a.total ? a.done / a.total * 100 : 0);
  arr.sort((a, b) => b.rate - a.rate || b.total - a.total);
  return arr;
}

function plansOf(cat) {
  return DATA.plans.filter(p => p.category === cat && !PLAN_EXCLUDE.some(k => (p.planName || "").includes(k)));
}

/* ---------- 右上角区间筛选（按计划开始日期 / 评估提交时间） ---------- */
function monthRange(offset) { // offset 0=本月, -1=上月
  const n = new Date();
  const y = n.getFullYear(), m = n.getMonth() + offset;
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 0);
  const f = d => d.toISOString().slice(0, 10);
  return [f(from), f(to)];
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
function plansInRange(cat) { return plansOf(cat).filter(p => dateInrange(p.startDate)); }
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
  const plans = plansInRange(state.cat);
  if (!plans.length) { el.innerHTML = `<div class="sec empty">该分类暂无计划数据</div>`; return; }
  state.planIdx = Math.min(state.planIdx, plans.length - 1);
  const p = plans[state.planIdx];

  const opts = plans.map((x, i) => `<option value="${i}" ${i === state.planIdx ? "selected" : ""}>${esc(x.planName)}（${x.startDate || "?"}）</option>`).join("");
  const ov = p.overview || {};

  // 概述卡片
  const cards = `
    <div class="cards">
      <div class="card"><div class="k">应学人数</div><div class="v">${ov.numberOfPersonsDueToComplete ?? (p.emps || []).length}</div></div>
      <div class="card"><div class="k">已完成</div><div class="v">${ov.numberOfPeopleCompleted ?? "-"}</div></div>
      <div class="card"><div class="k">完成率</div><div class="v">${pct(ov.percentageComplete).toFixed(1) || 0}<small>%</small></div></div>
      <div class="card"><div class="k">应学门店</div><div class="v">${ov.shouldTrainStoreCount ?? (p.storeStats || []).length}</div></div>
      <div class="card"><div class="k">已参训门店</div><div class="v">${ov.trainedStoreCount ?? "-"}</div></div>
      <div class="card"><div class="k">有效期</div><div class="v" style="font-size:15px;line-height:2.2">${esc(ov.periodOfValidity || (p.startDate + " ~ " + p.endDate))}</div></div>
    </div>`;

  // 阶段统计（行可点 -> 阶段学员明细）
  const stageRows = (p.stageStats || []).map((s, i) => {
    const key = s.phaseName;
    return `<tr class="clickable" onclick="openStage('${esc(key).replace(/'/g, "")}')"><td>${esc(s.phaseName)}</td><td>${s.numberOfPersonsDueToComplete}</td><td>${s.uninitiatedNumber}</td><td>${s.numberOfPeopleInProgress}</td><td>${s.numberOfPeopleCompleted}</td><td>${barHtml(pct(s.phaseCompletionRate))}</td></tr>`;
  }).join("");

  // 二级
  let body = "";
  if (state.sub === "区域汇总") body = aggTable(aggregate(p, regionOf), "区域");
  else if (state.sub === "组别汇总") body = aggTable(aggregate(p, groupOf), "组别");
  else body = storeRankTable(p);

  el.innerHTML = `
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
        ${["区域汇总", "组别汇总", "门店分数排名及明细"].map(s => `<button class="${state.sub === s ? "active" : ""}" onclick="state.sub='${s}';renderCat()">${s}</button>`).join("")}
      </div>
      ${body}
    </div>`;
}

function aggTable(arr, label) {
  if (!arr.length) return `<div class="empty">暂无学员数据</div>`;
  return `<table><tr><th>${label}</th><th>总人数</th><th>已完成</th><th>进行中</th><th>未开始</th><th>完成率</th></tr>
    ${arr.map(a => `<tr><td>${esc(a.name)}</td><td>${a.total}</td><td>${a.done}</td><td>${a.doing}</td><td>${a.todo}</td><td>${barHtml(a.rate)}</td></tr>`).join("")}</table>`;
}

/* ---------- 门店分数排名 ---------- */
function storeScore(s) {
  // 综合分 = 参训率30% + 整体完成率70%（满分100；后续接入考试成绩再加权）
  const train = pct(s.trainRate), comp = pct(s.completionRate || s.ztwclValue);
  return train * 0.3 + comp * 0.7;
}
function storeRankTable(p) {
  const rows = (p.storeStats || []).map(s => ({ s, score: storeScore(s) })).sort((a, b) => b.score - a.score);
  if (!rows.length) return `<div class="empty">暂无门店数据</div>`;
  return `<table><tr><th>排名</th><th>门店</th><th>编号</th><th>组织链路</th><th>应学</th><th>已完成</th><th>完成率</th><th>综合分</th><th>状态</th></tr>
    ${rows.map((r, i) => `<tr class="clickable" onclick="openStore('${r.s.storeId}')">
      <td>${i + 1}</td><td>${esc(r.s.storeName)}</td><td>${esc(r.s.storeCode || "")}</td>
      <td style="color:var(--t2)">${esc(r.s.organizeLink || "")}</td>
      <td>${r.s.numberOfPersonsDueToComplete ?? "-"}</td><td>${r.s.numberOfPeopleCompleted ?? "-"}</td>
      <td>${barHtml(pct(r.s.completionRate || r.s.ztwclValue))}</td>
      <td><b>${r.score.toFixed(1)}</b></td><td><span class="badge ${r.s.storeStudyStatus === "已参训" ? "b-green" : "b-orange"}">${esc(r.s.storeStudyStatus || "-")}</span></td>
    </tr>`).join("")}</table>
    <div style="margin-top:8px;font-size:12px;color:var(--t2)">综合分 = 参训率×30% + 完成率×70%，点击行查看门店员工学习明细</div>`;
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
  const plans = plansInRange(state.cat);
  const p = plans[state.planIdx];
  document.getElementById("mTitle").textContent = stageName + " · 学员学习明细";
  const rows = (p.emps || []).filter(e => statusOf(e) != null).map(e => {
    const det = p.empDetails && p.empDetails[String(e.employeeId)];
    const stage = det && (det.stages || []).find(s => (s.n || "") === stageName);
    const ts = stage ? stage.t : [];
    const learn = ts.filter(t => t[1] === 3), exams = ts.filter(t => t[1] === 4), ops = ts.filter(t => [5, 7, 8].includes(t[1]));
    const cnt = a => `${a.filter(t => t[2] === "W").length}/${a.length}`;
    const scores = exams.map(t => +t[3]).filter(x => !isNaN(x));
    const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(0) : "-";
    const stat = empStat(p, e);
    return `<tr>
      <td>${esc(e.empName)}</td>
      <td>${cnt(learn)}</td>
      <td>${cnt(exams)}<span style="color:var(--t2);font-size:12px"> 均分${avg}</span></td>
      <td>${cnt(ops)}</td>
      <td>${stat ? `${stat.done}/${stat.total}` : "-"}</td>
      <td>${ts.map(taskBadge).join("") || `<span class="badge b-gray">无任务数据</span>`}</td>
    </tr>`;
  }).join("");
  document.getElementById("mBody").innerHTML = `
    <div style="font-size:12px;color:var(--t2);margin-bottom:8px">说明：计划内任务均为必修（必须完成）；学习=课程内容，考试含分数与通过状态，作业/表单/实操归为实操类。平台未设选修任务。</div>
    ${rows ? `<table><tr><th>姓名</th><th>学习</th><th>考试</th><th>实操</th><th>总进度</th><th>任务明细</th></tr>${rows}</table>` : `<div class="empty">该阶段无在职学员数据</div>`}`;
  document.getElementById("mask").classList.add("show");
}

/* ---------- 门店明细弹窗 ---------- */
let empsCache = [];
function openStore(storeId) {
  const plans = plansInRange(state.cat);
  const p = plans[state.planIdx];
  const st = (p.storeStats || []).find(s => String(s.storeId) === String(storeId));
  empsCache = (p.emps || []).filter(e => storeOf(e) === (st && st.storeName) && statusOf(e) != null);
  state.empFilter = "全部";
  document.getElementById("mTitle").textContent = (st ? st.storeName : "门店") + " · 员工学习明细";
  renderStoreModal();
  document.getElementById("mask").classList.add("show");
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
function renderPromo() {
  const el = document.getElementById("main");
  const maps = DATA.maps || [];
  if (state.promoSub === "培训计划") { state.cat = state.tab; renderCat(); return; }
  if (!maps.length) { el.innerHTML = `<div class="sec empty">暂无学习地图数据，请先运行 fetch_study.py 更新</div>`; return; }
  state.promoMapIdx = Math.min(state.promoMapIdx, maps.length - 1);
  const mp = maps[state.promoMapIdx];
  const all = mp.emps || [];
  // 注册日期筛选（issueDate = 地图发放/注册时间）
  const emps = state.promoSince ? all.filter(e => (e.issueDate || "").slice(0, 10) >= state.promoSince) : all;
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
    || `<tr><td colspan=4 class=empty>该日期后无注册人员</td></tr>`;
  // 员工明细
  const empRows = emps.slice().sort((a, b) => num(b) - num(a)).map(e => {
    const p = num(e);
    const st = p >= 100 ? ["已完成", "b-green"] : p > 0 ? ["进行中", "b-orange"] : ["未开始", "b-gray"];
    return `<tr><td>${esc(e.employeeName)}</td><td>${esc(e.positionName || "")}</td><td>${esc(e.storeName || "")}</td>
      <td style="color:var(--t2)">${esc(e.stageName || "")}</td>
      <td>${barHtml(p)}</td><td><span class="badge ${st[1]}">${st[0]}</span></td>
      <td style="color:var(--t2);font-size:12px">${(e.issueDate || "").slice(0, 10)}</td></tr>`;
  }).join("") || `<tr><td colspan=7 class=empty>该日期后无注册人员</td></tr>`;
  el.innerHTML = `
    <div class="planbar">
      <select onchange="state.promoMapIdx=+this.value;renderPromo()">${maps.map((m, i) => `<option value="${i}" ${i === state.promoMapIdx ? "selected" : ""}>${esc(m.mapName)}（${m.empCount}人）</option>`).join("")}</select>
      <span style="font-size:13px;color:var(--t2)">注册日期≥</span>
      <input type="date" value="${state.promoSince}" onchange="state.promoSince=this.value;renderPromo()" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px">
      ${state.promoSince ? `<button class="btn" style="padding:6px 12px;font-size:12px;background:var(--navy)" onclick="state.promoSince='';renderPromo()">看全部</button>` : ""}
    </div>
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

/* ---------- 讲师评估 ---------- */
function renderEval() {
  const el = document.getElementById("main");
  const allEvals = DATA.evaluations || [];
  const evals = allEvals.filter(v => dateInrange(new Date(v.time).toISOString().slice(0,10)));
  const genMatch = location.search.match(/[?&]gen=([^&]+)/);
  const genStore = genMatch ? decodeURIComponent(genMatch[1]) : "";
  const byStore = {};
  evals.forEach(v => { (byStore[v.store] = byStore[v.store] || []).push(v); });
  const stores = Object.keys(byStore);
  const modBadge = (label, txt) => `<div class="mod-line"><span class="badge b-blue">${label}</span><span class="mod-txt">${esc(txt) || '<i style="color:var(--t2)">（空）</i>'}</span></div>`;
  const rows = stores.map(s => {
    const list = byStore[s];
    return `<tr><td style="vertical-align:top"><b>${esc(s)}</b></td><td>${list.map(v => `
      <div class="eval-card">
        <div style="font-size:12px;color:var(--t2);margin-bottom:6px">${new Date(v.time).toLocaleString("zh-CN")} · 填写人：${esc(v.by) || "-"}</div>
        ${modBadge("理论", v.th)}${modBadge("技术", v.tech)}${modBadge("实操", v.prac)}
      </div>`).join("")}</td></tr>`;
  }).join("") || `<tr><td class="empty" colspan="2">暂无门店提交评估</td></tr>`;
  el.innerHTML = `
    <div class="sec">
      <h3>讲师评估（新加盟商培训）</h3>
      <div class="cards">
        <div class="card"><div class="k">已收评估门店</div><div class="v">${stores.length}</div></div>
        <div class="card"><div class="k">评估总数</div><div class="v">${evals.length}</div></div>
        <div class="card"><div class="k">理论评语</div><div class="v">${evals.filter(v => v.th).length}</div></div>
        <div class="card"><div class="k">技术评语</div><div class="v">${evals.filter(v => v.tech).length}</div></div>
        <div class="card"><div class="k">实操评语</div><div class="v">${evals.filter(v => v.prac).length}</div></div>
      </div>
      <div class="note" style="font-size:12px;color:var(--t2);margin:8px 0">评估数据由门店通过 H5 链接提交，跑一次 fetch_study.py 后在此更新。看板上线 GitHub Pages 后，链接可直接发到门店群。</div>
    </div>
    <div class="sec">
      <h3>门店填写链接生成</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <input id="genStore" placeholder="输入门店名" value="${esc(genStore)}" style="flex:1;min-width:200px;padding:9px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:14px">
        <button class="btn" onclick="genLink()">生成链接</button>
        <button class="btn" id="copyBtn" style="display:none" onclick="copyLink()">复制</button>
      </div>
      <div id="genOut" style="font-size:13px;color:var(--t2);word-break:break-all"></div>
    </div>
    <div class="sec">
      <h3>各门店评估内容</h3>
      <table><tr><th style="width:180px">门店</th><th>评估内容</th></tr>${rows}</table>
    </div>`;
  if (genStore) genLink();
}
let lastLink = "";
function genLink() {
  const s = document.getElementById("genStore").value.trim();
  if (!s) { document.getElementById("genOut").textContent = "请先输入门店名"; return; }
  lastLink = location.origin + location.pathname.replace(/[^/]*$/, "") + "eval_form.html?store=" + encodeURIComponent(s);
  document.getElementById("genOut").innerHTML = `门店链接：<a href="${lastLink}" target="_blank" style="color:#186BEB">${lastLink}</a><br><span style="font-size:12px">发到门店群，店长手机打开即可填写（看板正式上线后此链接外网可用）</span>`;
  document.getElementById("copyBtn").style.display = "inline-block";
}
function copyLink() {
  navigator.clipboard.writeText(lastLink).then(() => { document.getElementById("copyBtn").textContent = "已复制"; setTimeout(() => document.getElementById("copyBtn").textContent = "复制", 1500); });
}

/* ---------- 公开课 ---------- */
function renderOpen() {
  document.getElementById("main").innerHTML = `<div class="sec"><h3>公开课学习（自由学习课程集合）</h3><div class="empty">公开课为首页导航自由学习，不强制统计；后续可接入课程库与学时排行（staffCourseHoursRanking）</div></div>`;
}

/* ---------- 主渲染 ---------- */
function render() {
  const tabs = [["概述", ""], ...DATA.categories.map(c => [c, ""]), ["讲师评估", ""]];
  document.getElementById("mainTabs").innerHTML = tabs.map(([t]) => {
    const n = t === "概述" || t === "讲师评估" ? "" : `<span class="n">${plansInRange(t).length}</span>`;
    return `<button class="${state.tab === t ? "active" : ""}" onclick="state.tab='${t}';state.planIdx=0;render()">${t}${n}</button>`;
  }).join("");
  if (state.tab === "概述") renderOverview();
  else if (state.tab === "讲师评估") renderEval();
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
