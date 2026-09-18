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

// 从阶段名解析「第N天」（兜底用：stageStats 缺失时按名字推算日期）
function cnDayNum(s) {
  const m = /第([0-9０-９]+)天/.exec(s || "");
  if (m) return parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10);
  const m2 = /第([一二三四五六七八九十]+)天/.exec(s || "");
  if (!m2) return null;
  const cn = m2[1], D = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (cn === "十") return 10;
  let n = 0;
  const i = cn.indexOf("十");
  if (i === -1) return D[cn] || null;
  if (i > 0) n += D[cn[0]] || 0;
  n *= 10;
  if (i < cn.length - 1) n += D[cn[i + 1]] || 0;
  return n;
}
// 周期判断（2026-09-19 统一口径）：与 dueDateOf 同源——一个阶段=一天，
// 应完成日期 ≤ 今天才算已到周期；未到周期的阶段不展示（避免满屏未来"未签到/未考"）。
// ⚠️ 旧版按阶段名「第N天」推算，导致明细表列头日期与阶段完成情况/弹窗（dueDateOf）不一致：
// 182期第四天实际 9-18 完成，明细表却把 9-18 列挂成第五天（用户报障 9-19）。
function isStageDue(p, sn) {
  const due = dueDateOf(p, sn);
  if (!due) return true; // 无法推算（无 stageStats/startDate）→ 一律展示
  const d = new Date(due + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d <= today;
}

function pct(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace("%", "")) || 0;
}
function barHtml(v) {
  const cls = v >= 80 ? "g" : v >= 40 ? "o" : "r";
  return `<span class="bar"><i class="${cls}" style="width:${Math.min(v, 100)}%"></i></span>${v.toFixed(1)}%`;
}
// 考核类任务：考试(type4) 或 带分数的作业/表单（如「上传拼盘实操考核图片」平台也打分）
function isExamT(t) { return t && (t[1] === 4 || (t[3] != null && t[3] !== "-" && !isNaN(+t[3]))); }
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

/* ---------- 阶段完成口径（2026-09-18 Rain 定稿）----------
   完成率 = (必修课完成项数 + 考试合格科数) ÷ (必修课应完成项数 + 考试应完成科数)
   · 必修课 = 网课(3)/实操课(8)，完成 = 任务状态 W
   · 考核类 = 考试(type4) 或 平台要打分/阅卷的任务（有阅卷结论或带分数）——
     含「上传考核截图」这类作业，平台判分后才算完成
   · 考核合格 = 已完成(W) 且 未被判「否」 且（有分数时 ≥80）；「待阅卷」不算合格
   · 无判分的普通作业/表单(5/7)只在明细里展示，不计入完成率
   ⚠️ 平台 stageStatistics 的已完成/完成率与真实任务数据不符（182期第四天平台报
   100%，实际全员截图待阅卷）→ 有员工明细时一律按真实任务口径重算。 */
function isGradedT(t) {
  return t && (t[1] === 4 || (t[4] != null && t[4] !== "-") ||
    (t[3] != null && t[3] !== "-" && !isNaN(+t[3])));
}
function examPassT(t) {
  // 合格 = 已上传(W) + 老师已阅卷 + 及格（有分数 ≥80，无分数需平台判「是」）
  // 「待阅卷」= 老师还没打分 → 统计上算未完成（明细里单独标黄色「待阅卷」）
  if (!t || t[2] !== "W" || t[4] === "否" || t[4] === "待阅卷") return false;
  const n = +t[3];
  if (t[3] != null && t[3] !== "-" && !isNaN(n)) return n >= 80;
  return t[4] === "是";
}
// 任务完成标签（仅展示用；统计口径见 examPassT）：待阅卷单独标出，但计入未完成
function taskLabel(t) {
  if (t && t[2] === "W") return { txt: "✓ 已完成", ok: true, pending: false };
  if (t && t[4] === "待阅卷") return { txt: "待阅卷", ok: false, pending: true };
  return { txt: "✗ 未完成", ok: false, pending: false };
}
function stageTasksOf(p, e, stageName) {
  const det = p.empDetails && p.empDetails[String(e.employeeId)];
  const stg = det && (det.stages || []).find(s => (s.n || "") === stageName);
  return { det, stg, ts: (stg && stg.t) || [] };
}
// 单学员单阶段「需完成项」合计 {total, done}（必修 + 考核按项计，其余类型不计）
function stageRequired(p, e, stageName) {
  const { det, stg, ts } = stageTasksOf(p, e, stageName);
  let total = 0, done = 0;
  ts.forEach(t => {
    if (isGradedT(t)) { total++; if (examPassT(t)) done++; }
    else if (t[1] === 3 || t[1] === 8) { total++; if (t[2] === "W") done++; }
  });
  // 该阶段只有普通作业/表单（无必修无考核）→ 退回全部任务口径，保证能归档状态
  if (!total) { total = ts.length; done = ts.filter(t => t[2] === "W").length; }
  return { total, done, hasStage: !!det && !!stg, hasEmp: !!det };
}

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
    if (s && s.total) { map[k].tT = (map[k].tT || 0) + s.total; map[k].tD = (map[k].tD || 0) + s.done; map[k].hasT = true; }
    if (status === 2) map[k].done++;
    else if (status === 1) map[k].doing++;
    else map[k].todo++;
  });
  const arr = Object.values(map);
  // 完成率 = 必修课+考核口径（empStat 内已统一，2026-09-18），无明细时回退人数口径
  arr.forEach(a => a.rate = a.hasT && a.tT ? a.tD / a.tT * 100 : (a.total ? a.done / a.total * 100 : 0));
  arr.sort((a, b) => b.rate - a.rate || b.total - a.total);
  return arr;
}

// 手动分类覆盖（2026-09-18 升级：三处持久化，不再只靠 localStorage）
// ① localStorage（即时/离线） ② 本机更新服务 data/cat_overrides.json（写入即生效）
// ③ 随更新推送进仓库 → 线上静态文件（跨设备/清缓存兜底）
// 读取时合并：静态文件、本机服务的记录会覆盖补齐 localStorage 缺的部分
const CAT_OV_KEY = "study_cat_override_v1";
let CAT_OV = (() => { try { return JSON.parse(localStorage.getItem(CAT_OV_KEY)) || {}; } catch (e) { return {}; } })();
function effCat(p) { return CAT_OV[p.planId] || p.category; }
const CAT_OV_SVC = "http://localhost:8767/api/cat_overrides";
function mergeCatOv(map) {
  if (!map || typeof map !== "object") return false;
  const merged = { ...CAT_OV, ...Object.fromEntries(Object.entries(map).filter(([k, v]) => k && v)) };
  if (JSON.stringify(merged) === JSON.stringify(CAT_OV)) return false;
  CAT_OV = merged;
  try { localStorage.setItem(CAT_OV_KEY, JSON.stringify(CAT_OV)); } catch (e) {}
  return true;
}
function hydrateCatOv() {
  // 仓库静态文件（跨设备兜底）
  fetch("data/cat_overrides.json?t=" + Date.now()).then(r => r.ok ? r.json() : null).then(m => { if (mergeCatOv(m)) render(); }).catch(() => {});
  // 本机更新服务（最新写入）
  fetch(CAT_OV_SVC + "?t=" + Date.now()).then(r => r.ok ? r.json() : null).then(d => {
    if (d && d.ok && d.overrides && mergeCatOv(d.overrides)) render();
  }).catch(() => {});
}
let __catToastT = null;
function catToast() {
  let t = document.getElementById("catToast");
  if (!t) {
    t = document.createElement("div"); t.id = "catToast";
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--nav);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;z-index:9999;opacity:0;transition:opacity .25s;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25)";
    document.body.appendChild(t);
  }
  t.textContent = "✓ 已保存，刷新不会丢（线上同步随下次更新数据）";
  t.style.opacity = "1";
  clearTimeout(__catToastT);
  __catToastT = setTimeout(() => { t.style.opacity = "0"; }, 2000);
}
function saveCatOv() {
  try { localStorage.setItem(CAT_OV_KEY, JSON.stringify(CAT_OV)); } catch (e) {}
  try {
    fetch(CAT_OV_SVC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides: CAT_OV }) }).catch(() => {});
  } catch (e) {}
  catToast();
}
function moveCat(planId, to) {
  if (to) CAT_OV[planId] = to; else delete CAT_OV[planId];
  saveCatOv();
  state.planIdx = 0;
  render();
}
function isSurvey(p) { return SURVEY_RE.test(p.planName || ""); }
const PUB_GROUPS = ["培训组(直营组)", "新店运营组", "加盟营运组", "新店筹建组"];
function plansOf(cat, gOverride) {
  let arr = DATA.plans.filter(p => effCat(p) === cat && !isSurvey(p) && !PLAN_EXCLUDE.some(k => (p.planName || "").includes(k)));
  // 其他 Tab：只保留四个组发布的计划，支持组别导航筛选
  if (cat === "其他") { const g = gOverride || state.gFilter; arr = arr.filter(p => p.pubGroup && (g === "全部" || p.pubGroup === g)); }
  return arr;
}
function setGFilter(v) { state.gFilter = v; state.planIdx = 0; render(); }
function surveysOf() {
  return DATA.plans.filter(p => effCat(p) === "线上线下培训" && isSurvey(p) && !PLAN_EXCLUDE.some(k => (p.planName || "").includes(k)));
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

// 默认状态校准：高亮按钮与 state.range 一致，日期输入预填「本月1日 ~ 今天」
// fix：此前 HTML 把 active 写死在「全部」，而 state.range 默认「本月」，色块与实际数据口径对不上造成误会
function initRangeBar() {
  document.querySelectorAll("#rangeBar button").forEach(b => b.classList.toggle("active", b.dataset.r === state.range));
  const rf = document.getElementById("rFrom"), rt = document.getElementById("rTo");
  const n = new Date();
  const today = fmtLocal(n);
  const first = fmtLocal(new Date(n.getFullYear(), n.getMonth(), 1));
  if (rf && !rf.value) rf.value = first;
  if (rt && !rt.value) rt.value = today;
}
initRangeBar();

// 多选课程汇总视图
function renderMulti(plans, gnav) {
  const el = document.getElementById("main");
  const sel = state.multiSel || [];
  const chosen = sel.length ? sel : plans.map((_, i) => i);
  const rows = plans.map((p, i) => {
    const ov = p.overview || {};
    let T = 0, D = 0, esum = 0, en = 0;
    (p.emps || []).forEach(e => {
      const st = empStat(p, e);
      if (st && st.total) { T += st.total; D += st.done; }
      const det = p.empDetails && p.empDetails[String(e.employeeId)];
      ((det && det.stages) || []).forEach(sg => (sg.t || []).forEach(t => {
        if (t[2] === "W" && t[3] != null && t[3] !== "-" && !isNaN(+t[3])) { esum += +t[3]; en++; }
      }));
    });
    return { i, p, ov, emps: (p.emps || []).length, T, D, rate: T ? D / T * 100 : null, esum, en, should: ov.shouldTrainStoreCount || 0, trained: ov.trainedStoreCount || 0 };
  });
  const c = rows.filter(r => chosen.includes(r.i));
  const S = a => a.reduce((x, y) => x + y, 0);
  const totT = S(c.map(r => r.T)), totD = S(c.map(r => r.D));
  const totE = S(c.map(r => r.esum)), totN = S(c.map(r => r.en));
  const cards = `
    <div class="cards">
      <div class="card"><div class="k">课程数</div><div class="v">${c.length}<small> 门</small></div></div>
      <div class="card"><div class="k">应学人数</div><div class="v">${S(c.map(r => r.ov.numberOfPersonsDueToComplete ?? r.emps))}</div></div>
      <div class="card"><div class="k">已完成</div><div class="v">${S(c.map(r => r.ov.numberOfPeopleCompleted ?? 0))}</div></div>
      <div class="card"><div class="k">完成率</div><div class="v">${totT ? (totD / totT * 100).toFixed(1) : "0.0"}<small>%</small></div></div>
      <div class="card"><div class="k">考试平均分</div><div class="v">${totN ? (totE / totN).toFixed(1) : "-"}</div></div>
      <div class="card"><div class="k">应学门店</div><div class="v">${S(c.map(r => r.should))}</div></div>
      <div class="card"><div class="k">已参训门店</div><div class="v">${S(c.map(r => r.trained))}</div></div>
      <div class="card"><div class="k">任务进度</div><div class="v" style="font-size:16px;line-height:2.4">${totD.toLocaleString()} / ${totT.toLocaleString()}</div></div>
    </div>`;
  const tbl = c.map(r => `<tr><td style="text-align:left">${esc(r.p.planName)}</td><td>${r.ov.numberOfPersonsDueToComplete ?? r.emps}</td><td>${r.ov.numberOfPeopleCompleted ?? "-"}</td><td>${r.rate != null ? barHtml(r.rate) : "-"}</td><td>${r.en ? (r.esum / r.en).toFixed(1) : "-"}</td><td>${r.trained}/${r.should}</td><td>${r.should ? (r.trained / r.should * 100).toFixed(1) + "%" : "-"}</td></tr>`).join("");
  el.innerHTML = `${gnav}
    <div class="planbar" style="flex-wrap:wrap;align-items:flex-start">
      <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;white-space:nowrap"><input type="checkbox" checked onchange="state.multi=this.checked;state.multiSel=[];renderCat()"> 多选汇总</label>
      <select multiple size="8" style="min-width:420px" onchange="state.multiSel=[...this.selectedOptions].map(o=>+o.value);renderMulti(plansInRange(state.cat), '')">${plans.map((x, i) => `<option value="${i}" ${chosen.includes(i) ? "selected" : ""}>${esc(x.planName)}（${x.startDate || "?"}）</option>`).join("")}</select>
      <span class="badge b-gray">已选 ${sel.length || plans.length} 门${sel.length ? "" : "（默认全部）"}</span>
    </div>
    ${cards}
    <div class="sec"><h3>所选课程明细</h3><table><tr><th>课程</th><th>应学人数</th><th>已完成</th><th>完成率</th><th>考试平均分</th><th>参训门店</th><th>参与率</th></tr>${tbl}</table></div>`;
}

/* ---------- 应完成日期推算 ----------
   规则（Rain 2026-09-18 定）：一个阶段算一天。
   应完成日期 = 任务发布时间(startDate) + (阶段在该计划 stageStats 中的序号 - 1) 天。
   例：182期发布 9-14，10 个阶段 → 9-14、9-15 …… 9-23（与计划结束日一致） */
function dueDateOf(p, stageName) {
  if (!p || !p.startDate) return "";
  const list = p.stageStats || [];
  const idx = list.findIndex(x => (x.phaseName || "") === (stageName || ""));
  const dt = new Date(p.startDate + "T00:00:00");
  if (isNaN(dt.getTime())) return "";
  if (idx >= 0) {
    dt.setDate(dt.getDate() + idx);
  } else {
    // stageStats 缺失/阶段名对不上 → 退回按阶段名「第N天」推算（旧口径兜底）
    const day = cnDayNum(stageName);
    if (day == null) return "";
    dt.setDate(dt.getDate() + (day - 1));
  }
  const pad = x => String(x).padStart(2, "0");
  return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
}

// 列头全局天数编号（2026-09-19 Rain 拍板）：与加盟商培训日报同一套编号——一个阶段=一天，
// 第N天 = 阶段在 stageStats 中的全局序号+1（等价于 应完成日期-startDate+1 天）。
// 背景：平台阶段名各类分别重头计数（理论课第一天→技术培训第一~五天→门店实操第六七八天→理论课第九天），
// 而日报用全局编号（技术培训第5天=9-18）。看板照抄平台名导致「第五天」两系统差一天，
// 用户按日报口径反复报障（第五天=18号）。列头一律用全局编号，原始阶段名放 th 的 title 悬浮可查。
const STAGE_TYPE_ALIAS = { "门店实操": "门店实践" };
function stageDayLabel(p, stageName) {
  const name = stageName || "";
  const m = /^【(.+?)】/.exec(name);
  const typ = m ? (STAGE_TYPE_ALIAS[m[1]] || m[1]) : "";
  let n = null;
  const list = (p && p.stageStats) || [];
  const idx = list.findIndex(x => (x.phaseName || "") === name);
  if (idx >= 0) {
    n = idx + 1;
  } else if (p && p.startDate) {
    const due = dueDateOf(p, name);
    if (due) n = Math.round((new Date(due + "T00:00:00") - new Date(p.startDate + "T00:00:00")) / 86400000) + 1;
  }
  if (!n || n < 1) return esc(name).replace(/新加盟商培训/g, ""); // 兜底：无法定位全局天数时保持原样
  return (typ ? esc(typ) : "") + "第" + n + "天";
}

function setRange(r) {
  state.range = r;
  if (r === "区间") {
    state.rFrom = document.getElementById("rFrom").value || null;
    state.rTo = document.getElementById("rTo").value || null;
    if (!state.rFrom && !state.rTo) return;
  }
  // 点「本月/上月」时把日期输入框同步成对应区间，保证输入框与高亮按钮口径一致
  if (r === "本月" || r === "上月") {
    const [f, t] = monthRange(r === "本月" ? 0 : -1);
    const rf = document.getElementById("rFrom"), rt = document.getElementById("rTo");
    if (rf) rf.value = f;
    if (rt) rt.value = t;
  }
  state.planIdx = 0;
  document.querySelectorAll("#rangeBar button").forEach(b => b.classList.toggle("active", b.dataset.r === r));
  render();
}

/* ---------- 员工真实进度（以员工明细接口为准） ---------- */
// 2026-09-18 口径全局统一（Rain 定稿）：完成率/完成状态只认「必修课 + 考核」——
// 必修课(3/8)=状态W；考核(考试/打分作业/拼盘截图)=合格才算（打分≥80、未判否），
// 「待阅卷」不算完成；无判分的普通作业/表单不计入分母。
// 平台 det.done/det.total 把待阅卷也算完成（182期第四天虚报100%），不再直接采信。
function empStat(p, e) {
  const det = p.empDetails && p.empDetails[String(e.employeeId)];
  if (!det || det.total == null) return null;
  let total = 0, done = 0;
  (det.stages || []).forEach(s => (s.t || []).forEach(t => {
    if (isGradedT(t)) { total++; if (examPassT(t)) done++; }
    else if (t[1] === 3 || t[1] === 8) { total++; if (t[2] === "W") done++; }
  }));
  if (!total) { total = det.total || 0; done = det.done || 0; } // 明细里没任务 → 退回平台数
  const status = total > 0 && done >= total ? 2 : done > 0 ? 1 : 0;
  return { det, done, total, rate: total ? done / total * 100 : 0, status };
}

/* ---------- 概述 ---------- */
function renderOverview() {
  const el = document.getElementById("main");
  const catCards = CORE_CATS.map(cat => {
    const plans = plansInRange(cat);
    let emps = 0, done = 0, tT = 0, tD = 0, hasT = false;
    plans.forEach(p => (p.emps || []).forEach(e => {
      if (statusOf(e) == null) return;
      const st = empStat(p, e);
      if (st && st.total) { hasT = true; tT += st.total; tD += st.done; }
      emps++;
      if (st ? st.status === 2 : e.trainingStatus === 2) done++;
    }));
    // 完成率 = 必修课+考核口径（empStat 内已统一，2026-09-18），无明细回退人数口径
    const rate = hasT && tT ? tD / tT * 100 : (emps ? done / emps * 100 : 0);
    const latest = plans.slice(0, 5).map(p => {
      // 整体完成率与卡片同口径：任务进度优先（平台字段为0时兜底）
      let t = 0, d2 = 0;
      (p.emps || []).forEach(e => { const s = empStat(p, e); if (s) { t += s.total; d2 += s.done; } });
      let ovRate;
      if (t) ovRate = (d2 / t * 100).toFixed(1) + "%";
      else if (p.overview && p.overview.percentageComplete != null) ovRate = pct(p.overview.percentageComplete).toFixed(1) + "%";
      else ovRate = "-";
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
  if (state.multi) { renderMulti(plans, gnav); return; }
  state.planIdx = Math.min(state.planIdx, plans.length - 1);
  const p = plans[state.planIdx];

  const opts = plans.map((x, i) => `<option value="${i}" ${i === state.planIdx ? "selected" : ""}>${esc(x.planName)}（${x.startDate || "?"}）</option>`).join("");
  const multiBox = `<label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;white-space:nowrap"><input type="checkbox" onchange="state.multi=this.checked;state.multiSel=[];renderCat()"> 多选汇总</label>`;
  const mvSel = `<select title="移动该课程到其他板块" style="max-width:150px" onchange="moveCat('${p.planId}', this.value)">
      <option value="" ${!CAT_OV[p.planId] ? "selected" : ""}>📁 ${esc(p.category)}</option>
      ${["线上线下培训", "其他"].filter(c => c !== p.category).map(c => `<option value="${c}" ${CAT_OV[p.planId] === c ? "selected" : ""}>移到「${c}」</option>`).join("")}
    </select>`;
  const ov = p.overview || {};

  // 学习时间：优先平台有效期（"起 至 止"），否则计划起止日期，两行显示
  const validRaw = ov.periodOfValidity || "";
  const [vFrom, vTo] = validRaw.includes("至") ? validRaw.split("至").map(x => x.trim()) : [p.startDate, p.endDate];
  const timeCard = `<div class="card"><div class="k">学习时间</div><div class="v" style="font-size:14px;line-height:2;text-align:left">开始：${esc(vFrom || "-")}<br>结束：${esc(vTo || "-")}</div></div>`;

  // 概述卡片
  // 完成率：必修课+考核口径（empStat 内已统一，2026-09-18）；无明细才回退平台字段
  let cardRate = 0;
  {
    let tT = 0, tD = 0, hasT = false;
    (p.emps || []).forEach(e => { if (statusOf(e) == null) return; const st = empStat(p, e); if (st && st.total) { hasT = true; tT += st.total; tD += st.done; } });
    if (hasT && tT) cardRate = tD / tT * 100;
    else cardRate = pct(ov.percentageComplete) || 0;
  }
  // 考试平均分（含带分数的考核类任务，如上传图片打分）
  let examAvg = null;
  {
    let sum = 0, n = 0;
    (p.emps || []).forEach(e => {
      const det = p.empDetails && p.empDetails[String(e.employeeId)];
      if (!det) return;
      (det.stages || []).forEach(sg => (sg.t || []).forEach(t => {
        if (t[2] === "W" && t[3] !== undefined && t[3] !== "-" && t[3] !== null && !isNaN(+t[3])) { sum += +t[3]; n++; }
      }));
    });
    examAvg = n ? (sum / n).toFixed(1) : null;
  }
  const cards = `
    <div class="cards">
      <div class="card"><div class="k">应学人数</div><div class="v">${ov.numberOfPersonsDueToComplete ?? (p.emps || []).length}</div></div>
      <div class="card"><div class="k">已完成</div><div class="v">${ov.numberOfPeopleCompleted ?? "-"}</div></div>
      <div class="card"><div class="k">完成率</div><div class="v">${(cardRate || 0).toFixed(1)}<small>%</small></div></div>
      <div class="card"><div class="k">考试平均分</div><div class="v">${examAvg ?? "-"}</div></div>
      <div class="card"><div class="k">应学门店</div><div class="v">${ov.shouldTrainStoreCount ?? (p.storeStats || []).length}</div></div>
      <div class="card"><div class="k">已参训门店</div><div class="v">${ov.trainedStoreCount ?? "-"}</div></div>
      <div class="card"><div class="k">参与率</div><div class="v">${ov.shouldTrainStoreCount ? ((ov.trainedStoreCount || 0) / ov.shouldTrainStoreCount * 100).toFixed(1) : "-"}<small>%</small></div></div>
      ${timeCard}
    </div>`;

  // 阶段统计（行可点 -> 阶段学员明细）
  // ⚠️ 平台的 stageStatistics 与真实任务数据严重不符（182期第四天平台报「25人已完成/100%」，
  // 实际全员拼盘截图还是「待阅卷」）→ 有员工明细时一律按真实任务口径重算。
  const stageRows = (p.stageStats || []).filter(s => isStageDue(p, s.phaseName)).map((s, i) => {
    const key = s.phaseName;
    let todo = 0, doing = 0, doneN = 0, rT = 0, rD = 0, nDet = 0;
    (p.emps || []).forEach(e => {
      if (statusOf(e) == null) return;
      const r = stageRequired(p, e, key);
      if (!r.hasEmp) return;              // 该学员无明细 → 退回平台数
      nDet++;
      rT += r.total; rD += r.done;
      if (!r.hasStage || !r.total) { todo++; return; }  // 该阶段无任务 → 未开始
      if (r.done >= r.total) doneN++;
      else if (r.done > 0) doing++;
      else todo++;
    });
    let sRate = pct(s.phaseCompletionRate);
    let todoC = s.uninitiatedNumber, doingC = s.numberOfPeopleInProgress, doneC = s.numberOfPeopleCompleted;
    if (nDet && rT) { todoC = todo; doingC = doing; doneC = doneN; sRate = rD / rT * 100; }
    return `<tr class="clickable" onclick="openStage('${esc(key).replace(/'/g, "")}')"><td>${esc(s.phaseName)}</td><td style="white-space:nowrap;color:${dueDateOf(p, key) ? "var(--t1)" : "var(--t2)"}">${dueDateOf(p, key) || "—"}</td><td>${s.numberOfPersonsDueToComplete}</td><td>${todoC}</td><td>${doingC}</td><td>${doneC}</td><td>${barHtml(sRate)}</td></tr>`;
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
    return emps.length ? `<div style="font-size:12px;color:var(--t2);margin-bottom:6px">${esc((p.planName || "学习看板") + " 学员学习明细")}</div>${aggDetailTable(p, emps)}` : `<div class="empty">暂无学员数据</div>`;
  })();

  el.innerHTML = `
    ${gnav}
    <div class="planbar">
      <select onchange="state.planIdx=+this.value;renderCat()">${opts}</select>
      ${multiBox}
      ${mvSel}
      <span class="badge b-gray">学员 ${(p.emps || []).length} 人</span>
      ${p.overview ? "" : `<span class="badge b-red">概述数据无权限（非计划管理员）</span>`}
    </div>
    ${cards}
    ${stageRows ? `<div class="sec"><h3>阶段完成情况</h3><div style="font-size:12px;color:var(--t2);margin-bottom:6px">点击阶段行可查看该阶段每位学员的学习 / 考试 / 实操完成情况；应完成日期按「一个阶段 = 一天」推算（任务发布日 = 第 1 阶段）；完成率 =（必修课完成项数 ＋ 考试合格科数）÷ 两项应完成总数，拼盘截图等考核要老师打分（≥80）才算合格，待阅卷 = 未完成</div><table><tr><th>阶段</th><th>应完成日期</th><th>应完成</th><th>未开始</th><th>进行中</th><th>已完成</th><th>完成率</th></tr>${stageRows}</table></div>` : ""}
    <div class="sec"${state.sub === "全部" ? ' style="margin-left:calc(50% - 50vw + 24px);margin-right:calc(50% - 50vw + 24px)"' : ""}>
      <h3>二级汇总</h3>
      <div class="subtabs">
        ${SUBS.map(s => `<button class="${state.sub === s ? "active" : ""}" onclick="state.sub='${s}';renderCat()">${s}</button>`).join("")}
        ${state.sub === "全部" ? `<button class="btn" style="padding:5px 14px;font-size:12px;margin-left:8px" onclick="sharePng('all')">🖼 快照</button>` : ""}
      </div>
      <div id="allSecBody" style="overflow-x:auto">${body}</div>
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
  window.__aggShare = { kind: "agg", label, nameEnc };
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
  // 未到周期的阶段（未来天）不展示
  for (let i = stageNames.length - 1; i >= 0; i--) if (!isStageDue(p, stageNames[i])) stageNames.splice(i, 1);
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
    const stat = empStat(p, e);
    const det = p.empDetails && p.empDetails[String(e.employeeId)];
    // 出勤 = 实际出勤(已签到且未请假天数) / 应出勤(周期内已开始天数，即 stageNames.length，未来天不计；请假不计出勤)
    const attCnt = stageNames.filter(sn => {
      if (leaveOf(sn, e)) return false;
      const stg = det && (det.stages || []).find(s => (s.n || "") === sn);
      return stg && (stg.t || []).some(t => t[5] && t[5] !== "-");
    }).length;
    const cnt = a => `${a.filter(t => t[2] === "W").length}/${a.length}`;
    const dayCells = stageNames.map(sn => {
      const stg = det && (det.stages || []).find(s => (s.n || "") === sn);
      const sts = stg ? (stg.t || []) : [];
      // 出勤：请假 > 已签到（有任务完成记录）> 未签到（紧凑文字样式）
      let att = `<span style="font-size:11px;font-weight:600;color:var(--orange)">未签到</span>`;
      if (leaveOf(sn, e)) att = `<span style="font-size:11px;color:var(--t2)">请假</span>`;
      else if (sts.some(t => t[5] && t[5] !== "-")) att = `<span style="font-size:11px;font-weight:600;color:var(--green)">已签到</span>`;
      // 分数：该天全部考核，多科/隔开；未考=有考试未完成；—=无考试；红=未达80
      const exams = sts.filter(isExamT);
      // 必修课=网课(3)+实操课(8)：实操视频课（手握饭团等）同为强制学习，按必修口径统计
      const learn = sts.filter(t => t[1] === 3 || t[1] === 8);
      let scoreStr = "";
      if (exams.length) {
        // 多科竖排，每科一行，避免横向超出格子；无考试则不显示该行
        scoreStr = `<div>${exams.map(t => scoreCell(t, false)).join("</div><div>")}</div>`;
      }
      const learnStr = learn.length ? `<div style="font-size:11px;color:${learn.every(t => t[2] === "W") ? "var(--t2)" : "#e64340"}">必修课 ${cnt(learn)}</div>` : "";
      return `<td style="text-align:center;border-left:1px solid var(--line);font-size:12px;line-height:1.5;vertical-align:top"><div>${att}</div>${scoreStr}${learnStr}</td>`;
    }).join("");
    return `<tr><td style="white-space:nowrap">${esc(e.empName)}</td><td style="white-space:nowrap">${esc(storeOf(e))}</td><td style="text-align:center;white-space:nowrap">${attCnt}/${stageNames.length}</td><td style="text-align:center">${stat ? `${stat.done}/${stat.total}` : "-"}</td>${dayCells}</tr>`;
  }).join("");
  return !hasDet
    ? `<div style="font-size:12px;color:#b45309;background:#fff7e6;border:1px solid #ffe3a3;border-radius:8px;padding:8px 12px;margin-bottom:8px">⚠️ 该计划为直播/特殊类型，慧运营平台不提供任务明细接口（明细接口对该计划返回失败），无法统计每人的必修课/考试/实操/总进度，仅展示平台返回的完成状态。</div>${rows ? `<table><tr><th>序号</th><th>姓名</th><th>门店</th><th>完成状态</th></tr>${rows}</table>` : `<div class="empty">无符合筛选条件的学员</div>`}`
    : (rows ? `<table><tr><th>姓名</th><th>门店</th><th>出勤</th><th>总进度</th>${stageNames.map(sn => { const ds = dueDateOf(p, sn); const short = stageDayLabel(p, sn); return `<th style="text-align:center;border-left:1px solid var(--line);white-space:normal;word-break:break-all;min-width:92px" title="阶段：${esc(sn)}">${short}${ds ? `<div style="font-size:11px;font-weight:400;color:var(--t2)">${ds}</div>` : ""}</th>`; }).join("")}</tr>${rows}</table>` : `<div class="empty">无符合筛选条件的学员</div>`);
}

// 线上线下培训的明细版式：姓名/门店/区域/实操/考试分数/阶段进度/完成任务明细（抓取同新加盟商培训）
function flatDetailTable(p, emps) {
  const hasDet = p.empDetails && Object.keys(p.empDetails).length > 0;
  if (!hasDet) return aggDetailTable(p, emps);
  // 出勤：整个计划的出勤情况 = 实际出勤(已签到的天数) / 应出勤(周期内已开始的天数，未来天不计)
  const stageNames = [];
  (p.emps || []).forEach(e0 => { const d0 = p.empDetails && p.empDetails[String(e0.employeeId)]; (d0 && d0.stages || []).forEach(s => { if (s.n && !stageNames.includes(s.n)) stageNames.push(s.n); }); });
  for (let i = stageNames.length - 1; i >= 0; i--) if (!isStageDue(p, stageNames[i])) stageNames.splice(i, 1);
  const dueDays = stageNames.length;
  const rows = emps.map(e => {
    const ts = planTasks(p, e);
    const exams = ts.filter(isExamT);
    const stat = empStat(p, e);
    const det = p.empDetails && p.empDetails[String(e.employeeId)];
    const att = stageNames.filter(sn => {
      const lv = p.leaves && p.leaves[sn];
      if (lv && (lv.includes(String(e.employeeId)) || lv.includes(e.empName))) return false; // 请假不计出勤
      const stg = det && det.stages && det.stages.find(x => x.n === sn);
      return stg && (stg.t || []).some(t => t[5] && t[5] !== "-");
    }).length;
    const scoreStr = exams.length ? exams.map(t => scoreCell(t, false)).join("</div><div>") : "—";
    const detail = ts.map(t => {
      const [name, type, st, score, isPass] = t;
      const lb = taskLabel(t);
      let extra = "";
      if ((type === 4 || isExamT(t)) && !lb.pending) extra = score !== "-" && score != null ? `（${score}分${isPass === "否" ? "，未过" : ""}）` : "（未考）";
      const col = lb.ok ? "var(--t1)" : lb.pending ? "#e6a23c" : "#e64340";
      return `<div style="padding:1px 0;color:${col}">${esc(name)}：${lb.txt}${extra}</div>`;
    }).join("") || `<div style="color:var(--t2)">无任务数据</div>`;
    const fins = ts.filter(t => t[2] === "W" && t[5]).map(t => t[5]).sort();
    const finStr = fins.length ? fins[fins.length - 1] : "—";
    return `<tr><td style="white-space:nowrap">${esc(e.empName)}</td><td style="white-space:nowrap">${esc(storeOf(e))}</td><td style="white-space:nowrap">${esc(regionOf(e))}</td><td style="text-align:center;white-space:nowrap">${att}/${dueDays}</td><td style="text-align:center"><div>${scoreStr}</div></td><td style="text-align:center">${stat ? `${stat.done}/${stat.total}` : "-"}</td><td>${detail}</td><td style="white-space:nowrap;font-size:12px">${finStr}</td></tr>`;
  }).join("");
  return `<table><tr><th>姓名</th><th>门店</th><th>区域</th><th>出勤</th><th>考试分数</th><th>阶段进度</th><th style="min-width:260px">完成任务明细</th><th>完成时间</th></tr>${rows}</table>`;
}

function aggDetailRender(p, emps, title) {
  document.getElementById("mTitle").textContent = title + (p && p.startDate ? ` 【任务发布时间：${p.startDate}】` : "");
  document.getElementById("mBody").innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">
      ${["全部", "已完成", "未完成"].map(f => `<button class="btn" style="padding:5px 14px;font-size:12px;${aggFilter === f ? "" : "background:var(--line);color:var(--t1)"}" onclick="aggFilter='${f}';aggReopen&&aggReopen()">${f}</button>`).join("")}
      <button class="btn" style="padding:5px 14px;font-size:12px" onclick="openShareOverlay('agg')">🔗 分享</button>
      <button class="btn" style="padding:5px 14px;font-size:12px" onclick="sharePng('modal')">🖼 图片</button>
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
  const lb = taskLabel(t);
  const label = TYPE_NAME[type] || "任务";
  let cls = lb.ok ? "b-green" : lb.pending ? "b-orange" : "b-orange";
  let extra = "";
  if (type === 4 && !lb.pending) extra = score !== "-" && score != null ? ` ${score}分${isPass === "否" ? "(未过)" : ""}` : " 未考";
  return `<span class="badge ${cls}" style="margin:2px 4px 2px 0">${esc(name)}（${label}）${lb.ok ? "已完成" : lb.pending ? "待阅卷" : "未完成"}${extra}</span>`;
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
  const due = dueDateOf(p, stageName);
  document.getElementById("mTitle").textContent = (p.planName || "") + " · " + (stageDayLabel(p, stageName) || stageName) + " · 学习明细" + (p.startDate ? ` 【任务发布时间：${p.startDate}】` : "") + (due ? ` 【应完成日期：${due}】` : "");
  let emps = (p.emps || []).filter(e => statusOf(e) != null);
  const allGroups = ["培训组(直营组)", "新店运营组", "加盟营运组", "新店筹建组"];
  const gset = state.dGroups, rset = state.dRegions;
  if (gset && Object.keys(gset).length) emps = emps.filter(e => gset[mGroup(e).g]);
  if (rset && Object.keys(rset).length) emps = emps.filter(e => rset[mGroup(e).r]);
  // 该学员在该阶段的任务包（用于出勤/进度列展示）
  const stageOf = e => {
    const det = p.empDetails && p.empDetails[String(e.employeeId)];
    return det && (det.stages || []).find(s => (s.n || "") === stageName);
  };
  // 已完成/未完成 —— 与阶段汇总表同一口径：必修课全完成 + 考核全合格（截图打分≥80）才算已完成
  const stageDone = e => {
    const r = stageRequired(p, e, stageName);
    return r.hasStage && r.total > 0 && r.done >= r.total;
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
    const learn = ts.filter(t => t[1] === 3 || t[1] === 8), exams = ts.filter(isExamT), ops = ts.filter(t => [5, 7].includes(t[1]));
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
      const lb = taskLabel(t);
      let extra = "", bad = !lb.ok;
      if ((type === 4 || isExamT(t)) && !lb.pending) {
        if (score !== "-" && score != null && !isNaN(+score)) { extra = `（${score}分${isPass === "否" ? "，未过" : ""}）`; if (+score < 80 || +score === 0 || isPass === "否") bad = true; }
        else if (type === 4) extra = "（未考）";
      }
      const col = lb.ok ? "var(--t1)" : lb.pending ? "#e6a23c" : "#e64340";
      return `<div style="padding:1px 0;color:${col}">${esc(name)}：${lb.txt}${extra}</div>`;
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
    <div style="font-size:12px;color:var(--t2);margin-bottom:8px">说明：必修课/考试/实操/进度均为<b>该阶段</b>口径；出勤=该阶段有任务完成记录（已签到），请假以培训部登记为准；分数为当天全部考核成绩（多科以 / 隔开），未考=当天有考试但未完成，—=当天无考试安排，红色=该科未达80分。<b>「已完成」= 上传作业 + 老师已阅卷 + 考试及格（≥80）；待阅卷 单独标注（黄色），统计上计入未完成。</b></div>
    <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px">
      <b>组别：</b>${boxes("Groups", gset, allGroups)}
    </div>
    <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px">
      <b>区域：</b>${boxes("Regions", rset, regions)}
    </div>
    <div style="margin-bottom:8px;font-size:13px;display:flex;align-items:center;gap:6px">
      <b>完成状态：</b>
      ${["全部", "已完成", "未完成"].map(f => `<button class="btn" style="padding:5px 14px;font-size:12px;${state.dStatus === f ? "" : "background:var(--line);color:var(--t1)"}" onclick="setDStatus('${f}')">${f}</button>`).join("")}
      <button class="btn" style="padding:5px 14px;font-size:12px" onclick="openShareOverlay('stage')">🔗 分享</button>
      <button class="btn" style="padding:5px 14px;font-size:12px" onclick="sharePng('modal')">🖼 图片</button>
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
  window.__aggShare = { kind: "store", storeId: String(storeId) };
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
      <button class="btn" style="padding:5px 14px;font-size:12px;align-self:center" onclick="sharePng('modal')">🖼 图片</button>
    </div>
    ${rows ? `<table><tr><th>姓名</th><th>门店</th><th>答题状态</th></tr>${rows}</table>` : `<div class="empty">该筛选条件下无人员</div>`}`;
  document.getElementById("mask").classList.add("show");
}
function openAdvice(idx) {
  const p = surveysInRange()[idx];
  const subs = surveySubs(p.planName);
  document.getElementById("mTitle").textContent = p.planName + " · 建议明细（" + subs.length + "份）";
  document.getElementById("mBody").innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn" style="padding:5px 14px;font-size:12px" onclick="sharePng('modal')">🖼 图片</button></div>` + (subs.length ? adviceTable(subs) : `<div class="empty">该问卷对应课程暂无提交</div>`);
  document.getElementById("mask").classList.add("show");
}
function openAdviceC(idx) {
  const c = customSurveysOf().filter(x => dateInrange(x.date))[idx];
  if (!c) return;
  const subs = subsForTopic(c.name).filter(v => dateInrange(new Date(v.time).toISOString().slice(0, 10)));
  document.getElementById("mTitle").textContent = c.name + " · 建议明细（" + subs.length + "份）";
  document.getElementById("mBody").innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn" style="padding:5px 14px;font-size:12px" onclick="sharePng('modal')">🖼 图片</button></div>` + (subs.length ? adviceTable(subs) : `<div class="empty">该调研暂无提交</div>`);
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

/* ---------- 直营学习明细（培训组-直营组 8 店，2026-09-19） ----------
   口径：学习率 = 课程已完成项目 ÷ 课程应完成项目（免修任务剔除，与计划板块一致）
   任务形态：视频(2,8) / 文件(1,7,10) / 考试(4) / 实操上传(5)；面授签到(3)、问卷(6)、练习(11) 单独标注
   数据：计划任务 = plans[].empDetails（已有全量）；学习地图 = data.directMaps.emps（新增抓取） */
const D_FORM = { 1: "文件", 2: "视频", 7: "文件", 8: "视频", 10: "文件", 4: "考试", 5: "实操" };
const D_FORMS = ["视频", "文件", "考试", "实操"];
const D_TYPE_NAME = { 3: "面授/签到", 6: "问卷", 11: "练习" };
// 地图任务枚举与计划不同（2026-09-19 实测：status 0=未开始/2=进行中/3=已完成）：
// 2=岗位学习课程（视频）3=考核 9=练习题库 —— 3 与计划的面授枚举冲突，必须独立映射
const D_MAP_FORM = { 2: "视频", 3: "考试" };
const D_MAP_TYPE_NAME = { 9: "练习题库" };
function dFormOf(type) { return D_FORM[type] || null; }
function dMapFormOf(type) { return D_MAP_FORM[type] || null; }
function dTypeName(type) { return D_FORM[type] || D_TYPE_NAME[type] || "其他"; }
function dMapTypeName(type) { return D_MAP_FORM[type] || D_MAP_TYPE_NAME[type] || "其他"; }
// 单任务四形态格子：属于该形态 → ✓(绿)/✗(红)，否则 —
function dFormCell(form, type, done) {
  if (dFormOf(type) !== form) return `<span style="color:#c4cad6">—</span>`;
  return done ? `<span style="color:#1aad19;font-weight:700">✓</span>` : `<span style="color:#e64340;font-weight:700">✗</span>`;
}
function dMapFormCell(form, type, done) {
  if (dMapFormOf(type) !== form) return `<span style="color:#c4cad6">—</span>`;
  return done ? `<span style="color:#1aad19;font-weight:700">✓</span>` : `<span style="color:#e64340;font-weight:700">✗</span>`;
}
// 直营板块进度着色（9/19 用户拍板：各板块学习进度 <90% 红、≥90% 绿）——只作用于直营板块，不动全局 barHtml
function dBar(v) {
  if (v == null) return "—";
  const col = v >= 90 ? "#1aad19" : "#e64340";
  return `<span class="bar"><i class="${v >= 80 ? "g" : v >= 40 ? "o" : "r"}" style="width:${Math.min(v, 100)}%"></i></span><span style="color:${col};font-weight:600">${v.toFixed(1)}%</span>`;
}
function dRateCol(v) { return v == null ? "inherit" : v >= 90 ? "#1aad19" : "#e64340"; }
// 直营员工索引（构建一次）：{emps:[eid], byStore:{店:[eid]}, prof:{eid:{...}}, plans:{eid:[{plan,det}]}, mapsAv:{eid:{avg,n,done}}}
function directIndex() {
  if (window.__directIdx) return window.__directIdx;
  const dm = (DATA.directMaps || {}).emps || {};
  // 离职判定：从计划学员列表取 empStatus（地图接口不含该字段）
  const empStatusMap = {};
  (DATA.plans || []).forEach(p => (p.emps || []).forEach(e => { empStatusMap[String(e.employeeId)] = e.empStatus; }));
  const prof = {}, byStore = {};
  Object.keys(dm).forEach(eid => {
    const rec = dm[eid] || {};
    const maps = rec.maps || [];
    const progOf = m => { const n = parseFloat(m.progress); return isNaN(n) ? 0 : n; };
    const mAvg = maps.length ? maps.reduce((a, m) => a + progOf(m), 0) / maps.length : null;
    // 跨计划任务聚合
    const pls = [];
    (DATA.plans || []).forEach(p => {
      if (p.fetchError) return;
      const det = p.empDetails && p.empDetails[String(eid)];
      if (det) pls.push({ plan: p, det });
    });
    pls.sort((a, b) => (b.plan.startDate || "").localeCompare(a.plan.startDate || ""));
    // 统计口径同看板（9/19 用户拍板）：「其他」分类直接删除——统计与展示均不含
    const stPls = pls.filter(x => (x.plan.category || "其他") !== "其他");
    const pDone = stPls.reduce((a, x) => a + x.det.done, 0), pTotal = stPls.reduce((a, x) => a + x.det.total, 0);
    // 地图任务级统计（汇总进度口径：地图已完成任务/地图任务总数）
    let mDone = 0, mTotal = 0;
    maps.forEach(m => (m.stages || []).forEach(sg => (sg.tasks || []).forEach(tk => { mTotal++; if (String(tk.status) === "3") mDone++; })));
    const sRate = (pTotal + mTotal) ? (pDone + mDone) / (pTotal + mTotal) * 100 : null;
    const st = rec.store || "无门店";
    prof[eid] = {
      name: rec.name || ("#" + eid), store: st, position: rec.position || "", role: rec.role || "",
      empStatus: empStatusMap[eid] || "zc",
      plans: pls, pDone, pTotal, pRate: pTotal ? pDone / pTotal * 100 : null,
      maps, mAvg, mDone, mTotal, sRate,
    };
    (byStore[st] = byStore[st] || []).push(eid);
  });
  const emps = Object.keys(prof);
  // 门店排序：人数多的在前
  const stores = Object.keys(byStore).sort((a, b) => byStore[b].length - byStore[a].length);
  window.__directIdx = { emps, byStore, stores, prof };
  return window.__directIdx;
}
function renderDirect() {
  const el = document.getElementById("main");
  const idx = directIndex();
  if (!idx.emps.length) {
    el.innerHTML = `<div class="sec"><h3>直营学习明细</h3><div class="empty">暂无直营组地图明细数据，请更新后查看（fetch_study.py 新增 directMaps 抓取）</div></div>`;
    return;
  }
  // 汇总
  let tD = 0, tT = 0, mSum = 0, mN = 0, sD = 0, sT = 0;
  idx.emps.forEach(eid => {
    const P = idx.prof[eid];
    tD += P.pDone; tT += P.pTotal;
    sD += P.pDone + P.mDone; sT += P.pTotal + P.mTotal;
    if (P.mAvg != null) { mSum += P.mAvg * P.maps.length; mN += P.maps.length; }
  });
  const rate = tT ? tD / tT * 100 : 0, mAvg = mN ? mSum / mN : 0, sRateAll = sT ? sD / sT * 100 : 0;
  const storeCards = idx.stores.map(st => {
    const eids = idx.byStore[st];
    let d = 0, t = 0, ms = 0, mn = 0, sd = 0, st2 = 0;
    eids.forEach(eid => {
      const P = idx.prof[eid];
      d += P.pDone; t += P.pTotal;
      sd += P.pDone + P.mDone; st2 += P.pTotal + P.mTotal;
      if (P.mAvg != null) { ms += P.mAvg * P.maps.length; mn += P.maps.length; }
    });
    const r = t ? d / t * 100 : 0, ma = mn ? ms / mn : 0, sr = st2 ? sd / st2 * 100 : 0;
    return `<div class="card" style="cursor:pointer" onclick="openDirectStore('${esc(st).replace(/'/g, "\\'")}')">
      <div class="k">${esc(st)}</div>
      <div class="v">${eids.length}<small> 人</small></div>
      <div style="font-size:12px;color:var(--t2);margin-top:6px">任务完成率 ${dBar(r)}</div>
      <div style="font-size:12px;color:var(--t2)">地图进度 ${dBar(ma)}</div>
      <div style="font-size:12px;color:var(--t2)">汇总进度 ${dBar(sr)}</div>
    </div>`;
  }).join("");
  el.innerHTML = `
    <div class="sec">
      <h3>直营学习明细（培训组-直营组）<button class="btn directShareBtn" style="margin-left:auto;padding:6px 14px;font-size:12px" onclick="openShareOverlay('direct')">🔗 分享本页（门店自查链接）</button></h3>
      <div style="font-size:12px;color:var(--t2);margin:-4px 0 10px">
        口径：学习率 = 课程已完成项目 ÷ 课程应完成项目（免修任务剔除；无关紧要的「其他」分类已删除不展示）· 学习地图为平台完成进度 · 任务形态分 视频/文件/考试/实操（上传作业），无则显示 —
      </div>
      <div class="cards">
        <div class="card"><div class="k">直营门店</div><div class="v">${idx.stores.length}<small> 家</small></div></div>
        <div class="card"><div class="k">直营伙伴</div><div class="v">${idx.emps.length}<small> 人</small></div></div>
        <div class="card"><div class="k">任务完成率</div><div class="v" style="color:${dRateCol(rate)}">${rate.toFixed(1)}<small>%</small></div><div style="font-size:12px;color:var(--t2);margin-top:4px">${tD} / ${tT} 项</div></div>
        <div class="card"><div class="k">地图平均进度</div><div class="v" style="color:${dRateCol(mAvg)}">${mAvg.toFixed(1)}<small>%</small></div><div style="font-size:12px;color:var(--t2);margin-top:4px">共 ${mN} 张地图在学</div></div>
        <div class="card"><div class="k">汇总进度</div><div class="v" style="color:${dRateCol(sRateAll)}">${sRateAll.toFixed(1)}<small>%</small></div><div style="font-size:12px;color:var(--t2);margin-top:4px">${sD} / ${sT} 项（任务+地图）</div></div>
      </div>
      <div class="cards" style="margin-top:10px">${storeCards}</div>
    </div>`;
}
/* 门店弹窗：该店伙伴列表 + 岗位/状态筛选 */
function directSetPos(v) { state.dPos = v; renderDirectStoreModal(); }
function directSetSt(v) { state.dEmpStatus2 = v; renderDirectStoreModal(); }
function openDirectStore(store) {
  state.dStore = store; state.dPos = "全部"; state.dEmpStatus2 = "全部";
  window.__directBack = "store";
  document.getElementById("mTitle").textContent = store + " · 伙伴学习明细";
  renderDirectStoreModal();
  document.getElementById("mask").classList.add("show");
}
function renderDirectStoreModal() {
  const idx = directIndex();
  const store = state.dStore;
  const eids = (idx.byStore[store] || []).slice();
  const positions = [...new Set(eids.map(eid => idx.prof[eid].position).filter(Boolean))].sort();
  let list = eids.filter(eid => {
    const P = idx.prof[eid];
    if (state.dPos !== "全部" && P.position !== state.dPos) return false;
    if (state.dEmpStatus2 === "在职" && P.empStatus !== "zc") return false;
    if (state.dEmpStatus2 === "离职" && P.empStatus === "zc") return false;
    return true;
  });
  // 排序：地图进度高的在前
  list.sort((a, b) => (idx.prof[b].mAvg || 0) - (idx.prof[a].mAvg || 0));
  const rows = list.map(eid => {
    const P = idx.prof[eid];
    const st = P.empStatus === "zc" ? `<span class="badge b-green">在职</span>` : `<span class="badge b-gray">离职</span>`;
    return `<tr style="cursor:pointer" onclick="openDirectEmp('${eid}')">
      <td><b>${esc(P.name)}</b></td><td>${esc(P.position || "—")}</td>
      <td>${P.pRate == null ? "—" : dBar(P.pRate)} <span style="color:var(--t2);font-size:12px">${P.pDone}/${P.pTotal}</span></td>
      <td>${P.mAvg == null ? "—" : dBar(P.mAvg)} <span style="color:var(--t2);font-size:12px">${P.maps.length} 张</span></td>
      <td>${P.sRate == null ? "—" : dBar(P.sRate)} <span style="color:var(--t2);font-size:12px">${P.pDone + P.mDone}/${P.pTotal + P.mTotal}</span></td>
      <td>${st}</td>
      <td><span style="color:#186BEB">明细 ›</span></td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">无符合筛选条件的伙伴</td></tr>`;
  const sel = (opts, cur, fn) => `<select onchange="${fn}(this.value)" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px">
    ${opts.map(o => `<option value="${esc(o)}" ${cur === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  document.getElementById("mBody").innerHTML = `
    <div class="filters">
      ${sel(["全部", ...positions], state.dPos, "directSetPos")}
      ${sel(["在职", "全部", "离职"], state.dEmpStatus2 || "在职", "directSetSt")}
      <span style="font-size:12px;color:var(--t2)">共 ${list.length} 人 · 点击行看学习档案</span>
      <button class="btn" style="padding:5px 14px;font-size:12px;margin-left:auto" onclick="sharePng('modal')">🖼 图片</button>
    </div>
    <table>
      <tr><th>姓名</th><th>岗位</th><th>任务完成率（已完成/应完成）</th><th>地图平均进度</th><th>汇总进度（任务+地图）</th><th>状态</th><th></th></tr>
      ${rows}
    </table>`;
}
/* 伙伴档案弹窗：二级导航分类展示（汇总 / 学习任务 / 学习地图） */
function dSetForm(v) { state.dForm = v; renderDirectEmpModal(); }
function dSetEmpTab(v) { state.dEmpTab = v; renderDirectEmpModal(); }
function dSetCat(v) { state.dCat = v; renderDirectEmpModal(); }
function openDirectEmp(eid) {
  state.dEmp = String(eid); state.dForm = "全部"; state.dEmpTab = "sum"; state.dCat = "全部";
  window.__directBack = "emp";
  document.getElementById("mTitle").textContent = (directIndex().prof[String(eid)] || {}).name + " · 学习档案";
  renderDirectEmpModal();
  document.getElementById("mask").classList.add("show");
}
// 任务形态筛选：全匹配（全部）/只看该形态（含未完成）
function dTaskPass(t) {
  if (state.dForm === "全部") return true;
  return dFormOf(t[1]) === state.dForm;
}
function renderDirectEmpModal() {
  const idx = directIndex();
  const P = idx.prof[state.dEmp];
  if (!P) return;
  // ① 汇总：分分类（空壳 total=0 不计；「其他」分类不统计，口径同看板）
  const byCat = {};
  P.plans.forEach(({ plan, det }) => {
    if (!det.total || (plan.category || "其他") === "其他") return;
    const c = plan.category || "其他";
    byCat[c] = byCat[c] || { d: 0, t: 0 };
    byCat[c].d += det.done; byCat[c].t += det.total;
  });
  const catChips = Object.entries(byCat).map(([c, v]) =>
    `<div class="card" style="min-width:150px"><div class="k">${esc(c)}</div><div class="v" style="font-size:20px;color:${v.t ? dRateCol(v.d / v.t * 100) : "inherit"}">${v.t ? (v.d / v.t * 100).toFixed(1) : "—"}<small>%</small></div><div style="font-size:12px;color:var(--t2)">${v.d}/${v.t} 项</div></div>`).join("");
  const mDone = P.maps.filter(m => parseFloat(m.progress) >= 100).length;
  const back = `<button class="btn" style="padding:6px 12px;font-size:12px;background:var(--navy)" onclick="openDirectStore('${esc(P.store).replace(/'/g, "\\'")}')">← 返回门店</button>`;
  // ② 学习任务：按计划分组（形态四列）
  const formBar = `<div class="filters">${["全部", ...D_FORMS].map(f =>
    `<button class="${(state.dForm || "全部") === f ? "active" : ""}" onclick="dSetForm('${f}')">${f}${f === "全部" ? "" : "（含未完成）"}</button>`).join("")}</div>`;
  const planCard = ({ plan, det }) => {
    const rows = [];
    (det.stages || []).forEach(st => {
      (st.t || []).filter(dTaskPass).forEach(t => {
        const done = t[2] === "W";
        const graded = t[1] === 4 || t[1] === 5;
        rows.push(`<tr>
          <td style="color:var(--t2);font-size:12px;white-space:nowrap">${esc(st.n || "")}</td>
          <td>${esc(t[0])}</td>
          ${D_FORMS.map(f => `<td style="text-align:center">${dFormCell(f, t[1], done)}</td>`).join("")}
          <td>${esc(dTypeName(t[1]))}</td>
          <td>${done ? `<span style="color:#1aad19;font-weight:600">已完成</span>` : `<span style="color:#e64340;font-weight:600">未完成</span>`}</td>
          <td>${graded ? scoreCell(t) : (t[3] != null && t[3] !== "-" ? esc(t[3]) : "—")}</td>
          <td style="color:var(--t2);font-size:12px;white-space:nowrap">${t[5] && t[5] !== "-" ? esc(String(t[5]).slice(0, 16)) : "—"}</td>
        </tr>`);
      });
    });
    if (!rows.length) return null;
    const head = `<tr><th>阶段</th><th>任务</th>${D_FORMS.map(f => `<th style="text-align:center">${f}</th>`).join("")}<th>类型</th><th>状态</th><th>分数</th><th>完成时间</th></tr>`;
    const openAttr = det.done < det.total ? " open" : "";
    return `<details${openAttr} style="margin-bottom:8px">
      <summary style="cursor:pointer;font-weight:600;padding:6px 0">${esc(plan.planName)} <span style="color:var(--t2);font-weight:400;font-size:12px">（${plan.startDate || "—"}）</span>
        <span style="float:right;font-size:12px;color:var(--t2)">${det.done}/${det.total} 项 ${dBar(det.total ? det.done / det.total * 100 : 0)}</span></summary>
      <div style="overflow:auto"><table>${head}${rows.join("")}</table></div>
    </details>`;
  };
  // 分类子导航：课程按看板分类划分（9/19 用户拍板：学习任务内部再分类；「其他」直接删除不展示）
  // 计数口径=有效计划（有任务明细行的），与渲染严格一致（空壳计划不计数不显示）
  const rendered = P.plans.map(info => ({ cat: info.plan.category || "其他", html: planCard(info) })).filter(r => r.html && r.cat !== "其他");
  const validOf = c => rendered.filter(r => r.cat === c);
  const allValid = rendered;
  const empCats = [...new Set(allValid.map(r => r.cat))];
  const catsOrdered = [...(DATA.categories || []).filter(c => empCats.includes(c)), ...empCats.filter(c => !(DATA.categories || []).includes(c))];
  const catJs = c => esc(c).replace(/'/g, "\\'");
  const curCat = state.dCat || "全部";
  const catBar = `<div class="filters" style="margin-bottom:8px">${["全部", ...catsOrdered].map(c =>
    `<button class="${curCat === c ? "active" : ""}" onclick="dSetCat('${catJs(c)}')">${esc(c)}（${c === "全部" ? allValid.length : validOf(c).length}）</button>`).join("")}</div>`;
  let planBlocks;
  if (curCat === "全部") {
    planBlocks = catsOrdered.map(c => {
      const cards = validOf(c).map(r => r.html).join("");
      if (!cards) return "";
      return `<div style="margin-bottom:14px">
        <div style="font-weight:700;font-size:13px;margin:2px 0 8px;padding:2px 0 2px 8px;border-left:3px solid var(--blue)">${esc(c)} <span style="color:var(--t2);font-weight:400;font-size:12px">· ${validOf(c).length} 个计划</span></div>
        ${cards}</div>`;
    }).join("") || `<div class="empty">该伙伴暂无培训计划任务记录</div>`;
  } else {
    planBlocks = validOf(curCat).map(r => r.html).join("") || `<div class="empty">该分类下暂无培训计划</div>`;
  }
  // ③ 学习地图
  const mapBlocks = P.maps.map(m => {
    const prog = parseFloat(m.progress) || 0;
    const rows = [];
    (m.stages || []).forEach(st => {
      (st.tasks || []).filter(tk => state.dForm === "全部" || dMapFormOf(tk.taskType) === state.dForm).forEach(tk => {
        const done = String(tk.status) === "3";
        rows.push(`<tr>
          <td style="color:var(--t2);font-size:12px;white-space:nowrap">${esc(st.stageName || "")}</td>
          <td>${esc(tk.taskName || "")}</td>
          ${D_FORMS.map(f => `<td style="text-align:center">${dMapFormCell(f, tk.taskType, done)}</td>`).join("")}
          <td>${esc(dMapTypeName(tk.taskType))}</td>
          <td>${done ? `<span style="color:#1aad19;font-weight:600">已完成</span>` : String(tk.status) === "2" ? `<span style="color:#e69119;font-weight:600">进行中</span>` : `<span style="color:#e64340;font-weight:600">未开始</span>`}</td>
          <td>${tk.realScore != null && tk.realScore !== "-" ? esc(String(tk.realScore)) : "—"}</td>
          <td style="color:var(--t2);font-size:12px;white-space:nowrap">${tk.finishTime && tk.finishTime !== "-" ? esc(String(tk.finishTime).slice(0, 16)) : "—"}</td>
        </tr>`);
      });
    });
    const head = `<tr><th>阶段</th><th>任务</th>${D_FORMS.map(f => `<th style="text-align:center">${f}</th>`).join("")}<th>类型</th><th>状态</th><th>分数</th><th>完成时间</th></tr>`;
    const st2 = prog >= 100 ? ["已完成", "b-green"] : prog > 0 ? ["进行中", "b-orange"] : ["未开始", "b-gray"];
    return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b>${esc(m.mapName || "")}</b><span class="badge ${st2[1]}">${st2[0]}</span>
        <span style="margin-left:auto;font-size:12px;color:var(--t2)">当前阶段：${esc(m.stageName || "—")}</span>
        <span style="min-width:160px">${dBar(prog)}</span>
      </div>
      ${rows.length ? `<div style="overflow:auto;margin-top:8px"><table>${head}${rows.join("")}</table></div>` : `<div class="empty" style="padding:6px 0">该地图暂无阶段任务明细</div>`}
    </div>`;
  }).join("") || `<div class="empty">该伙伴暂未加入任何学习地图</div>`;
  // ---- 二级导航：汇总 / 学习任务 / 学习地图 分类展示 ----
  const tabDefs = [
    ["sum", "汇总", ""],
    ["task", "学习任务", allValid.length ? `${allValid.length} 个计划` : ""],
    ["map", "学习地图", P.maps.length ? `${P.maps.length} 张` : ""],
  ];
  const tabBar = `<div style="display:flex;gap:6px;background:var(--card);border:1px solid var(--line);padding:6px;border-radius:10px;margin-bottom:12px;position:sticky;top:-17px;z-index:5">
    ${tabDefs.map(([k, lb, bd]) => {
      const on = (state.dEmpTab || "sum") === k;
      return `<button onclick="dSetEmpTab('${k}')" style="border:none;flex:1;background:${on ? "var(--blue)" : "transparent"};color:${on ? "#fff" : "var(--t2)"};padding:9px 10px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">${lb}${bd ? `<span style="font-size:11px;opacity:.8;margin-left:4px">${bd}</span>` : ""}</button>`;
    }).join("")}
  </div>`;
  const sumPanel = `
    <div class="cards">
      <div class="card" style="min-width:150px"><div class="k">全部任务</div><div class="v" style="font-size:20px;color:${dRateCol(P.pRate)}">${P.pRate == null ? "—" : P.pRate.toFixed(1)}<small>%</small></div><div style="font-size:12px;color:var(--t2)">${P.pDone}/${P.pTotal} 项</div></div>
      ${catChips}
      <div class="card" style="min-width:150px"><div class="k">学习地图</div><div class="v" style="font-size:20px;color:${dRateCol(P.mAvg)}">${P.mAvg == null ? "—" : P.mAvg.toFixed(1)}<small>%</small></div><div style="font-size:12px;color:var(--t2)">${P.maps.length} 张（完成 ${mDone}）</div></div>
      <div class="card" style="min-width:150px"><div class="k">汇总进度</div><div class="v" style="font-size:20px;color:${dRateCol(P.sRate)}">${P.sRate == null ? "—" : P.sRate.toFixed(1)}<small>%</small></div><div style="font-size:12px;color:var(--t2)">${P.pDone + P.mDone}/${P.pTotal + P.mTotal} 项（任务+地图）</div></div>
    </div>
    <div style="font-size:12px;color:var(--t2);margin-top:10px">口径：任务口径 = 已完成/应完成项目（免修剔除；「其他」分类已删除不展示）· 学习地图为平台完成进度 · 明细请在上方导航切换「学习任务」「学习地图」查看</div>`;
  const taskPanel = `
    <div style="font-size:12px;color:var(--t2);margin-bottom:8px">线上线下 / 各组派发的培训计划 · 按看板分类划分 · 点击计划名展开任务明细</div>
    ${catBar}
    ${formBar}
    ${planBlocks}`;
  const mapPanel = `
    <div style="font-size:12px;color:var(--t2);margin-bottom:8px">平台学习地图 · 按阶段展示任务明细</div>
    ${formBar}
    ${mapBlocks}`;
  const panels = { sum: sumPanel, task: taskPanel, map: mapPanel };
  document.getElementById("mBody").innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">${back}
      <span style="font-size:13px;color:var(--t2)">${esc(P.store)} · ${esc(P.position || "")} ${P.role ? "· " + esc(P.role) : ""}</span>
      <button class="btn" style="padding:5px 14px;font-size:12px;margin-left:auto" onclick="sharePng('modal')">🖼 图片</button></div>
    ${tabBar}
    ${panels[state.dEmpTab || "sum"]}`;
}

/* ---------- 主渲染 ---------- */
function render() {
  // 隐藏平台上还没有数据的分类（学员/门店全空，如"裂变加盟商培训"配置好后会自动出现）
  const visibleCats = DATA.categories.filter(c => {
    const ps = (DATA.plans || []).filter(p => p.category === c);
    return ps.some(p => (p.emps || []).length > 0 || (p.storeStats || []).length > 0);
  });
  // 「其他」分类垫底（用户拍板：直营学习明细排在「其他」前面），其余分类保持原顺序
  const catsSorted = [...visibleCats.filter(c => c !== "其他"), ...(visibleCats.includes("其他") ? ["其他"] : [])];
  const tabs = [["概述", ""], ...catsSorted.map(c => [c, ""]), ["直营学习明细", ""], ["评价管理", ""], ["离职管理档案", ""]];
  document.getElementById("mainTabs").innerHTML = tabs.map(([t]) => {
    let n;
    if (t === "概述" || t === "评价管理" || t === "离职管理档案") n = "";
    else if (t === "直营学习明细") n = `<span class="n">${(window.__directIdx || directIndex()).emps.length}</span>`;
    else n = `<span class="n">${plansInRange(t).length}</span>`;
    return `<button class="${state.tab === t ? "active" : ""}" onclick="state.tab='${t}';state.planIdx=0;render()">${t}${n}</button>`;
  }).join("");
  if (!tabs.some(([t]) => t === state.tab)) { state.tab = "概述"; state.planIdx = 0; }
  if (state.tab === "概述") renderOverview();
  else if (state.tab === "评价管理") renderEval();
  else if (state.tab === "离职管理档案") renderResign();
  else if (state.tab === "公开课学习") renderOpen();
  else if (state.tab === "员工培训/晋升") renderPromo();
  else if (state.tab === "直营学习明细") renderDirect();
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
  if (typeof applyShareView === "function") applyShareView();
  hydrateCatOv(); // 拉取落盘的分类覆盖，防止 localStorage 被清/换源后丢失
}).catch(e => {
  document.getElementById("main").innerHTML = `<div class="sec empty">数据加载失败：${esc(e)}<br>请先运行 fetch_study.py，并用「启动看板.bat」打开</div>`;
});

/* ---------- 分享链接（参考巡店看板 fix134 逻辑） ---------- */
function b64uEnc(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function b64uDec(s){ s = String(s).replace(/-/g,"+").replace(/_/g,"/"); while(s.length % 4) s += "="; try{ return decodeURIComponent(escape(atob(s))); }catch(e){ return ""; } }
const SHARE_BASE_KEYS = ["tab","planIdx","sub","range","rFrom","rTo","gFilter","promoSub","promoMapIdx","promoSince","pRegion","pGroup","pStore","evalSub","storeSearch"];
const SHARE_MODAL_KEYS = SHARE_BASE_KEYS.concat(["dStatus","stageKey","dGroups","dRegions"]);
function shareSnap(mod){
  const keys = mod ? SHARE_MODAL_KEYS : SHARE_BASE_KEYS;
  const o = {};
  keys.forEach(k => o[k] = state[k]);
  return o;
}
window.openShareOverlay = function(mod){
  let st;
  if (mod === "agg" && window.__aggShare) {
    st = shareSnap("modal");
    st.m = "agg"; st.kind = __aggShare.kind;
    if (__aggShare.kind === "agg") { st.label = __aggShare.label; st.nameEnc = __aggShare.nameEnc; }
    else st.storeId = __aggShare.storeId;
    st.aggFilter = (typeof aggFilter !== "undefined") ? aggFilter : "全部";
  } else if (mod === "stage" && state.stageKey) {
    st = shareSnap("modal"); st.m = "stage";
  } else if (mod === "direct") {
    // 直营学习明细独立单页：打开只见这一页，页内钻取/筛选可用，数据随看板自动同步
    st = shareSnap(); st.tab = "直营学习明细"; st.solo = "direct";
  } else {
    st = shareSnap();
  }
  const url = location.origin + location.pathname + "#s=" + b64uEnc(JSON.stringify(st));
  let ov = document.getElementById("shareOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "shareOverlay";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px";
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
  }
  const isModal = !!st.m;
  const hint = isModal ? "对方打开后仅看到这个弹窗的学习明细（只读）"
    : st.solo === "direct" ? "对方打开后只看到「直营学习明细」单页，可点击门店/伙伴逐层查询，数据随看板自动更新"
    : "对方打开后直接落到当前页签/筛选的视图";
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:560px;width:100%;padding:18px 20px" onclick="event.stopPropagation()">
      <div style="font-size:15px;font-weight:700;color:#1A2A4A;margin-bottom:6px">🔗 分享链接已生成</div>
      <div style="font-size:12px;color:#7a8399;margin-bottom:10px">${hint}</div>
      <textarea id="shareUrlBox" readonly style="width:100%;height:72px;border:1px solid #e3e6ee;border-radius:8px;padding:8px;font-size:12px;color:#1A2A4A;resize:none">${url}</textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button id="shareCopyBtn" style="background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">复制链接</button>
        <button onclick="document.getElementById('shareOverlay').remove()" style="background:#f0f2f7;color:#1A2A4A;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">关闭</button>
      </div>
    </div>`;
  const box = ov.querySelector("#shareUrlBox");
  box.onclick = () => box.select();
  ov.querySelector("#shareCopyBtn").onclick = () => {
    box.select(); box.setSelectionRange(0, url.length);
    let done = false;
    try{ done = document.execCommand("copy"); }catch(e){}
    if (!done && navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(()=>{},()=>{}); done = true; }
    const btn = ov.querySelector("#shareCopyBtn");
    btn.textContent = done ? "✅ 已复制" : "请手动 Ctrl+C 复制";
    setTimeout(() => { btn.textContent = "复制链接"; }, 2000);
  };
  setTimeout(() => box.select(), 50);
};
function readShareHash(){
  const m = (location.hash || "").match(/[#&]s=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  try { const o = JSON.parse(b64uDec(m[1])); return (o && o.tab !== undefined) ? o : null; } catch(e){ return null; }
}
function showShareRoBar(){
  if (document.getElementById("shareRoBar")) return;
  document.body.insertAdjacentHTML("beforeend",
    '<div id="shareRoBar" style="position:fixed;left:0;right:0;bottom:0;background:#1A2A4A;color:#fff;padding:7px 16px;font-size:12px;text-align:center;z-index:99998">📖 只读分享视图 · 由他人通过分享链接打开</div>');
}
function applyShareView(){
  const o = readShareHash();
  if (!o) return;
  SHARE_MODAL_KEYS.forEach(k => { if (o[k] !== undefined) state[k] = o[k]; });
  // 还原区间筛选控件状态
  document.querySelectorAll("#rangeBar button").forEach(b => b.classList.toggle("active", b.dataset.r === state.range));
  const rf = document.getElementById("rFrom"), rt = document.getElementById("rTo");
  if (state.range === "区间") { if (rf) rf.value = state.rFrom || ""; if (rt) rt.value = state.rTo || ""; }
  if (o.aggFilter) { try { aggFilter = o.aggFilter; } catch(e){} }
  // 弹窗级分享：隐藏页面全部背景，只显示弹窗本体（参考巡店看板独占模式）
  if (o.m) {
    if (!document.getElementById("shareSoloStyle")) {
      const st2 = document.createElement("style");
      st2.id = "shareSoloStyle";
      st2.textContent = "body.share-solo>header,body.share-solo #mainTabs,body.share-solo #main,body.share-solo #promoBar{display:none!important}body.share-solo{overflow:hidden}";
      document.head.appendChild(st2);
    }
    document.body.classList.add("share-solo");
  }
  // 独立单页分享（直营学习明细）：隐藏顶栏/页签/二级条，只留这一页，页内钻取全部可用
  if (o.solo === "direct") {
    state.tab = "直营学习明细";
    if (!document.getElementById("shareSoloPageStyle")) {
      const st3 = document.createElement("style");
      st3.id = "shareSoloPageStyle";
      st3.textContent = "body.share-solo-page>header,body.share-solo-page #mainTabs,body.share-solo-page #promoBar,body.share-solo-page .directShareBtn{display:none!important}body.share-solo-page #main{padding-top:22px}";
      document.head.appendChild(st3);
    }
    document.body.classList.add("share-solo-page");
    // 数据随看板同步：每5分钟静默拉一次，generatedAt 变了就热替换重绘（不打断当前浏览）
    if (!window.__soloRefresh) {
      window.__soloRefresh = setInterval(async () => {
        try {
          const d = await (await fetch("data/data.json?v=" + Date.now(), { cache: "no-store" })).json();
          if (d.generatedAt !== DATA.generatedAt) { DATA = d; render(); }
        } catch (e) {}
      }, 5 * 60 * 1000);
    }
  }
  render();
  showShareRoBar();
  // 弹窗级分享：还原对应弹窗
  if (o.m === "agg") {
    try {
      if (o.kind === "store") openStore(o.storeId);
      else openAgg(o.label, o.nameEnc, true);
    } catch(e){ console.warn("agg share replay failed", e); }
  } else if (o.m === "stage" && o.stageKey) {
    try { openStage(o.stageKey); } catch(e){ console.warn("stage share replay failed", e); }
  }
  if (o.m) {
    // 弹窗遮罩改为不透明全屏，看不到也点不到弹窗以外内容
    setTimeout(() => {
      const mask = document.getElementById("mask");
      if (mask && mask.classList.contains("show")) {
        mask.style.background = "#f2f4f8";
        const box = mask.querySelector(".modal");
        if (box) { box.style.maxWidth = "100%"; box.style.width = "100%"; box.style.height = "100vh"; box.style.maxHeight = "100vh"; box.style.borderRadius = "0"; box.style.margin = "0"; }
      }
    }, 100);
  }
}

/* ---------- 分享PNG图片：渲染当前页面/弹窗为图片，复制到剪贴板直接粘贴发送 ---------- */
window._loadHtml2canvas = function () {
  if (window.html2canvas) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    // 本地内置文件优先（jsdelivr 国内经常连不上），失败再兜底 CDN
    s.src = "html2canvas.min.js?v=84";
    s.onload = res;
    s.onerror = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      s2.onload = res; s2.onerror = () => rej(new Error("html2canvas 加载失败"));
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
};
window.sharePng = async function (mode) {
  // 提示浮层（进度/成功/失败/兜底预览共用）
  const showTip = (html, sticky) => {
    let ov = document.getElementById("pngShareTip");
    if (!ov) { ov = document.createElement("div"); ov.id = "pngShareTip"; ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px"; document.body.appendChild(ov); }
    ov.onclick = e => { if (e.target === ov && !sticky) ov.remove(); };
    ov.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:640px;width:100%;padding:18px 20px;max-height:90vh;overflow:auto" onclick="event.stopPropagation()">${html}</div>`;
    return ov;
  };
  showTip('<div style="font-size:14px;color:#1A2A4A">⏳ 正在生成图片，请稍候…</div>');
  try {
    await window._loadHtml2canvas();
    const modal = document.getElementById("mask");
    const isModal = mode === "modal" && modal && modal.classList.contains("show");
    let restore = null;
    let target;
    if (mode === "all") {
      // 全部大表快照：只截表格本体，临时放开横向滚动让整表全部渲染
      const box = document.getElementById("allSecBody");
      target = box;
      if (box) {
        const tbl = box.querySelector("table");
        const old = { ow: box.style.overflow, w: tbl && tbl.style.width };
        box.style.overflow = "visible";
        if (tbl) tbl.style.width = Math.max(tbl.scrollWidth, box.scrollWidth) + "px";
        restore = () => { box.style.overflow = old.ow; if (tbl) tbl.style.width = old.w; };
      }
    } else {
      target = isModal ? modal.querySelector(".modal") : document.body;
      if (isModal && target) {
        // 临时解除弹窗限高与内部滚动（限高在 .modal 上，不在遮罩上），让整张表全部渲染，截完还原
        const mb = target.querySelector(".mbody");
        const oldM = target.style.maxHeight, oldO = target.style.overflow, oldB = mb ? mb.style.overflow : "";
        target.style.maxHeight = "none"; target.style.overflow = "visible";
        if (mb) mb.style.overflow = "visible";
        // html2canvas 对 position:fixed 祖先内的元素会按视口高度裁剪 → 截图瞬间把遮罩改为 static
        const oldPos = modal.style.position, oldPad = modal.style.padding, oldOv = modal.style.overflow;
        modal.style.position = "static"; modal.style.padding = "0"; modal.style.overflow = "visible";
        restore = () => { target.style.maxHeight = oldM; target.style.overflow = oldO; if (mb) mb.style.overflow = oldB; modal.style.position = oldPos; modal.style.padding = oldPad; modal.style.overflow = oldOv; };
      }
    }
    const title = mode === "all"
      ? (((plansInRange(state.cat)[state.planIdx] || {}).planName || "学习看板") + " · 全体学习明细")
      : isModal ? ((modal.querySelector(".mhead h3") || {}).textContent || "学习明细") : ((document.querySelector("header h1") || {}).textContent || "学习看板");
    const canvas = await html2canvas(target, {
      useCORS: true, backgroundColor: "#f2f4f8", scale: 2, logging: false,
      width: target.scrollWidth || undefined, height: target.scrollHeight || undefined,
      windowWidth: target.scrollWidth || undefined, windowHeight: target.scrollHeight || undefined,
      scrollX: 0, scrollY: 0,
      ignoreElements: el => ["shareOverlay", "pngShareTip", "shareRoBar"].includes(el.id)
    });
    if (restore) restore();
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    // 优先复制到剪贴板：微信/聊天窗口直接 Ctrl+V 发送
    let copied = false;
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch (e) {}
    const dataUrl = canvas.toDataURL("image/png");
    const fname = title.replace(/[\\/:*?"<>|]/g, "").trim() + ".png";
    if (copied) {
      showTip(`<div style="font-size:15px;font-weight:700;color:#1A2A4A;margin-bottom:6px">✅ 图片已复制</div>
        <div style="font-size:12px;color:#7a8399;margin-bottom:10px">直接到微信/企微聊天窗口 <b>Ctrl+V 粘贴</b>即可发送，无需保存文件。</div>
        <img src="${dataUrl}" style="width:100%;border:1px solid #e3e6ee;border-radius:8px">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <a download="${fname}" href="${dataUrl}" style="background:#f0f2f7;color:#1A2A4A;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px;text-decoration:none">下载文件</a>
          <button onclick="document.getElementById('pngShareTip').remove()" style="background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">完成</button>
        </div>`, true);
    } else {
      const tryCopy = async () => {
        let ok = false;
        try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); ok = true; } catch (e) {}
        const btn = document.getElementById("pngCopyBtn");
        if (btn) btn.textContent = ok ? "✅ 已复制，去聊天窗口粘贴" : "复制失败，请长按图片保存/转发";
        if (ok) setTimeout(() => { const t = document.getElementById("pngShareTip"); if (t) t.remove(); }, 1500);
      };
      let canShare = false;
      try { canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], fname, { type: "image/png" })] })); } catch (e) {}
      showTip(`<div style="font-size:15px;font-weight:700;color:#1A2A4A;margin-bottom:6px">🖼 图片已生成</div>
        <div style="font-size:12px;color:#7a8399;margin-bottom:10px">浏览器未自动复制。可点「复制图片」重试；手机上推荐「转发/分享」直接调起微信发送，或长按图片保存后转发。</div>
        <img src="${dataUrl}" style="width:100%;border:1px solid #e3e6ee;border-radius:8px">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
          <button id="pngCopyBtn" onclick="_pngCopyRetry()" style="background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">复制图片</button>
          ${canShare ? `<button onclick="_pngShareRetry()" style="background:#07c160;color:#fff;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">转发/分享</button>` : ""}
          <a download="${fname}" href="${dataUrl}" style="background:#2f6fed;color:#fff;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px;text-decoration:none">下载文件</a>
          <button onclick="document.getElementById('pngShareTip').remove()" style="background:#f0f2f7;color:#1A2A4A;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">关闭</button>
        </div>`, true);
      window._pngCopyRetry = tryCopy;
      window._pngShareRetry = async () => {
        try {
          const file = new File([blob], fname, { type: "image/png" });
          await navigator.share({ files: [file], title: title });
        } catch (e) {}
      };
    }
  } catch (e) {
    if (typeof restore === "function") { try { restore(); } catch (_e) {} }
    showTip(`<div style="font-size:15px;font-weight:700;color:#e64340;margin-bottom:6px">生成失败</div><div style="font-size:12px;color:#7a8399">${esc(String(e && e.message || e))}<br>可改用「🔗 分享」按钮发链接。</div>
      <div style="display:flex;justify-content:flex-end;margin-top:10px"><button onclick="document.getElementById('pngShareTip').remove()" style="background:#f0f2f7;color:#1A2A4A;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-size:13px">关闭</button></div>`, true);
  }
};
