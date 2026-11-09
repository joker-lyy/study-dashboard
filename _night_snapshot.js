// 【学习看板】22:20 夜间快照（2026-09-25 Rain 拍板终版）
//   ① 新加盟商培训：整期「二级汇总-全部」横版截图一条（逻辑不变）
//   ② 裂变加盟商培训：改为【竖版门店报表】—— 每家门店独立一张图、一条企微消息（发独立群 WEBHOOK_FISSION）
//      表头 = 门店名 / 学习周期(学员加入日~培训结束日) / 学员人数
//      门店归属（9/25 深夜三改定稿）= 按加盟商姓名查飞书「免训不免考跟进（饼干）」表登记的门店名为准
//        （如黄载均→厦门思明五一广场店，该店未开业、不在平台 storeStats）；查不到/查询失败 → 回退「名下最新开店」
//      表格 = 阶段竖排（每阶段 1 行），学员为列；每阶段格内 4 项：
//        · 课程学习 = 课件/文件(1,7,10) + 视频(2,8)，显示 完成数/总数
//        · 考试     = 类型4（备料/军舰/手握/卷类考核），合格 80 分；未考红、<80红、≥80绿、已交未判=待审核黄
//        · 上传作业 = 类型5（传图片/视频，老师审核）；未传完红、待审核黄、全通过绿
//        · 完成时间 = 该阶段全部任务达成（课程W+考试≥80+作业审核通过）的最终时间，未达成显示 —
//   ③ 只在培训期内发：今天不在该培训任何一期 startDate~endDate 内 → 该培训跳过不发
// 由 board_butler.py 在 22:20 定时更新完成后调用（本地文件，不入库；内含 webhook 密钥）
// 手动测试（只在本地产图、不发企微、不占锁）：
//   NODE_PATH=C:/Users/Rain/.workbuddy/binaries/node/workspace/node_modules SNAPSHOT_DRY_RUN=1 ^
//   C:/Users/Rain/.workbuddy/binaries/node/versions/22.22.2-3/node.exe _night_snapshot.js
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=294baa47-bd37-4c35-8921-e09c48864176';
// 裂变加盟商培训日报 → 独立群（2026-09-25 Rain 指定）；新加盟商培训快照与失败告警仍走上面主 webhook
const WEBHOOK_FISSION = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=6e27d0f6-6227-4cfb-9ebf-dc906cd87c36';
const PAGE_URL = 'http://127.0.0.1:8767/index.html';
const DATA_PATH = path.join(__dirname, 'data', 'data.json');
const PREVIEW_DIR = path.join(__dirname, 'data', '_snapshot_preview');
const LOG_PATH = path.join(__dirname, 'data', '_night_snapshot_log.txt');
const LOCK_PATH = path.join(__dirname, 'data', '_night_snapshot.lock');
const DRY = !!process.env.SNAPSHOT_DRY_RUN;

// 飞书「免训不免考跟进（饼干）」表：加盟客户姓名 → 门店名称（2026-09-25 用户定稿的报表归属来源）
// 培训部 base / 表；经 lark-cli --as user 实时读取，查询失败整体回退「名下最新开店」规则
const LARK_CLI = 'C:/Users/Rain/AppData/Roaming/npm/node_modules/@larksuite/cli/bin/lark-cli.exe';
const FS_BASE = 'PnlSbTt8iawLeVs36YIcVs5Sn9g';
const FS_TABLE = 'tblUmTpPTmhMWLGB';

// 两个培训各一份报表；页签名 = 培训名（app.js 一级菜单）
const TRACKS = ['新加盟商培训', '裂变加盟商培训'];
const FISSION_TAB = '裂变加盟商培训';

// 任务类型 → 二级分类（app.js D_FORM 同源：视频(2,8)/文件(1,7,10)/考试(4)/实操上传(5)）
const COURSE_T = new Set([1, 2, 7, 8, 10]);
const EXAM_T = new Set([4]);
const UP_T = new Set([5]);
const PASS_SCORE = 80;

function logB(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
  console.log(line);
}

// 幂等锁：10 分钟内已有实例启动过快照 → 直接退出（防多管家实例并存时重复发图，2026-09-21）
// DRY_RUN 测试模式不占锁，避免影响正式发送
function acquireLock() {
  if (DRY) return true;
  try {
    const st = fs.statSync(LOCK_PATH);
    if (Date.now() - st.mtimeMs < 10 * 60 * 1000) return false;
    fs.unlinkSync(LOCK_PATH);
  } catch (e) { /* 锁不存在 = 可直接拿 */ }
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) { return false; }
}

function sendWecom(bodyStr, webhook) {
  if (DRY) return Promise.resolve({ errcode: 0, dry_run: true });
  return new Promise((resolve, reject) => {
    const u = new URL(webhook || WEBHOOK);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, timeout: 20000,
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('webhook 超时')); });
    req.write(bodyStr);
    req.end();
  });
}

/* ==================== 裂变培训 · 竖版门店报表 ==================== */

function num(v) { return v != null && v !== '' && v !== '-' && !isNaN(+v) ? +v : null; }

// 统一时间显示：YYYY-MM-DD HH:mm
function fmtDT(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 一个学员的一个阶段 → 4 项（课程学习/考试/上传作业/完成时间）
// 2026-11-09 对齐看板「门店学习日报」逐项口径：考试/上传作业逐条列明细（缺考/待审核/分数），不再聚合计数
function stageRow(stage) {
  let cT = 0, cD = 0; const exams = []; const ups = [];
  let uT = 0, uP = 0, uWait = 0;
  let allDone = true; const times = [];
  for (const t of (stage.t || [])) {
    const name = t[0], ty = t[1], stt = t[2], score = num(t[3]), tm = t[5];
    const done = stt === 'W';
    const hasTime = tm && tm !== '-';
    if (EXAM_T.has(ty)) {
      const pass = done && score != null && score >= PASS_SCORE;
      exams.push({ name, stt, score, pass, wait: done && score == null });
      if (pass) { if (hasTime) times.push(tm); } else allDone = false;
    } else if (UP_T.has(ty)) {
      uT++;
      // DYJ/待阅卷 = 已提交待老师打分 → 待审核，不是缺考（对齐 app.js fix 10/27 口径）
      const wait = stt === 'DYJ' || t[4] === '待阅卷' || (done && score == null);
      ups.push({ name, stt, score, done, wait });
      if (done && score != null) { uP++; if (hasTime) times.push(tm); }
      else if (!wait) allDone = false;
    } else { // 课程学习（含未知类型兜底归入课程）
      cT++;
      if (done) { cD++; if (hasTime) times.push(tm); } else allDone = false;
    }
  }
  const finish = allDone && times.length ? times.sort().pop() : null;
  return { name: stage.n || '', cT, cD, exams, ups, uT, uP, uWait, finish };
}

// ── 飞书「免训不免考跟进（饼干）」表：按加盟客户姓名搜登记门店 ──
// record-search 输出为 markdown 表：| _record_id | 门店名称 | 加盟客户姓名 | 试业开始日期 | ...
function larkSearchStoreByName(name) {
  const args = ['base', '+record-search', '--base-token', FS_BASE, '--table-id', FS_TABLE,
    '--json', JSON.stringify({ keyword: name, search_fields: ['加盟客户姓名'], select_fields: ['门店名称', '加盟客户姓名', '试业开始日期'], limit: 10 }),
    '--as', 'user'];
  let r;
  try { r = spawnSync(LARK_CLI, args, { encoding: 'utf8', timeout: 30000 }); }
  catch (e) { return { err: e.message }; }
  if (r.error) return { err: r.error.message };
  if (r.status !== 0) return { err: (String(r.stderr || '') + String(r.stdout || '')).trim().slice(0, 200) || 'exit ' + r.status };
  const lines = String(r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return { rows: [] };
  const head = lines[0].split('|').map(s => s.trim());
  const iStore = head.indexOf('门店名称');
  const iTrial = head.indexOf('试业开始日期');
  if (iStore < 0) return { err: '表头无「门店名称」列' };
  const rows = [];
  for (let i = 2; i < lines.length; i++) { // 第1行=表头、第2行=|---|分隔线
    const c = lines[i].split('|').map(s => s.trim());
    if (!c[iStore] || /^[-\s]*$/.test(c[iStore])) continue;
    rows.push({ store: c[iStore], trial: iTrial >= 0 ? (c[iTrial] || '') : '' });
  }
  return { rows };
}

// 逐学员查飞书 → { ok, map }；map=姓名→门店名。任一次查询失败 → ok:false（调用方整体回退）
function feishuStoreByNames(names) {
  const map = new Map();
  for (const n of names) {
    const res = larkSearchStoreByName(n);
    if (res.err) { logB('!! 飞书「免训不免考跟进」查询失败（' + n + '）：' + res.err); return { ok: false, map }; }
    if (!res.rows.length) continue;
    const pick = res.rows.slice().sort((a, b) => String(a.trial).localeCompare(String(b.trial))).pop(); // 同名多店取试业开始日期最晚
    map.set(n, pick.store);
    logB('[裂变门店报表] 飞书归属：' + n + ' → ' + pick.store +
      (res.rows.length > 1 ? '（' + res.rows.length + ' 条登记，取试业最晚）' : ''));
  }
  return { ok: true, map };
}

// 裂变归属规则（2026-09-25 深夜三改定稿）：
//   ① 以飞书「免训不免考跟进（饼干）」按加盟商姓名登记的门店名为准——该店可能不在平台 storeStats
//     （如黄载均第三店厦门思明五一广场店，试业 2026-10-20 未开业、走免训不免考不进平台计划）
//   ② 飞书查不到/查询失败的学员 → 回退「名下平台门店中开业时间最晚」（米兰公馆 2026-03-30 > 宏达路 2025-01-15）
function attributedLearnersByStore(plan, stores, feishuMap) {
  const openOf = new Map(stores.map(s => [s.storeName, String(s.storeOpeningTime || '')]));
  const map = new Map(); // 归属店名 → 学员列表（每学员只归一家店）
  for (const e of (plan.emps || [])) {
    const fsName = feishuMap ? feishuMap.get(String(e.empName || '').trim()) : null;
    if (fsName) {
      if (!map.has(fsName)) map.set(fsName, []);
      map.get(fsName).push(e);
      continue;
    }
    const names = String(e.storeNames || '').split(/[、,，;；]/).map(s => s.trim()).filter(Boolean);
    let best = null;
    for (const n of names) {
      if (!best) { best = n; continue; }
      const a = openOf.get(n) || '', b = openOf.get(best) || '';
      if (a && (!b || a > b)) best = n;
    }
    if (!best) continue;
    if (!map.has(best)) map.set(best, []);
    map.get(best).push(e);
  }
  return map;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 单店 HTML（竖版表格：阶段竖排、学员为列、每阶段格内 4 项）
function buildStoreHtml(plan, store, learners, nowStr, generatedAt) {
  const periodEnd = plan.endDate || '';
  const joins = learners.map(e => String(e.joinDate || '').slice(0, 10)).filter(Boolean).sort();
  const periodStart = joins[0] || plan.startDate || '';
  const rowsOf = learners.map(e => {
    const det = (plan.empDetails || {})[String(e.employeeId)];
    return { emp: e, hasDetail: !!det, rows: det ? (det.stages || []).map(stageRow) : [] };
  });
  const stageNames = rowsOf.find(r => r.rows.length) ? rowsOf.find(r => r.rows.length).rows.map(r => r.name) : [];
  const seqCn = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮'];

  const cellHtml = (r, sIdx) => {
    if (!r.hasDetail) return '<div style="color:#9aa1af;font-size:12px;padding:6px 0">暂无明细数据</div>';
    const row = r.rows[sIdx];
    if (!row) return '<div style="color:#9aa1af">—</div>';
    const lines = [];
    // 课程学习
    if (!row.cT) lines.push(['课程学习', '—', 'na']);
    else if (row.cD === row.cT) lines.push(['课程学习', row.cD + '/' + row.cT, 'ok']);
    else if (row.cD === 0) lines.push(['课程学习', '0/' + row.cT, 'bad']);
    else lines.push(['课程学习', row.cD + '/' + row.cT, 'part']);
    // 考试（逐项，口径同 app.js 门店学习日报）
    if (!row.exams.length) lines.push(['考试', '—', 'na']);
    else for (const ex of row.exams) {
      if (ex.pass) lines.push(['考试', ex.name + ' ' + ex.score + '分', 'ok']);
      else if (ex.wait) lines.push(['考试', ex.name + ' 待审核', 'wait']);
      else if (ex.stt === 'W') lines.push(['考试', ex.name + ' ' + (ex.score != null ? ex.score + '分(未过)' : '未出分'), 'bad']);
      else lines.push(['考试', ex.name + ' 缺考', 'bad']);
    }
    // 上传作业（逐项，口径同 app.js 门店学习日报）
    if (!row.uT) lines.push(['上传作业', '—', 'na']);
    else for (const up of (row.ups || [])) {
      if (up.wait) lines.push(['上传作业', up.name + ' 待审核', 'wait']);
      else if (!up.done) lines.push(['上传作业', up.name + ' 缺考', 'bad']);
      else if (up.score >= PASS_SCORE) lines.push(['上传作业', up.name + ' ' + up.score + '分', 'ok']);
      else lines.push(['上传作业', up.name + ' ' + up.score + '分(未过)', 'bad']);
    }
    // 完成时间
    lines.push(['完成时间', row.finish ? row.finish.slice(5, 16) : '—', row.finish ? 'time' : 'na']);
    return lines.map(l =>
      '<div class="li"><span class="lb">' + l[0] + '</span><span class="v ' + l[2] + '">' + esc(l[1]) + '</span></div>'
    ).join('');
  };

  const bodyRows = [];
  for (let s = 0; s < stageNames.length; s++) {
    bodyRows.push(
      '<tr><td class="stg">' + (seqCn[s] || (s + 1)) + ' ' + esc(stageNames[s]) + '</td>' +
      rowsOf.map(r => '<td>' + cellHtml(r, s) + '</td>').join('') + '</tr>'
    );
  }
  if (!stageNames.length) {
    bodyRows.push('<tr><td class="stg">—</td><td colspan="' + rowsOf.length + '" style="color:#9aa1af">暂无阶段数据</td></tr>');
  }

  const W = Math.min(1400, 420 + rowsOf.length * 210);
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#fff;padding:12px}' +
    '#card{width:' + W + 'px;background:#fff;border:1px solid #e2e5ec;border-radius:12px;padding:16px 18px}' +
    '.cap{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}' +
    '.cap .t{font-size:15px;font-weight:500;color:#1A2A4A}' +
    '.cap .s{font-size:11.5px;color:#8b93a3}' +
    '.hrow{display:grid;grid-template-columns:1.5fr 1.9fr 0.7fr;gap:8px;margin-bottom:10px}' +
    '.hcell{background:#f3f5f9;border-radius:8px;padding:7px 12px}' +
    '.hl{font-size:11.5px;color:#7a8399;margin:0}' +
    '.hv{font-size:12.5px;font-weight:500;color:#1A2A4A;margin:1px 0 0}' +
    '.hv.nw{white-space:nowrap}' +
    'table{width:100%;border-collapse:collapse;table-layout:fixed}' +
    'th,td{border:1px solid #e2e5ec;padding:5px 9px;font-size:12px;vertical-align:top;text-align:left}' +
    'th{background:#f3f5f9;font-weight:500;color:#1A2A4A}' +
    '.stg{font-weight:500;color:#1A2A4A;font-size:12px}' +
    '.li{display:flex;justify-content:space-between;gap:8px;padding:1px 0}' +
    '.lb{color:#98a0b0;font-size:11.5px;flex:none}' +
    '.v{font-size:12px;text-align:right}' +
    '.ok{color:#3B6D11;font-weight:500}.bad{color:#A32D2D;font-weight:500}.wait{color:#854F0B;font-weight:500}' +
    '.part{color:#185FA5;font-weight:500}.time{color:#1A2A4A}.na{color:#9aa1af}' +
    '.leg{display:flex;gap:12px;margin-top:9px;font-size:11.5px;color:#7a8399;flex-wrap:wrap}' +
    '</style></head><body><div id="card">' +
    '<div class="cap"><span class="t">' + esc(String(plan.planName || '多店加盟商培训').replace(/裂变/g, '多店')) + ' · 门店学习报表</span>' +
    '<span class="s">数据生成 ' + esc((generatedAt || '').slice(5, 16)) + ' · 快照 ' + esc(nowStr.slice(5, 16)) + '</span></div>' +
    '<div class="hrow">' +
    '<div class="hcell"><p class="hl">门店名</p><p class="hv">' + esc(store.storeName || '—') + '</p></div>' +
    '<div class="hcell"><p class="hl">学习周期</p><p class="hv nw">' + esc(periodStart) + ' ~ ' + esc(periodEnd) + '</p></div>' +
    '<div class="hcell"><p class="hl">学员人数</p><p class="hv nw">' + learners.length + '</p></div>' +
    '</div><table><tr><th style="width:150px">阶段</th>' +
    rowsOf.map(r => '<th>姓名　' + esc(r.emp.empName || '') + '</th>').join('') +
    '</tr>' + bodyRows.join('') + '</table>' +
    '<div class="leg">' +
    '<span><b style="color:#3B6D11">绿</b>=完成 / 考试≥' + PASS_SCORE + '分 / 审核通过</span>' +
    '<span><b style="color:#854F0B">黄</b>=已交待老师审核</span>' +
    '<span><b style="color:#A32D2D">红</b>=未完成 / 未考</span>' +
    '<span><b style="color:#9aa1af">—</b>=本阶段无此项</span>' +
    '</div></div></body></html>';
}

// 裂变培训主流程：每店渲染截图、一店一条企微消息
async function fissionStoreReports(page, today, nowStr, failed) {
  let all;
  try { all = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
  catch (e) { throw new Error('读取 data.json 失败: ' + e.message); }
  const generatedAt = all.generatedAt || '';
  const plans = all.plans || [];
  const idx = plans.findIndex(p => (p.planName || '').includes('裂变') &&
    (!p.startDate || today >= p.startDate) && (!p.endDate || today <= p.endDate));
  if (idx < 0) {
    const latest = plans.find(p => (p.planName || '').includes('裂变'));
    logB('[裂变门店报表] 今天 ' + today + ' 不在培训期内（最新一期 ' +
      (latest ? latest.planName + ' ' + latest.startDate + '~' + latest.endDate : '无') + '）→ 按约定不发');
    return;
  }
  const plan = plans[idx];
  const stores = plan.storeStats || [];
  const emps = plan.emps || [];
  // 归属：① 飞书「免训不免考跟进」按姓名登记门店名为准 ② 查不到/失败回退「名下最新开店」
  const fsRes = feishuStoreByNames(emps.map(e => String(e.empName || '').trim()).filter(Boolean));
  // 飞书归属映射落盘（2026-10-08）：看板前端 storeOf 裂变归属读这个文件（_push_inc.py 已加入提交清单）
  if (fsRes.ok) {
    try {
      fs.writeFileSync(path.join(__dirname, 'data', 'fission_feishu_map.json'),
        JSON.stringify({ generatedAt: nowStr, source: '飞书「免训不免考跟进（饼干）」按加盟客户姓名登记门店', map: Object.fromEntries(fsRes.map) }, null, 2));
      logB('[裂变门店报表] 飞书归属映射已写 data/fission_feishu_map.json（' + fsRes.map.size + ' 人）');
    } catch (e) { logB('!! 写 fission_feishu_map.json 失败: ' + e.message); }
  }
  const attrib = attributedLearnersByStore(plan, stores, fsRes.ok ? fsRes.map : null);
  if (!fsRes.ok) failed.push('裂变·飞书「免训不免考跟进」查询失败→本晚回退按名下最新开店归属');
  const srcNote = !fsRes.ok ? '飞书查询失败→全部回退最新开店'
    : (fsRes.map.size ? '飞书登记：' + [...fsRes.map].map(([n, s]) => n + '→' + s).join('、') : '飞书无登记记录');
  logB('[裂变门店报表] ' + plan.planName + '（' + plan.startDate + '~' + plan.endDate + '）平台门店 ' + stores.length +
    ' 家；' + srcNote + '；归属后需出报表 ' + attrib.size + ' 家');
  if (!attrib.size) return;
  // 报表店集合 = 平台 storeStats ∪ 飞书登记门店（如厦门思明五一广场店未开业、不在平台列表）
  const reportStores = [];
  const seenStore = new Set();
  for (const s of stores) { reportStores.push({ storeName: s.storeName, storeId: s.storeId }); seenStore.add(s.storeName); }
  for (const name of attrib.keys()) if (!seenStore.has(name)) reportStores.push({ storeName: name });
  for (const store of reportStores) {
    const label = '[' + (store.storeName || store.storeId) + ']';
    try {
      const learners = attrib.get(store.storeName) || [];
      if (!learners.length) { logB(label + ' 无归属学员 → 跳过'); continue; }
      const html = buildStoreHtml(plan, store, learners, nowStr, generatedAt);
      const W = Math.min(1400, 420 + learners.length * 210);
      await page.setViewportSize({ width: W + 40, height: 900 });
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(200);
      const buf = await page.locator('#card').screenshot({ type: 'png' });
      logB(label + ' 竖版报表生成 ' + buf.length + ' bytes（' + learners.length + ' 学员）');
      if (buf.length > 2 * 1024 * 1024) throw new Error('图片超2MB（' + buf.length + '），企微拒收');
      if (DRY) {
        fs.mkdirSync(PREVIEW_DIR, { recursive: true });
        const fp = path.join(PREVIEW_DIR, (store.storeName || 'store').replace(/[\\/:*?"<>|]/g, '_') + '.png');
        fs.writeFileSync(fp, buf);
        logB(label + ' DRY_RUN 已存预览 ' + fp);
      } else {
        const res = await sendWecom(JSON.stringify({
          msgtype: 'image',
          image: { base64: buf.toString('base64'), md5: crypto.createHash('md5').update(buf).digest('hex') },
        }), WEBHOOK_FISSION);
        logB(label + ' 企微返回 ' + JSON.stringify(res));
        if (!(res && res.errcode === 0)) throw new Error('企微 errcode=' + (res && res.errcode));
        await new Promise(r => setTimeout(r, 800)); // 店间节流
      }
    } catch (e) {
      failed.push('裂变·' + (store.storeName || store.storeId) + '：' + e.message);
      logB('!! ' + label + ' 门店报表失败: ' + e.message);
    }
  }
}

/* ==================== 公开课学习快照（10/28 新增，Rain 指定两张） ====================
   ① 区域视角：公开课明细弹窗·直营组 —— 数据卡（应学/已完成/未完成/完成率）+ 筛选键 + 门店表（按最近完成时间降序）
   ② 门店展开：同课程直营组第一店（最近完成）展开人员明细（已完成带时间、未完成红字）
   课程选择 = 平台「最近有完成记录」的公开课（max finishTime 最新）；随 22:20 快照发主群 */

const PUB_REGION = '直营组';

async function pubCourseSnapshots(page, nowStr, failed) {
  let pc = {};
  try { pc = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'public_course_emp.json'), 'utf8')); }
  catch (e) { throw new Error('读取 public_course_emp.json 失败: ' + e.message); }
  let all;
  try { all = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch (e) { all = {}; }
  const courses = all.publicCourses || [];
  const empMap = pc.courses || {};
  // 选课：最近完成时间最新（无任何完成记录的课跳过）
  let pick = null, pickLast = '';
  for (const c of courses) {
    const rows = empMap[String(c.courseId)] || [];
    const last = rows.reduce((m, e) => (e.t || '') > m ? (e.t || '') : m, '');
    if (last > pickLast) { pickLast = last; pick = c; }
  }
  if (!pick) { logB('[公开课快照] 无有效课程数据 → 跳过'); return; }
  logB('[公开课快照] 选课：' + pick.courseName + '（最近完成 ' + pickLast + '）');

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#mainTabs button', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { state.cat = '其他'; renderCat(); });
  await page.waitForTimeout(300);
  await page.evaluate(cid => pcOpen(cid), pick.courseId);
  // 等静态明细+花名册渲染完成（8767 在线时实时替换也会再渲染一次，多等一拍）
  await page.waitForFunction(() => window.__pc && window.__pc._init && document.querySelector('#pcBody table'), { timeout: 30000 });
  await page.waitForTimeout(4500); // 8767 实时替换窗口
  await page.evaluate(r => pcSetRegion(r), PUB_REGION);
  await page.waitForTimeout(400);
  if (!DRY) { /* 快照横幅 */
    await page.evaluate(t => {
      const b = document.getElementById('pcBody'); if (!b) return;
      const d = document.createElement('div');
      d.style.cssText = 'margin-bottom:8px;font:700 13px/1.5 "Microsoft YaHei",sans-serif;color:#1A2A4A';
      d.textContent = '公开课学习情况 · 快照时间 ' + t + ' · 每晚22:20自动快照';
      b.insertBefore(d, b.firstChild);
    }, nowStr.slice(5, 16));
  }
  const cardEl = page.locator('#pcModal > div > div');
  const shootCard = async name => {
    const buf = await cardEl.screenshot({ type: 'png' });
    logB('[公开课快照] ' + name + ' 生成 ' + buf.length + ' bytes');
    if (buf.length > 2 * 1024 * 1024) throw new Error(name + ' 图片超2MB（' + buf.length + '）');
    if (DRY) {
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(PREVIEW_DIR, name + '.png'), buf);
      logB('[公开课快照] ' + name + ' DRY_RUN 已存预览');
    } else {
      const res = await sendWecom(JSON.stringify({
        msgtype: 'image',
        image: { base64: buf.toString('base64'), md5: crypto.createHash('md5').update(buf).digest('hex') },
      }));
      logB('[公开课快照] ' + name + ' 企微返回 ' + JSON.stringify(res));
      if (!(res && res.errcode === 0)) throw new Error(name + ' 企微 errcode=' + (res && res.errcode));
      await new Promise(r => setTimeout(r, 800));
    }
  };
  await shootCard('公开课_区域');
  // ② 展开第一店（该区域最近完成时间最早的排序首位）后同框再拍
  const firstStore = await page.evaluate(() => {
    const tr = document.querySelector('#pcBody table tr:nth-child(2) td');
    return tr ? tr.textContent.replace(/[▸▾]/g, '').trim() : '';
  });
  if (firstStore) {
    await page.evaluate(s => pcToggleStore(s), firstStore);
    await page.waitForTimeout(300);
    await shootCard('公开课_门店明细');
  } else {
    logB('[公开课快照] 直营组无门店行 → 门店明细快照跳过');
  }
  await page.evaluate(() => pcClose());
}

/* ==================== 主流程 ==================== */

(async () => {
  if (!acquireLock()) {
    console.log('[_night_snapshot] 10 分钟内已有快照实例启动，跳过本次（防重复发图）');
    return;
  }
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const nowStr = fmtDT(now);
  logB('===== 夜间快照开始（新人培训=横版二级汇总 · 裂变=竖版门店报表 · 今天 ' + today + (DRY ? ' · DRY_RUN' : '') + '） =====');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const failed = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
    for (const tab of TRACKS) {
      try {
        if (tab === FISSION_TAB) {
          await fissionStoreReports(page, today, nowStr, failed);
          continue;
        }
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#mainTabs button', { timeout: 60000 });
        await page.waitForTimeout(1500);
        await page.evaluate(t => { state.tab = t; state.planIdx = 0; state.sub = '全部'; render(); }, tab);
        // 找「今天在培训期内」的最新一期；不在期 → 按约定不发（2026-09-25）
        const pick = await page.evaluate(td => {
          const arr = (typeof plansInRange === 'function') ? plansInRange(state.cat) : [];
          const idx = arr.findIndex(p => (!p.startDate || td >= p.startDate) && (!p.endDate || td <= p.endDate));
          return { idx, latest: arr.length ? { name: arr[0].planName, s: arr[0].startDate, e: arr[0].endDate } : null };
        }, today);
        if (pick.idx < 0) {
          logB('[' + tab + '] 今天 ' + today + ' 不在培训期内（最新一期 ' +
            (pick.latest ? pick.latest.name + ' ' + pick.latest.s + '~' + pick.latest.e : '该页签无计划') + '）→ 按约定不发');
          continue;
        }
        await page.evaluate(i => { state.planIdx = i; state.sub = '全部'; render(); }, pick.idx);
        await page.waitForSelector('#allSecBody table', { timeout: 60000 });
        await page.waitForTimeout(800);
        const planMeta = await page.evaluate(() => {
          const p = ((typeof plansInRange === 'function') ? plansInRange(state.cat) : [])[state.planIdx] || {};
          return (p.planName || '?') + '（' + (p.startDate || '?') + '~' + (p.endDate || '?') + '）';
        });
        const dataUrl = await page.evaluate(async (meta) => {
          await window._loadHtml2canvas();
          const box = document.getElementById('allSecBody');
          const tbl = box.querySelector('table');
          const banner = document.createElement('div');
          banner.style.cssText = 'padding:10px 14px;font:700 16px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#1A2A4A;border-bottom:2px solid #1A2A4A;margin-bottom:8px';
          const _p2 = n => String(n).padStart(2, '0');
          const _t2 = new Date();
          const snapAt = _t2.getFullYear() + '-' + _p2(_t2.getMonth() + 1) + '-' + _p2(_t2.getDate()) + ' ' + _p2(_t2.getHours()) + ':' + _p2(_t2.getMinutes());
          banner.textContent = meta + ' · 二级汇总-全部 · 数据生成时间 ' +
            String(((typeof DATA !== 'undefined' && DATA && DATA.generatedAt) || '-')).slice(0, 16) +
            ' · 快照时间 ' + snapAt + ' · 每晚22:20自动快照（仅培训期内发）';
          box.insertBefore(banner, box.firstChild);
          box.style.overflow = 'visible';
          if (tbl) tbl.style.width = Math.max(tbl.scrollWidth, box.scrollWidth) + 'px';
          const shoot = (scale, type, q) => html2canvas(box, {
            useCORS: true, backgroundColor: '#f2f4f8', scale, logging: false,
            width: box.scrollWidth || undefined, height: box.scrollHeight || undefined,
            windowWidth: box.scrollWidth || undefined, windowHeight: box.scrollHeight || undefined,
            scrollX: 0, scrollY: 0,
            ignoreElements: el => ['shareOverlay', 'pngShareTip', 'shareRoBar', 'nightSnapBanner2'].includes(el.id),
          }).then(cv => cv.toDataURL(type, q));
          let out;
          try {
            const approxBytes = s => Math.floor((s.length - s.indexOf(',') - 1) * 3 / 4);
            out = await shoot(2, 'image/png');
            if (approxBytes(out) > 1900 * 1024) out = await shoot(2, 'image/jpeg', 0.9);
            if (approxBytes(out) > 1900 * 1024) out = await shoot(1, 'image/jpeg', 0.85);
          } finally {
            box.style.overflow = '';
            if (tbl) tbl.style.width = '';
            banner.remove();
          }
          return out;
        }, planMeta);
        const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const img = Buffer.from(b64, 'base64');
        logB('[' + tab + '] ' + planMeta + ' 快照生成 ' + img.length + ' bytes');
        if (img.length > 2 * 1024 * 1024) throw new Error('快照仍超2MB（' + img.length + '），企微拒收');
        if (DRY) {
          fs.mkdirSync(PREVIEW_DIR, { recursive: true });
          fs.writeFileSync(path.join(PREVIEW_DIR, tab + '_h.png'), img);
          logB('[' + tab + '] DRY_RUN 已存预览');
        } else {
          const res = await sendWecom(JSON.stringify({
            msgtype: 'image',
            image: { base64: b64, md5: crypto.createHash('md5').update(img).digest('hex') },
          }));
          logB('[' + tab + '] 企微返回 ' + JSON.stringify(res));
          if (!(res && res.errcode === 0)) throw new Error('企微 errcode=' + (res && res.errcode));
        }
      } catch (e) {
        failed.push(tab + '：' + e.message);
        logB('!! [' + tab + '] 快照失败: ' + e.message);
      }
    }
    // 质效双升（公开课快照）已下线：2026-11-09 Rain 指定只出新加盟商培训 + 裂变加盟商培训报表
    // try {
    //   await pubCourseSnapshots(page, nowStr, failed);
    // } catch (e) {
    //   failed.push('公开课快照：' + e.message);
    //   logB('!! [公开课快照] 失败: ' + e.message);
    // }
    if (failed.length) {
      try {
        await sendWecom(JSON.stringify({
          msgtype: 'text',
          text: { content: '【学习看板】❌ 22:20夜间快照失败（' + failed.join('；') + '）' },
        }));
      } catch (e2) { logB('!! 失败告警也发送异常: ' + e2.message); }
      process.exitCode = 1;
    } else {
      logB('===== 夜间快照完成（在期培训已全部处理' + (DRY ? ' · DRY_RUN 未发送' : '') + '） =====');
    }
  } catch (e) {
    logB('!! 夜间快照整体失败: ' + e.message);
    try {
      await sendWecom(JSON.stringify({
        msgtype: 'text',
        text: { content: '【学习看板】❌ 22:20夜间快照失败：' + e.message },
      }));
    } catch (e2) { logB('!! 失败告警也发送异常: ' + e2.message); }
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
