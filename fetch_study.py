"""学习看板数据抓取脚本
数据源：慧运营 zhyyapp.ruipos.com（与巡店看板同一账号 888 / 同一签名算法）
链路：登录 -> 拉全部培训计划 -> 按 categoryName 归入5个一级菜单
     -> 每个计划拉 概述/阶段统计/门店统计/区域排名/学员列表
输出：data/data.json（前端唯一数据源）
"""
import json, time, hashlib, random, string, urllib.request, urllib.parse, os, sys
from concurrent.futures import ThreadPoolExecutor, as_completed

# 防 GBK 控制台编码崩溃（计划名可能含 \u2006 等特殊字符）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 计划名含这些关键词的，不入列表（测试/占位计划）
PLAN_EXCLUDE = ["测试", "XX", "xx", "课前准备", "174期", "煲饭"]

HOST = "https://zhyyapp.ruipos.com"
SECRET = "hyy&&123456"
HERE = os.path.dirname(os.path.abspath(__file__))

# 并发数：本机默认 8；云端（海外访问国内接口，延迟大）用环境变量 STUDY_WORKERS 调高
try:
    WORKERS = max(1, int(os.environ.get("STUDY_WORKERS", "8")))
except ValueError:
    WORKERS = 8
try:
    MAP_WORKERS = max(1, int(os.environ.get("STUDY_MAP_WORKERS", "3")))
except ValueError:
    MAP_WORKERS = 3

# 一级菜单归类：categoryName 包含关键词即归入
CATEGORY_RULES = [
    ("新加盟商培训", ["新加盟商"]),
    ("裂变加盟商培训", ["裂变"]),
    ("线上线下培训", ["直播", "线上线下", "线上课程", "线下培训", "项目学习任务"]),
    ("员工培训/晋升", ["考核", "转正", "晋升", "星级", "中级", "初级", "师傅", "督导", "刷题", "学习地图"]),
    ("公开课学习", ["公开课"]),
]

def classify(name):
    for cat, kws in CATEGORY_RULES:
        if any(k in name for k in kws):
            return cat
    return None  # 无法归类返回 None，兜底归属由 plan_cat 决定

def plan_cat(p):
    """计划归类：裂变最优先（平台把裂变计划 categoryName 设为「新加盟商培训」，
    必须保住裂变独立业务线）；其次平台 categoryName（官方分类，如「项目学习任务」->线上线下培训）；
    再按计划名关键词；都无法归类兜底「其他」。
    （9/19晚 用户澄清：只删直营学习明细板块的「其他」，主看板「其他」页签保留——
    拼好饭等课程靠手动归口覆盖 cat_overrides 移到线上线下培训，兜底删除会导致课程凭空消失）"""
    n = p.get("planName") or ""
    if "裂变" in n:
        return "裂变加盟商培训"
    return classify(p.get("categoryName") or "") or classify(n) or "其他"


# ── fix204 截至昨日进度冻结统计（Rain 2026-09-22 定稿）──────────────────
# 需求：门店排名表「当前阶段完成情况」= 截至昨日 23:59 已完成（需合格）任务 ÷ 当时应完成任务；
#       该统计只在每天凌晨同步时计算一次，白天各轮更新原样沿用——白天补做会让
#       "昨天该完成的"虚增，统计就偏差了。
# 实现：凌晨(hour<6)本轮抓完即算 asOf=昨天挂到每个计划 p["frozen"]；
#       白天轮从旧 data.json 按 planId 原样搬运；旧数据没有（凌晨轮失败）→
#       白天轮现场算一次并标 approx=1（实时近似，前端会注明）。
# 口径与前端 app.js empStat/required 完全一致：必修课(3/8)=状态W；
# 考核(考试4/课题名带「考核」/带分数)=W 且未判否/待阅卷 且(分数≥80 或 平台判「是」)；
# 上传考核（fix206 A/B 同权：上传拼盘实操考核图片 与 上传慧运营拼盘考核截图 均真实考核）：
# 已交未打分=待审核不算完成；已打分按分数≥80（fix203 的 A 纯动作特判已废除）。
# 仅把统计范围从「全部阶段」收窄为「应完成日期 ≤ asOf 的阶段」（应完成日期推算同 app.js dueDateOf）。

_CN_D = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _num(x):
    """镜像 JS +x/isNaN：数字返回 float；空串按 0（JS +"" === 0）；其余 None"""
    if x is None or isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).strip()
    if s == "":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


def _cn_day_num(s):
    """镜像 app.js cnDayNum：「第N天」/「第中文数字天」→ int 或 None"""
    import re
    m = re.search(r"第([0-9０-９]+)天", s or "")
    if m:
        return int(m.group(1).translate(str.maketrans("０１２３４５６７８９", "0123456789")))
    m2 = re.search(r"第([一二三四五六七八九十]+)天", s or "")
    if not m2:
        return None
    cn = m2.group(1)
    if cn == "十":
        return 10
    i = cn.find("十")
    if i == -1:
        return _CN_D.get(cn)
    n = 0
    if i > 0:
        n += _CN_D.get(cn[0], 0)
    n *= 10
    if i < len(cn) - 1:
        n += _CN_D.get(cn[i + 1], 0)
    return n


def _due_date(plan, stage_name):
    """镜像 app.js dueDateOf：startDate + 阶段在 stageStats 的序号天；
    序号找不到退回阶段名「第N天」；推算不出返回 None"""
    from datetime import datetime, timedelta
    sd = plan.get("startDate")
    if not sd:
        return None
    try:
        dt = datetime.strptime(str(sd)[:10], "%Y-%m-%d")
    except ValueError:
        return None
    ss = plan.get("stageStats") or []
    sn = stage_name or ""
    idx = -1
    for i, x in enumerate(ss):
        if (x.get("phaseName") or "") == sn:
            idx = i
            break
    if idx >= 0:
        dt += timedelta(days=idx)
    else:
        d = _cn_day_num(sn)
        if d is None:
            return None
        dt += timedelta(days=d - 1)
    return dt.date()


def _is_upload_work(t):
    name = t[0] or ""
    return name.startswith("上传") and "拼盘" in name


def _is_graded_t(t):
    """镜像 app.js isGradedT"""
    name, typ, score, is_pass = t[0], t[1], t[3], t[4]
    if typ == 4:
        return True
    if "考核" in (name or ""):
        return True
    if is_pass is not None and is_pass != "-":
        return True
    return _num(score) is not None


def _exam_pass_t(t):
    """镜像 app.js examPassT"""
    name, st, score, is_pass = t[0], t[2], t[3], t[4]
    if st != "W":
        return False
    if is_pass in ("否", "待阅卷"):
        return False
    if _is_upload_work(t) and _num(score) is None:
        return False  # 上传考核（fix206 A/B 同权）：已交未打分 = 待审核 ≠ 完成
    n = _num(score)
    if n is not None:
        return n >= 80
    return is_pass == "是"


def _frozen_emp_stat(plan, det, as_of, due_cache):
    """单学员截至 asOf 的 [done, total]，仅统计应完成日期 ≤ asOf 的阶段"""
    total = done = 0
    for s in det.get("stages", []):
        sn = s.get("n") or ""
        if sn not in due_cache:
            d = _due_date(plan, sn)
            due_cache[sn] = (d is None) or (d <= as_of)  # 推算不出→按已到期（同 app.js isStageDue）
        if not due_cache[sn]:
            continue
        for t in s.get("t", []):
            if _is_graded_t(t):
                total += 1
                if _exam_pass_t(t):
                    done += 1
            elif t[1] in (3, 8):
                total += 1
                if t[2] == "W":
                    done += 1
    return [done, total]


def compute_frozen(p, as_of):
    """整计划截至 asOf 的冻结进度 {"asOf": "...", "emps": {"<employeeId>": [done, total]}}
    total=0 的学员也保留（表示截至昨日还没有应完成项，前端不计入/不拉低分母）"""
    due_cache = {}
    emps_out = {}
    for eid, det in (p.get("empDetails") or {}).items():
        emps_out[str(eid)] = _frozen_emp_stat(p, det or {}, as_of, due_cache)
    return {"asOf": as_of.isoformat(), "emps": emps_out}


def _load_prev_frozen():
    """上一版 data.json 各计划的 frozen 块（白天轮搬运用），读取失败返回空"""
    try:
        with open(os.path.join(HERE, "data", "data.json"), encoding="utf-8") as f:
            prev = json.load(f)
        return {str(p.get("planId")): p["frozen"]
                for p in (prev.get("plans") or []) if p.get("frozen")}
    except Exception:
        return {}


def attach_frozen(data):
    """按 fix204 规则给每个计划挂 frozen 块"""
    from datetime import date, timedelta
    as_of = date.today() - timedelta(days=1)
    night = time.localtime().tm_hour < 6
    prev = {} if night else _load_prev_frozen()
    n_fresh = n_carry = n_approx = 0
    as_of_s = as_of.isoformat()
    for p in data.get("plans", []):
        if p.get("fetchError"):
            continue
        pid = str(p.get("planId"))
        if night:
            try:
                p["frozen"] = compute_frozen(p, as_of)
                n_fresh += 1
            except Exception as e:
                print(f"  [冻结统计失败] {p.get('planName')}: {e}")
        elif prev.get(pid) and prev[pid].get("asOf") == as_of_s:
            p["frozen"] = prev[pid]
            n_carry += 1
        else:
            try:
                fz = compute_frozen(p, as_of)
                fz["approx"] = 1
                p["frozen"] = fz
                n_approx += 1
            except Exception as e:
                print(f"  [冻结统计失败(近似)] {p.get('planName')}: {e}")
    print(f"冻结统计(asOf={as_of_s}): 凌晨新算 {n_fresh} / 白天沿用 {n_carry} / 近似补算 {n_approx}")

def _sign(n, t):
    return hashlib.sha256(f"{n}{t}{SECRET}".encode()).hexdigest()

def _open(req, timeout=20, tries=3, what="请求"):
    """带重试的 HTTP 请求（只返回 body 字节）。

    ⚠️ 2026-09-18 事故：云端单次登录请求 20 秒超时就把整轮抓取搞崩了。
    海外访问国内接口偶发超时/连接重置很常见，所以网络层异常必须重试，
    否则一整天的自动更新会因为一次抖动白跑。HTTP 4xx 属确定性错误，不重试。
    """
    last = None
    for i in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if 500 <= e.code < 600 and i < tries:
                last = e
                time.sleep(1.5 * i)
                continue
            raise
        except Exception as e:
            last = e
            if i < tries:
                print(f"  [重试 {i}/{tries - 1}] {what}: {str(e)[:90]}", flush=True)
                time.sleep(1.5 * i)
    raise last

# ── 888 固定岗位声明 ──────────────────────────────────────────────
# 目标岗位「培训经理@总部」（roleId=104, organizeId=1）。
# 平台会把「手机 App 最后切换的岗位」记为账号当前岗位，网页/脚本登录继承它——
# 手机一切岗，学习地图可见范围就跟着缩水（9-20 塌陷的根因）。
# 每次登录显式声明目标岗位：当前服务端版本会忽略该参数，
# 但一旦平台修复/支持，抓数即自动恢复完整可见范围，无需改代码。
FIX_ROLE_ID = 104        # 培训经理
FIX_ORG_ID = 1           # 总部
FIX_ROLE_LABEL = "培训经理@总部"

def login():
    nonce = "".join(random.choices(string.ascii_letters + string.digits, k=16))
    ts = int(time.time() * 1000)
    body = {"sign": _sign(nonce, ts), "nonce": nonce, "timestamp": ts,
            "phoneModel": "Mozilla/5.0", "platform": "browser", "clientVersion": "4.0.0",
            "loginType": "W", "ent": "cjss", "username": "888",
            "password": hashlib.md5("Aa123456".encode()).hexdigest(),
            "role": FIX_ROLE_ID, "organizeId": FIX_ORG_ID}
    req = urllib.request.Request(HOST + "/auth/login?version=1", data=json.dumps(body).encode(), method="POST")
    for k, v in [("Content-Type", "application/json"), ("Accept", "*/*"),
                 ("Origin", "https://zhyy.ruipos.com"), ("Referer", "https://zhyy.ruipos.com/")]:
        req.add_header(k, v)
    j = json.loads(_open(req, timeout=30, tries=5, what="登录"))
    d = j.get("data") or {}
    tok = d.get("token")
    if not tok:
        raise RuntimeError("登录未拿到 token: %s" % str(j)[:200])
    # 岗位检测：当前组织不是「总部(1)」说明手机 App 切过岗，可见范围受限
    cur_org = d.get("currentOrganization")
    if cur_org == FIX_ORG_ID:
        print(f"login OK（岗位已固定 {FIX_ROLE_LABEL}）")
        role_state = {"currentOrganization": cur_org, "fixed": True, "label": FIX_ROLE_LABEL}
    else:
        print("⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️")
        print(f"⚠️ 888 当前岗位不是{FIX_ROLE_LABEL}（现在是组织ID={cur_org}）")
        print("⚠️ 可见范围受限：晋升图/加盟商学员只能抓到可见的那部分，数据不完整！")
        print("⚠️ 请在【手机 App：我的→切换岗位】切回「培训经理-总部」，下次抓数即恢复")
        print("⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️")
        role_state = {"currentOrganization": cur_org, "fixed": False, "label": FIX_ROLE_LABEL}
    return tok, role_state

def call(tok, path, body):
    req = urllib.request.Request(HOST + path, data=json.dumps(body).encode(), method="POST")
    for k, v in [("Content-Type", "application/json"), ("Accept", "application/json"),
                 ("token", tok), ("ent", "cjss"),
                 ("Origin", "https://zhyy.ruipos.com"), ("Referer", "https://zhyy.ruipos.com/"),
                 ("timeZone", "Asia/Shanghai")]:
        req.add_header(k, v)
    try:
        j = json.loads(_open(req, timeout=20, tries=3, what=path.split("?")[0]))
        if j.get("status") != 0:
            return None, j.get("message", "status!=0")
        return j.get("data"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)[:120]

# 「其他」Tab 组别归属：培训组成员（高瑞瑜/黄昭航/潘英化/赖奕毅）建的任务
# 一律归「培训组(直营组)」展示（不看发布组织）；门店员工（如陈明来）发的剔除；
# 其余按发布组织映射组别
PUB_GROUPS = ["培训组(直营组)", "新店运营组", "加盟营运组", "新店筹建组"]
TRAIN_GROUP_CREATORS = {"10000000000108", "10000000000279", "10000000000989", "10000000000991"}
STORE_EXCLUDE_CREATORS = {"10000000004620"}  # 门店员工，剔除其发布

def pub_group(r):
    creator = str(r.get("creator"))
    if creator in TRAIN_GROUP_CREATORS:
        return "培训组(直营组)"
    if creator in STORE_EXCLUDE_CREATORS:
        return None  # 门店员工（直营组的人）自建任务一律剔除，不看发布组织
    org = r.get("organizeNames") or ""
    if "新店运营组" in org:
        g = "新店运营组"
    elif "加盟营运组" in org:
        g = "加盟营运组"
    elif "新店筹建组" in org:
        g = "新店筹建组"
    else:
        return None
    return g

def fetch_all_plans(tok):
    plans, page = [], 1
    while True:
        d, err = call(tok, "/web/train/plan/manage/array?version=1",
                      {"pageNumber": page, "pageSize": 50})
        if err or not d:
            print(f"  计划列表第{page}页失败: {err}")
            break
        rows = d.get("list", [])
        for r in rows:
            plans.append({
                "planId": r.get("planId"),
                "planName": r.get("planName"),
                "categoryName": r.get("categoryName") or "",
                "startDate": (r.get("startDate") or "")[:10],
                "endDate": (r.get("endDate") or "")[:10],
                "planStatus": r.get("planStatus"),
                "creator": r.get("creator"),
                "organizeNames": r.get("organizeNames"),
                "pubGroup": pub_group(r),
            })
        if d.get("lastPage") or page >= 20:
            break
        page += 1
    print(f"计划总数: {len(plans)}")
    return plans

def fetch_plan_detail(tok, plan):
    pid = plan["planId"]
    out = {"planId": pid, "planName": plan["planName"], "category": plan["_cat"],
           "categoryName": plan["categoryName"], "startDate": plan["startDate"],
           "endDate": plan["endDate"], "planStatus": plan["planStatus"], "creator": plan["creator"], "pubGroup": plan.get("pubGroup")}

    d, err = call(tok, "/web/train/report/statisticalOverview?version=1", {"planId": pid})
    out["overview"] = d if d else None
    if err: print(f"  [概述失败] {plan['planName']}: {err}")

    d, err = call(tok, "/web/train/report/stageStatistics?version=1", {"planId": pid})
    out["stageStats"] = d if d else []

    d, err = call(tok, "/web/train/report/regionalCompletionRateRanking?version=1", {"planId": pid})
    out["regionalRanking"] = d if d else []

    # 门店统计（分页）
    stores, page = [], 1
    while True:
        d, err = call(tok, "/web/train/report/storeStatistics?version=1",
                      {"planId": pid, "pageNumber": page, "pageSize": 50})
        if err or not d:
            print(f"  [门店统计失败] {plan['planName']} 第{page}页: {err}")
            break
        stores += d.get("list", [])
        if d.get("lastPage") or page >= 20:
            break
        page += 1
    out["storeStats"] = stores

    # 学员列表（分页）：默认返回在职；离职学员需另用 empStatus:'lz' 拉取后合并
    # （离职员工不参与统计口径，仅归入「离职管理档案」备查）
    emps, page = [], 1
    while True:
        d, err = call(tok, "/web/train/plan/findTrainPlanEmpList?version=1",
                      {"planId": pid, "pageNumber": page, "pageSize": 100})
        if err or not d:
            print(f"  [学员列表失败] {plan['planName']} 第{page}页: {err}")
            break
        emps += d.get("list", [])
        if d.get("lastPage") or page >= 50:
            break
        page += 1
    lz_emps, page = [], 1
    while True:
        d, err = call(tok, "/web/train/plan/findTrainPlanEmpList?version=1",
                      {"planId": pid, "pageNumber": page, "pageSize": 100, "empStatus": "lz"})
        if err or not d:
            break
        lz_emps += d.get("list", [])
        if d.get("lastPage") or page >= 50:
            break
        page += 1
    if lz_emps:
        have = {e["employeeId"] for e in emps}
        emps += [e for e in lz_emps if e["employeeId"] not in have]
        print(f"  含离职学员 {len(lz_emps)} 人")
    out["emps"] = emps
    out["empCount"] = len(emps)

    # 员工学习明细（并发）：真实进度以 completedTaskNumber/taskNumber 为准，
    # 计划学员列表的 trainingStatus 不可靠（100%完成的计划仍标1）
    def emp_detail(e):
        d, err = call(tok, "/web/train/report/employee/trainingDetail?version=1",
                      {"planId": pid, "employeeId": e["employeeId"]})
        if err or not d:
            return None
        stages = []
        all_t = []
        for s in d.get("trainingStageDetailList", []):
            ts = [[t.get("taskName"), t.get("taskType"), t.get("taskStatus"),
                   t.get("score"), t.get("isPass"), t.get("taskFinished")]
                  for t in s.get("trainingTaskDetailList", [])
                  if t.get("taskStatus") != "J"]  # J=免修，不计入学习统计
            all_t += ts
            stages.append({
                "id": s.get("planStageId"), "n": s.get("stageName"), "s": s.get("stageStatus"),
                "t": ts,
            })
        # 免修任务剔除后按任务明细重算进度（平台的 taskNumber 可能含免修）
        def _cnt(pred):
            return sum(1 for t in all_t if pred(t))
        return {"done": _cnt(lambda t: t[2] == "W"), "total": len(all_t),
                "course": _cnt(lambda t: t[2] == "W" and t[1] == 3), "courseN": _cnt(lambda t: t[1] == 3),
                "exam": _cnt(lambda t: t[2] == "W" and t[1] == 4), "examN": _cnt(lambda t: t[1] == 4),
                "stages": stages}

    print(f"  拉取员工明细 x{len(emps)} ...")
    results = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(emp_detail, e): e["employeeId"] for e in emps}
        for f in as_completed(futs):
            eid = futs[f]
            try:
                r = f.result()
                if r: results[str(eid)] = r
            except Exception:
                pass
    out["empDetails"] = results
    n_missing = len(emps) - len(results)
    if n_missing:
        print(f"  [警告] {plan['planName']} 有 {n_missing} 名员工明细抓取失败")
    return out

def fetch_maps(tok):
    """晋升学习地图：/web/learnMap/list 拿地图名单，
    每张地图用 /web/reportForm/learnStatisticsEmpOfMap 分页拉全部在职学员进度。
    2026-09-21 兜底：平台把 888 可见范围收窄后 learnMap/list 只剩新手村 4 张
    （6 张晋升图从列表消失），但按 mapId 直接查学员接口仍正常 →
    用 data/known_maps.json 记录的历史地图清单补齐，防止再被平台端变化打断。"""
    known_path = os.path.join(HERE, "data", "known_maps.json")
    known = {}
    if os.path.exists(known_path):
        try:
            known = json.load(open(known_path, encoding="utf-8"))
        except Exception as e:
            print(f"  [警告] known_maps.json 解析失败: {e}")
            known = {}

    d, err = call(tok, "/web/learnMap/list?version=1", {"pageIndex": 1, "pageSize": 50})
    listed = []
    if err or not d:
        print(f"[学习地图] 列表失败: {err}（尝试用本地已知清单兜底）")
    else:
        for m in d.get("list", []):
            listed.append({"mapId": m.get("mapId"), "mapName": m.get("mapName"),
                           "categoryName": m.get("categoryName"), "status": m.get("status")})
    by_id = {str(m["mapId"]): m for m in listed}
    added = 0
    for mid, info in (known or {}).items():
        if mid not in by_id:
            by_id[mid] = {"mapId": mid, "mapName": info.get("mapName"),
                          "categoryName": info.get("categoryName"),
                          "status": info.get("status"), "_fromKnown": True}
            added += 1
    maps = list(by_id.values())
    print(f"学习地图: 平台列表 {len(listed)} 张" + (f" + 本地兜底 {added} 张 = {len(maps)} 张" if added else ""))
    if added:
        print("  [提示] 平台可见地图变少（888 可见范围又被收窄？），晋升图学员只能抓到可见的那部分；"
              "恢复完整需慧运营管理员把 888 的组织可见范围放开")

    def fetch_map_emps(mp):
        emps, page = [], 1
        while True:
            d2, err2 = call(tok, "/web/reportForm/learnStatisticsEmpOfMap?version=1",
                            {"mapId": mp["mapId"], "pageIndex": page, "pageSize": 100})
            if err2 or not d2:
                print(f"  [地图学员失败] {mp['mapName']} 第{page}页: {err2}")
                break
            emps += d2.get("list", [])
            if d2.get("lastPage") or page >= 50:
                break
            page += 1
        mp["emps"] = emps
        mp["empCount"] = len(emps)
        print(f"  {mp['mapName']}: {len(emps)} 人")
        return mp

    with ThreadPoolExecutor(max_workers=MAP_WORKERS) as ex:
        maps = list(ex.map(fetch_map_emps, maps))
    # 回写已知地图清单（含本轮学员数，供下轮对比）
    try:
        prev_total = sum(int(v.get("lastEmpCount") or 0) for v in (known or {}).values())
        for mp in maps:
            known[str(mp["mapId"])] = {"mapName": mp.get("mapName"),
                                       "categoryName": mp.get("categoryName"),
                                       "status": mp.get("status"),
                                       "lastEmpCount": mp.get("empCount"),
                                       "lastSeen": time.strftime("%Y-%m-%d")}
        with open(known_path, "w", encoding="utf-8") as f:
            json.dump(known, f, ensure_ascii=False, indent=1)
        cur_total = sum(mp.get("empCount") or 0 for mp in maps)
        if prev_total and cur_total < prev_total * 0.5:
            print(f"  [塌陷警告] 地图学员总数 {prev_total} -> {cur_total}（<50%），"
                  f"多半是 888 可见范围又被平台收窄；本轮仍照常写盘")
    except Exception as e:
        print(f"  [警告] known_maps.json 回写失败: {e}")
    return maps

def is_direct_emp(e):
    """直营组员工判定：组织链路含「培训组」且含「直营组」；
    测试门店（直营）是内部测试账号，明确排除（2026-09-19 用户拍板）。"""
    org = e.get("organizeNames") or ""
    store = e.get("storeNames") or e.get("storeName") or ""
    return "培训组" in org and "直营组" in org and "测试" not in store

def fetch_direct_maps(tok, maps):
    """直营组学习地图三级明细（2026-09-19 新增「直营学习明细」板块数据源）：
    对直营组员工 × 其参与的每张地图，抓
      ①learnStatisticsEmployeeMapDetails        学员在地图的汇总
      ②learnStatisticsEmployeeStageMapDetails   学员在地图的阶段列表
      ③learnStatisticsEmployeeStageTaskMapDetails 每阶段的任务明细（需 stageId + startDate/endDate）
    输出 data["directMaps"] = {"emps": {"<employeeId>": {"name/store/position/role/maps":[...]}}}
    计划任务明细不在这里抓——plans[].empDetails 已有全量，前端直接按 employeeId 关联。"""
    pairs = []  # (emp样本, map)
    seen = set()
    for mp in maps:
        for e in mp.get("emps") or []:
            if not is_direct_emp(e):
                continue
            key = (e["employeeId"], mp["mapId"])
            if key in seen:
                continue
            seen.add(key)
            pairs.append((e, mp))
    print(f"[直营明细] 直营组员工-地图对: {len(pairs)} 对")
    wide = {"startDate": "2020-01-01", "endDate": "2029-12-31"}

    def fetch_pair(item):
        e, mp = item
        eid, mid = e["employeeId"], mp["mapId"]
        rec = {"mapId": mid, "mapName": mp.get("mapName"),
               "progress": e.get("completionSchedule"), "status": e.get("status"),
               "stageName": e.get("stageName"), "learningPeriod": e.get("learningPeriod"),
               "issueDate": e.get("issueDate"), "stages": []}
        # ① 汇总
        d, err = call(tok, "/web/reportForm/learnStatisticsEmployeeMapDetails?version=1",
                      {"mapId": mid, "employeeId": eid, **wide})
        if d:
            rec["summary"] = d
        # ② 阶段列表
        d, err = call(tok, "/web/reportForm/learnStatisticsEmployeeStageMapDetails?version=1",
                      {"mapId": mid, "employeeId": eid, **wide})
        stages = d if isinstance(d, list) else []
        # ③ 每阶段任务明细
        for st in stages:
            sd, serr = call(tok, "/web/reportForm/learnStatisticsEmployeeStageTaskMapDetails?version=1",
                            {"mapId": mid, "employeeId": eid, "stageId": st.get("stageId"), **wide})
            rec["stages"].append({
                "stageId": st.get("stageId"), "stageName": st.get("stageName"),
                "status": st.get("status"), "finishCond": st.get("finishCond"),
                "tasks": sd if isinstance(sd, list) else [],
            })
        if not stages:
            return eid, rec
        return eid, rec

    results = {}
    n_ok = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_pair, it) for it in pairs]
        for f in as_completed(futs):
            try:
                eid, rec = f.result()
                results.setdefault(str(eid), {"maps": []})["maps"].append(rec)
                n_ok += 1
            except Exception as ex2:
                print(f"  [直营明细失败] {str(ex2)[:100]}")
    # 补人员档案（姓名/门店/岗位）——从计划学员列表与地图学员列表取最全的一条
    profiles = {}
    for mp in maps:
        for e in mp.get("emps") or []:
            eid = str(e.get("employeeId"))
            if eid in results and eid not in profiles and is_direct_emp(e):
                profiles[eid] = {"name": e.get("employeeName"), "store": e.get("storeNames") or e.get("storeName"),
                                 "position": e.get("positionName"), "role": e.get("roleNames")}
    for eid, prof in profiles.items():
        results[eid].update(prof)
    total_maps = sum(len(v["maps"]) for v in results.values())
    print(f"[直营明细] 完成: {len(results)} 人 / {total_maps} 张地图对（请求对 {len(pairs)}）")
    return {"emps": results}

SUPABASE_URL = "https://furiqmhvflnjllrwfhyw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cmlxbWh2ZmxuamxscndmaHl3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTY4MzU3NywiZXhwIjoyMTAxMjU5NTc3fQ.XVZGKGRWhaLG7ZyaYJzPmGI8SJxxBqYZy-fq7bvKz_E"  # service_role，仅本机脚本使用，绝不出现在前端

def _fetch_puzzle(game):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/puzzle_records?game=eq.{game}&order=time.desc&limit=1000",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"})
    rows = json.loads(_open(req, timeout=25, tries=3, what="Supabase/" + game))
    out = []
    for r in rows:
        try:
            detail = json.loads(r.get("name") or "{}")
        except Exception:
            detail = {"by": r.get("name")}
        detail["store"] = r.get("store")
        detail["time"] = r.get("time")
        out.append(detail)
    return out

def fetch_evaluations():
    """讲师评估 + 课程满意度：存于拼盘同款 Supabase 的 puzzle_records 表
    （game='lecture_eval' / 'course_survey'）。H5 表单匿名提交（RLS 放行），
    本脚本用 service key 读取后交给看板展示。"""
    evals, surveys = [], []
    # Supabase 是外部服务，偶发不可用不能拖垮整轮抓取：各自失败只丢自己那块。
    try:
        for r in _fetch_puzzle("lecture_eval"):
            evals.append({"store": r["store"], "time": r["time"],
                          "by": r.get("by", ""), "th": r.get("th", ""),
                          "tech": r.get("tech", ""), "prac": r.get("prac", ""),
                          "course": r.get("course", "")})
    except Exception as e:
        print(f"  [警告] 讲师评估拉取失败（本轮置空）: {str(e)[:120]}")
    print(f"讲师评估: {len(evals)} 条")
    try:
        surveys = _fetch_puzzle("course_survey")
    except Exception as e:
        print(f"  [警告] 课程满意度拉取失败（本轮置空）: {str(e)[:120]}")
    print(f"课程满意度: {len(surveys)} 条")
    return evals, surveys

def fetch_resigned(tok):
    """离职员工花名册：/web/md/emp/list 全量拉取后按 workStatus=='lz' 过滤。
    不参与任何统计，仅供「离职管理档案」展示。"""
    emps, page = [], 1
    while True:
        d, err = call(tok, "/web/md/emp/list?version=1",
                      {"pageNumber": page, "pageSize": 1000})
        if err or d is None:
            print(f"[离职名单] 第{page}页失败: {err}")
            break
        rows = d if isinstance(d, list) else (d.get("list") or [])
        emps += rows
        if not rows or len(rows) < 1000 or page >= 10:
            break
        page += 1
    lz = [{"employeeId": e.get("employeeId"), "employeeCode": e.get("employeeCode"),
           "employeeName": e.get("employeeName"), "positionName": e.get("positionName"),
           "store": e.get("fullName") or e.get("storeName") or "",
           "region": e.get("organizeName") or "", "entryDate": e.get("entryDate") or "",
           "departureDate": e.get("departureDate") or "", "departureCause": e.get("departureCause") or ""}
          for e in emps if e.get("workStatus") == "lz"]
    print(f"离职员工: {len(lz)} 人（花名册 {len(emps)} 人）")
    return lz

def main():
    tok, role_state = login()
    plans = fetch_all_plans(tok)
    n_before = len(plans)
    plans = [p for p in plans if not any(k in (p["planName"] or "") for k in PLAN_EXCLUDE)]
    print(f"过滤测试/XX计划: {n_before} -> {len(plans)}")
    for p in plans:
        p["_cat"] = plan_cat(p)
    # 9/19晚 用户澄清：无法归类兜底回「其他」输出（主看板「其他」页签保留）；
    # 直营学习明细板块由前端自行隐藏「其他」，不再在数据源整条删除

    cats = {}
    for p in plans:
        cats.setdefault(p["_cat"], 0)
        cats[p["_cat"]] += 1
    print("归类结果:", json.dumps(cats, ensure_ascii=False))

    ev, cs = fetch_evaluations()
    maps = fetch_maps(tok)
    direct = fetch_direct_maps(tok, maps)
    data = {"generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "roleState": role_state,
            "evaluations": ev,
            "courseSurveys": cs,
            "resigned": fetch_resigned(tok),
            "maps": maps,
            "directMaps": direct,
            "categories": list(dict.fromkeys([c for c, _ in CATEGORY_RULES] + [k for k in cats if k not in [x for x, _ in CATEGORY_RULES]])),
            "plans": []}

    n_ok = n_fail = 0
    # 请假手工名单：data/leave.json（无文件视为空）
    # 格式：{"planId或计划名": {"阶段名": ["员工ID或姓名", ...]}}
    leaves = {}
    if os.path.exists("data/leave.json"):
        try:
            leaves = json.load(open("data/leave.json", encoding="utf-8"))
            print(f"请假名单: {len(leaves)} 个计划")
        except Exception as e:
            print(f"  [警告] leave.json 解析失败: {e}")
    for p in plans:
        print(f"- {p['_cat']} | {p['planName']}")
        try:
            detail = fetch_plan_detail(tok, p)
            lv = leaves.get(str(p["planId"])) or leaves.get(p["planName"]) or {}
            if lv:
                detail["leaves"] = lv
            data["plans"].append(detail)
            n_ok += 1
        except Exception as e:
            print(f"  [计划整体失败] {p['planName']}: {e}")
            n_fail += 1
            data["plans"].append({"planId": p["planId"], "planName": p["planName"],
                                  "category": p["_cat"], "fetchError": str(e)[:200]})

    # fix204：截至昨日进度冻结统计（凌晨算/白天沿用，详见 attach_frozen 注释）
    attach_frozen(data)

    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    out_path = os.path.join(HERE, "data", "data.json")
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(f"\n完成: 成功{n_ok} 失败{n_fail} -> data.json ({os.path.getsize(out_path)//1024} KB)")

if __name__ == "__main__":
    main()
