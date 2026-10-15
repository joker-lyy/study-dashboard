# -*- coding: utf-8 -*-
"""晋升提报通知：轮询 Supabase puzzle_records(game=promo_signup) 新提报，
从 data.json 学习地图判定学习进度，推送到企微机器人。
用法：python _promo_notify.py [--dry]   （--dry 只打印不推送、不写状态）
网络层与 fetch_study.py 同款（urllib 自动走 Windows 系统代理）。
状态：data/promo_state.json { lastTs } —— 只处理 time > lastTs 的提报。
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SUPABASE_URL = "https://furiqmhvflnjllrwfhyw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cmlxbWh2ZmxuamxscndmaHl3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTY4MzU3NywiZXhwIjoyMTAxMjU5NTc3fQ.XVZGKGRWhaLG7ZyaYJzPmGI8SJxxBqYZy-fq7bvKz_E"  # service_role，仅本机脚本使用
WECOM_KEY = "a09cfa00-21e5-46b1-8316-84a90f726bac"  # 晋升提报机器人
DRY = "--dry" in sys.argv


def _open(req, timeout=25):
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8")


_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch_signup_rows(last_ts):
    """取 time>last_ts 的新提报。优先走本机 8767 管家代理（supabase service key 在服务端，
    本机直连/系统代理到 supabase 长期被 TLS 重置）；失败再降级直连 supabase。"""
    try:
        txt = _NO_PROXY.open("http://localhost:8767/api/promo_records", timeout=15).read().decode("utf-8")
        j = json.loads(txt)
        if j.get("ok"):
            rows = j.get("rows") or []
            rows = [r for r in rows if int(r.get("time") or 0) > last_ts]
            rows.sort(key=lambda r: int(r.get("time") or 0))
            print("[promo-notify] 经 8767 代理取到 %d 条新提报" % len(rows))
            return rows
        print("[promo-notify] 8767 代理返回失败:", j.get("msg"))
    except Exception as e:
        print("[promo-notify] 8767 代理不可用:", e)
    q = "%s/rest/v1/puzzle_records?game=eq.promo_signup&time=gt.%d&order=time.asc&limit=50" % (SUPABASE_URL, last_ts)
    req = urllib.request.Request(q, headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    return json.loads(_open(req) or "[]")


def norm(s):
    return (s or "").replace(" ", "").replace("\u3000", "").strip()


def judge_progress(data, store, name):
    """返回 (status, text)。status: done/undone/notfound"""
    sN, nN = norm(store), norm(name)
    hits = []
    for mp in data.get("maps") or []:
        if (mp.get("categoryName") or "") != "晋升":
            continue
        for e in mp.get("emps") or []:
            if norm(e.get("employeeName")) != nN:
                continue
            esN = norm(e.get("storeName") or "")
            if not esN or (esN != sN and sN not in esN and esN not in sN):
                continue
            hits.append({"map": mp, "emp": e})
    if not hits:
        return "notfound", "未在学习地图中找到该员工，请核对姓名与门店后重新提报"
    hits.sort(key=lambda h: -float(h["emp"].get("completionSchedule") or 0))
    dm_emps = ((data.get("directMaps") or {}).get("emps")) or {}
    lines, all_done = [], True
    for h in hits:
        mp, e = h["map"], h["emp"]
        prog = float(e.get("completionSchedule") or 0)
        done = prog >= 100
        if not done:
            all_done = False
        detail = None
        rec = dm_emps.get(str(e.get("employeeId")))
        m_rec = rec and next((m for m in rec.get("maps", []) if str(m.get("mapId")) == str(mp.get("mapId"))), None)
        if m_rec and m_rec.get("stages"):
            detail = []
            for st in m_rec["stages"]:
                for t in st.get("tasks") or []:
                    tn = t.get("taskName") or "?"
                    if str(t.get("status")) != "3":
                        detail.append("%s：%s（未完成）" % (st.get("stageName") or "", tn))
                    else:
                        score = t.get("realScore") or "-"
                        if score != "-" and float(score) < 80 and any(k in tn for k in ("考核", "考试", "练习")):
                            detail.append("%s：%s %s分（未达标）" % (st.get("stageName") or "", tn, score))
                            if done:
                                all_done = False
        lines.append({"mapName": mp.get("mapName"), "prog": prog, "done": done,
                      "stage": e.get("stageName") or "", "detail": detail})
    if all_done:
        extra = "（%s）" % "、".join("%s %.0f%%" % (l["mapName"], l["prog"]) for l in lines) if len(lines) > 1 else ""
        return "done", "已完成 ✅" + extra
    parts = ["未完成 ❌"]
    for l in lines:
        seg = "【%s】进度 %.0f%%" % (l["mapName"], l["prog"])
        if l["stage"]:
            seg += "（当前阶段：%s）" % l["stage"]
        parts.append(seg)
        if l["detail"]:
            parts.extend("· " + d for d in l["detail"])
        elif l["detail"] is None:
            parts.append("· 非直营组学员，未完成任务明细需在学习地图后台查看")
    text = "\n".join(parts)
    if len(text.encode("utf-8")) > 1600:
        text = text[:700] + "\n·（明细过长已截断，请到学习地图后台查看）"
    return "undone", text


def refresh_stores(data):
    """从 data.json 汇总门店列表刷新 data/stores.json（报名页下拉候选用）。"""
    stores = set()
    for mp in data.get("maps") or []:
        for e in mp.get("emps") or []:
            s = (e.get("storeName") or "").strip()
            if s and "测试" not in s:
                stores.add(s)
    for r in ((data.get("directMaps") or {}).get("emps") or {}).values():
        s = (r.get("store") or "").strip()
        if s and "测试" not in s:
            stores.add(s)
    try:
        out = os.path.join(HERE, "data", "stores.json")
        old = set(json.load(open(out, encoding="utf-8")).get("stores") or [])
        if stores != old:
            json.dump({"stores": sorted(stores)}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
            print("[promo-notify] stores.json 已更新: %d 家" % len(stores))
    except Exception as e:
        print("[promo-notify] stores.json 更新失败:", e)


def main():
    state_path = os.path.join(HERE, "data", "promo_state.json")
    last_ts = 0
    if os.path.exists(state_path):
        try:
            last_ts = json.load(open(state_path, encoding="utf-8")).get("lastTs") or 0
        except Exception:
            pass
    else:
        # 首次运行（断点文件缺失）：从当前时间起算，避免把全部历史提报推爆（历史名单已在管理页看过）
        last_ts = int(time.time() * 1000)
        print("[promo-notify] 断点缺失，首次运行从 now=%d 起算" % last_ts)

    rows = fetch_signup_rows(last_ts)
    rows = [r for r in rows if "测试" not in (r.get("store") or "")]
    if not rows:
        print("[promo-notify] 无新提报")
        return

    with open(os.path.join(HERE, "data", "data.json"), encoding="utf-8") as f:
        data = json.load(f)
    refresh_stores(data)
    max_ts, msgs = last_ts, []
    for r in rows:
        try:
            sig = json.loads(r.get("name") or "{}")
        except Exception:
            sig = {}
        store, name, pos = (r.get("store") or "").strip(), (sig.get("name") or "").strip(), (sig.get("position") or "").strip()
        ts = int(r.get("time") or 0)
        max_ts = max(max_ts, ts)
        if not store or not name:
            continue
        status, text = judge_progress(data, store, name)
        md = "📢 **晋升提报**\n门店：%s\n姓名：%s\n提报职位：%s\n学习进度：%s" % (store, name, pos or "-", text)
        msgs.append(md)

    if not msgs:
        print("[promo-notify] 新增行均无效")
        if not DRY:
            json.dump({"lastTs": max_ts}, open(state_path, "w", encoding="utf-8"))
        return
    if DRY:
        for m in msgs:
            print("---- [DRY] ----")
            print(m)
            print("bytes =", len(m.encode("utf-8")))
        return
    for m in msgs:
        body = json.dumps({"msgtype": "markdown", "markdown": {"content": m}}).encode("utf-8")
        req = urllib.request.Request(
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + WECOM_KEY,
            data=body, headers={"Content-Type": "application/json"})
        resp = json.loads(_open(req))
        if resp.get("errcode") != 0:
            print("[promo-notify] 推送失败:", resp)
            sys.exit(2)
        print("[promo-notify] 推送 OK")
    json.dump({"lastTs": max_ts}, open(state_path, "w", encoding="utf-8"))
    print("[promo-notify] 处理 %d 条提报，lastTs=%d" % (len(msgs), max_ts))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print("[promo-notify] 异常:", e)
        sys.exit(1)
