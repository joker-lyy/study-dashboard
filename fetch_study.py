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
    return "其他"

def _sign(n, t):
    return hashlib.sha256(f"{n}{t}{SECRET}".encode()).hexdigest()

def login():
    nonce = "".join(random.choices(string.ascii_letters + string.digits, k=16))
    ts = int(time.time() * 1000)
    body = {"sign": _sign(nonce, ts), "nonce": nonce, "timestamp": ts,
            "phoneModel": "Mozilla/5.0", "platform": "browser", "clientVersion": "4.0.0",
            "loginType": "W", "ent": "cjss", "username": "888",
            "password": hashlib.md5("Aa123456".encode()).hexdigest()}
    req = urllib.request.Request(HOST + "/auth/login?version=1", data=json.dumps(body).encode(), method="POST")
    for k, v in [("Content-Type", "application/json"), ("Accept", "*/*"),
                 ("Origin", "https://zhyy.ruipos.com"), ("Referer", "https://zhyy.ruipos.com/")]:
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=20) as r:
        j = json.loads(r.read())
    print("login OK")
    return j["data"]["token"]

def call(tok, path, body):
    req = urllib.request.Request(HOST + path, data=json.dumps(body).encode(), method="POST")
    for k, v in [("Content-Type", "application/json"), ("Accept", "application/json"),
                 ("token", tok), ("ent", "cjss"),
                 ("Origin", "https://zhyy.ruipos.com"), ("Referer", "https://zhyy.ruipos.com/"),
                 ("timeZone", "Asia/Shanghai")]:
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read())
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
    with ThreadPoolExecutor(max_workers=8) as ex:
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
    每张地图用 /web/reportForm/learnStatisticsEmpOfMap 分页拉全部在职学员进度。"""
    d, err = call(tok, "/web/learnMap/list?version=1", {"pageIndex": 1, "pageSize": 50})
    if err or not d:
        print(f"[学习地图] 列表失败: {err}")
        return []
    maps = []
    for m in d.get("list", []):
        maps.append({"mapId": m.get("mapId"), "mapName": m.get("mapName"),
                     "categoryName": m.get("categoryName"), "status": m.get("status")})
    print(f"学习地图: {len(maps)} 张")

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

    with ThreadPoolExecutor(max_workers=3) as ex:
        maps = list(ex.map(fetch_map_emps, maps))
    return maps

SUPABASE_URL = "https://furiqmhvflnjllrwfhyw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cmlxbWh2ZmxuamxscndmaHl3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTY4MzU3NywiZXhwIjoyMTAxMjU5NTc3fQ.XVZGKGRWhaLG7ZyaYJzPmGI8SJxxBqYZy-fq7bvKz_E"  # service_role，仅本机脚本使用，绝不出现在前端

def _fetch_puzzle(game):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/puzzle_records?game=eq.{game}&order=time.desc&limit=1000",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.loads(r.read())
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
    evals = []
    for r in _fetch_puzzle("lecture_eval"):
        evals.append({"store": r["store"], "time": r["time"],
                      "by": r.get("by", ""), "th": r.get("th", ""),
                      "tech": r.get("tech", ""), "prac": r.get("prac", ""),
                      "course": r.get("course", "")})
    print(f"讲师评估: {len(evals)} 条")
    surveys = _fetch_puzzle("course_survey")
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
    tok = login()
    plans = fetch_all_plans(tok)
    n_before = len(plans)
    plans = [p for p in plans if not any(k in (p["planName"] or "") for k in PLAN_EXCLUDE)]
    print(f"过滤测试/XX计划: {n_before} -> {len(plans)}")
    for p in plans:
        p["_cat"] = classify(p["planName"] or "")
        if not p["_cat"] and p["categoryName"]:
            p["_cat"] = classify(p["categoryName"]) or "其他"

    cats = {}
    for p in plans:
        cats.setdefault(p["_cat"], 0)
        cats[p["_cat"]] += 1
    print("归类结果:", json.dumps(cats, ensure_ascii=False))

    ev, cs = fetch_evaluations()
    data = {"generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "evaluations": ev,
            "courseSurveys": cs,
            "resigned": fetch_resigned(tok),
            "maps": fetch_maps(tok),
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

    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    out_path = os.path.join(HERE, "data", "data.json")
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(f"\n完成: 成功{n_ok} 失败{n_fail} -> data.json ({os.path.getsize(out_path)//1024} KB)")

if __name__ == "__main__":
    main()
