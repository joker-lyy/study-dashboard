# -*- coding: utf-8 -*-
"""学习看板 · 本地服务（端口 8767）= 静态页面 + 更新接口

页面上的「🔄 更新数据」按钮会请求本服务：
- GET  /ping、/api/ping  探活（看板管家与页面心跳都用它）
- GET  /status           当前任务状态 + 日志尾部
- POST /update           开始抓数(fetch_study.py)并推送(_push_inc.py)，同时只允许一个任务
- 其余路径              直接托管本目录静态文件 → 打开 http://localhost:8767/index.html 就是学习看板

① 无黑框：由「启动看板.vbs」/看板管家用 pythonw 无窗口拉起
② 空闲自退：网页关掉后约 3 分钟自动退出，不在后台留进程（正在更新时不退）
③ 触发来源：POST /update?src=xxx 决定推送理由（timer→定时刷新；夜间快照更新→原样透传；
   不传→页面手动更新），最终进 _push_inc.py 的提交信息与通知判定（与 board_butler.py 约定一致）
④ 本机（Rain）补丁、勿提交入库：PY 指向本机 python（honor 基线的写死路径在本机不存在）、
   子进程不弹窗、启动时顺带保活看板管家 8766
"""
import collections
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 被 pythonw（无控制台）启动时 stdout 为 None，print 会抛异常 → 兜底到空设备
if sys.stdout is None or sys.stderr is None:
    _devnull = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stdout or _devnull
    sys.stderr = sys.stderr or _devnull

PORT = 8767
DIR = os.path.dirname(os.path.abspath(__file__))
# 本机 python 路径（honor 基线写死 honor 路径在本机不存在 → 子进程必挂）
PY = os.environ.get("STUDY_PY") or r"C:\Users\Rain\.workbuddy\binaries\python\versions\3.13.12\python.exe"
PYW = os.environ.get("STUDY_PYW") or r"C:\Users\Rain\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"
LOG_PATH = os.path.join(DIR, "data", "_update_log.txt")

IDLE_EXIT = int(os.environ.get("BOARD_IDLE_EXIT", "180"))     # 秒；0 = 不退（常驻）

# 子进程不弹黑框（pythonw 下无影响；普通 python 拉起时防闪窗）
_CREATIONFLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

# 本机直连 opener（127.0.0.1 不走系统代理：代理环境下裸 urlopen 会 502，
# 导致 _butler_alive 误判管家不在 → 每次启动都重复拉起一个管家，2026-09-21 加固）
_OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))

state = {"running": False, "startedAt": None, "lastMsg": "", "lastOk": None}
log_tail = collections.deque(maxlen=200)
lock = threading.Lock()

_last_hit = time.time()


def touch():
    global _last_hit
    _last_hit = time.time()


def log(msg):
    line = time.strftime("[%H:%M:%S] ") + str(msg)
    log_tail.append(line)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def run_step(args):
    p = subprocess.run(args, cwd=DIR, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=1800,
                       creationflags=_CREATIONFLAGS)
    out = (p.stdout or "") + (p.stderr or "")
    for ln in out.splitlines():
        if ln.strip():
            log(ln.strip()[:300])
    return p.returncode, out


def update_job(reason="页面手动更新"):
    global state
    try:
        log("===== 【学习看板】开始更新（%s）=====" % reason)
        rc1, out1 = run_step([PY, "fetch_study.py"])
        ok1 = rc1 == 0 and "完成: 成功" in out1 and "成功0 失败" not in out1
        if not ok1:
            state.update(running=False, lastOk=False, lastMsg="【学习看板】抓数失败，不推送")
            log("!! 抓数失败，不推送")
            return
        log("【学习看板】抓数完成，开始推送...")
        rc2, out2 = run_step([PY, "_push_inc.py", reason])
        ok2 = rc2 == 0 and ("main 更新 OK" in out2 or "OK ->" in out2)
        if ok2:
            commit = ""
            for ln in out2.splitlines():
                if "main 更新 OK" in ln:
                    commit = ln.split("->")[-1].strip()
            state.update(running=False, lastOk=True, lastMsg="更新完成 %s" % commit)
            log("===== 更新完成 commit=%s =====" % commit)
        else:
            state.update(running=False, lastOk=False, lastMsg="【学习看板】推送失败")
            log("!! 推送失败")
    except Exception as e:
        state.update(running=False, lastOk=False, lastMsg="异常: %s" % e)
        log("!! 异常: %s" % e)


def _promo_secrets():
    """晋升报名管理用的 Supabase service key（仅存本地 data/_promo_secrets.json，不入库）。"""
    try:
        with open(os.path.join(DIR, "data", "_promo_secrets.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _promo_relay(method, qs, body=None):
    """浏览器中继兜底（10/16）：TCP TLS 被 SNI 阻断但浏览器内核能通 → 无头 Edge 页面内 fetch 转发。"""
    import subprocess
    node = r"C:\Users\Rain\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
    relay = os.path.join(DIR, "_promo_relay.js")
    if not (os.path.exists(node) and os.path.exists(relay)):
        return 502, {"ok": False, "msg": "浏览器中继不可用（缺 node 或 _promo_relay.js）"}
    payload = json.dumps({"method": method, "qs": qs, "body": body}).encode("utf-8")
    try:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # 10/17 修复：弹黑色 node 窗
        r = subprocess.run([node, relay], input=payload, capture_output=True, timeout=120,
                           cwd=os.path.dirname(relay) or ".", creationflags=flags)
        out = (r.stdout or b"").decode("utf-8", "ignore").strip().splitlines()
        j = json.loads(out[-1]) if out else {}
        return int(j.get("status") or 0), j.get("data")
    except Exception as e:
        return 502, {"ok": False, "msg": "relay:%s" % e}


def _promo_proxy(method, qs, body=None):
    """本机代理转发 Supabase REST（本机 TLS 被代理重置 → 由 8767 服务端直连）。"""
    import urllib.error
    sec = _promo_secrets()
    if not sec:
        return 500, {"ok": False, "msg": "缺少 data/_promo_secrets.json"}
    url = "%s/rest/v1/puzzle_records%s" % (sec["url"], qs)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": sec["serviceKey"], "Authorization": "Bearer " + sec["serviceKey"],
        "Content-Type": "application/json", "Prefer": "return=representation"})
    try:
        # 用默认 opener（走系统代理）：本机直连 supabase 会被重置，浏览器/代理链路才是通的
        with urllib.request.urlopen(req, timeout=20) as r:
            txt = r.read().decode("utf-8")
            return r.status, (json.loads(txt) if txt else [])
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {"ok": False, "msg": "HTTP %s" % e.code}
        # 系统代理 502/503/504（CONNECT 打不通）→ 直连兜底重试（10/15 高瑞瑜删除失败实锤）
        if e.code in (502, 503, 504):
            c, d = _promo_direct(req)
            if not (200 <= c < 300):
                return _promo_relay(method, qs, body)
            return c, d
        return e.code, body
    except Exception as e:
        # 系统代理失败 → 直连兜底 → 浏览器中继（三条路总有一条通，10/16）
        c, d = _promo_direct(req, first_err=e)
        if not (200 <= c < 300):
            return _promo_relay(method, qs, body)
        return c, d


def _promo_direct(req, first_err=None):
    import urllib.error
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(req, timeout=20) as r:
            txt = r.read().decode("utf-8")
            return r.status, (json.loads(txt) if txt else [])
    except urllib.error.HTTPError as e2:
        try:
            return e2.code, json.loads(e2.read().decode("utf-8"))
        except Exception:
            return e2.code, {"ok": False, "msg": "HTTP %s" % e2.code}
    except Exception as e2:
        return 502, {"ok": False, "msg": "proxy:%s direct:%s" % (first_err or "n/a", e2)}


# ── 公开课学习明细按需代理（10/28）：前端点开课程 → 这里登录平台拉员工学习明细 ──
_hyy_tok = {"tok": None, "ts": 0.0}

def _hyy_login():
    """复用 fetch_study 登录（带签名），token 缓存 90 分钟。"""
    if _hyy_tok["tok"] and time.time() - _hyy_tok["ts"] < 5400:
        return _hyy_tok["tok"]
    sys.path.insert(0, DIR)
    import fetch_study
    tok, _ = fetch_study.login()
    _hyy_tok.update(tok=tok, ts=time.time())
    return tok

def _pub_course_emp(course_id):
    """拉单门公开课的全部员工学习明细（门店员工，pageSize=100 翻页聚合）。"""
    import urllib.error
    rows = []
    page = 1
    while page <= 30:
        body = {"courseId": int(course_id), "pageNumber": page, "pageSize": 100,
                "isStoreEmp": 1, "workStatus": "zc"}
        req = urllib.request.Request(
            "https://zhyyapp.ruipos.com/web/train/report/course/emp/list?version=1",
            data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", "Accept": "*/*",
                     "Origin": "https://zhyy.ruipos.com", "Referer": "https://zhyy.ruipos.com/",
                     "ent": "cjss", "timezone": "Asia/Shanghai", "token": _hyy_login()})
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(req, timeout=30) as r:
            j = json.loads(r.read().decode("utf-8"))
        if j.get("status") != 0:
            raise RuntimeError(str(j)[:200])
        d = j.get("data") or {}
        rows.extend(d.get("list") or [])
        if d.get("lastPage") or not d.get("list"):
            break
        page += 1
    rows.sort(key=lambda x: x.get("finishTime") or "", reverse=True)
    return rows


def _butler_alive():
    try:
        with _OP.open("http://127.0.0.1:8766/health", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def _ensure_butler():
    """看板管家（8766）不在时用 pythonw 拉起：定时刷新、页面 wake 都依赖管家。
    端口已被占 = 管家已在跑，直接返回。"""
    if _butler_alive():
        return
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        subprocess.Popen([PYW, os.path.join(DIR, "board_butler.py")], cwd=DIR,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags)
        log("已自动拉起看板管家(8766)")
    except Exception as e:
        log("!! 拉起看板管家失败: %s" % e)


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    # ---- 通用响应头：CORS（页面从 file:// 或别处打开也能心跳）+ 禁缓存 ----
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # LNA（Local Network Access）：公网页面(GitHub Pages)→127.0.0.1 请求需要（fix226 同款）
        self.send_header("Access-Control-Allow-Private-Network", "true")
        if not self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/ping", "/api/ping"):
            touch()
            return self._json({"ok": True, "idleExit": IDLE_EXIT,
                               "sinceHit": round(time.time() - _last_hit, 1),
                               **state, "log": list(log_tail)[-30:]})
        if p == "/status":
            return self._json({**state, "log": list(log_tail)[-60:]})
        if p == "/api/cat_overrides":
            try:
                with open(os.path.join(DIR, "data", "cat_overrides.json"), encoding="utf-8") as f:
                    m = json.load(f)
            except Exception:
                m = {}
            return self._json({"ok": True, "overrides": m})
        if p == "/api/promo_records":
            code, data = _promo_proxy("GET", "?game=eq.promo_signup&select=id,store,name,time&order=time.desc&limit=200")
            return self._json({"ok": code == 200, "rows": data if isinstance(data, list) else []}, 200)
        if p.startswith("/api/pub_course_emp"):
            touch()
            try:
                q = parse_qs(urlparse(self.path).query)
                cid = (q.get("courseId") or [""])[0].strip()
                if not cid.isdigit():
                    return self._json({"ok": False, "msg": "缺少 courseId"}, 400)
                rows = _pub_course_emp(cid)
                return self._json({"ok": True, "rows": rows})
            except Exception as e:
                return self._json({"ok": False, "msg": str(e)[:200]}, 500)
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0].startswith("/update"):
            # 解析 ?src= 触发来源（board_butler.py：timer=白天定时；夜间快照更新=22:30 夜间档）
            src = ""
            try:
                q = parse_qs(urlparse(self.path).query)
                src = (q.get("src") or [""])[0].strip()
            except Exception:
                pass
            reason = {"timer": "定时刷新"}.get(src) or src or "页面手动更新"
            with lock:
                if state["running"]:
                    return self._json({"ok": False, "msg": "【学习看板】已有更新在进行中"}, 409)
                state.update(running=True, startedAt=time.strftime("%H:%M:%S"),
                             lastMsg="【学习看板】更新中...", lastOk=None)
                log_tail.clear()
            threading.Thread(target=update_job, args=(reason,), daemon=True).start()
            return self._json({"ok": True, "msg": "【学习看板】更新已开始，约7分钟"})
        if self.path.split("?")[0] == "/api/cat_overrides":
            # 页面「移动课程分类」的落盘入口：覆盖记录写入 data/cat_overrides.json，
            # 随下次更新推送进仓库，线上也能恢复（不再只存浏览器 localStorage）
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                ov = body.get("overrides") if isinstance(body, dict) else None
                if not isinstance(ov, dict):
                    raise ValueError("overrides 必须是对象")
                path = os.path.join(DIR, "data", "cat_overrides.json")
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(ov, f, ensure_ascii=False, indent=1)
                os.replace(tmp, path)
                log("分类覆盖已保存: %d 项" % len(ov))
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"ok": False, "msg": str(e)}, 400)
        if self.path.split("?")[0] in ("/api/promo_del", "/api/promo_upd", "/api/promo_add"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                path0 = self.path.split("?")[0]
                if path0 == "/api/promo_add":
                    ins = {"game": "promo_signup", "store": body.get("store") or "",
                           "name": body.get("name") or "{}", "time": int(body.get("time") or 0), "errors": 0}
                    code, data = _promo_proxy("POST", "", ins)
                else:
                    rid = str(body.get("id") or "").strip()
                    if not rid:
                        raise ValueError("缺少 id")
                    if path0 == "/api/promo_del":
                        code, data = _promo_proxy("DELETE", "?id=eq.%s&game=eq.promo_signup" % rid)
                    else:
                        upd = {}
                        for k in ("store", "name", "time"):
                            if body.get(k) is not None:
                                upd[k] = body[k]
                        if not upd:
                            raise ValueError("缺少要更新的字段")
                        code, data = _promo_proxy("PATCH", "?id=eq.%s&game=eq.promo_signup" % rid, upd)
                log("晋升报名 %s → HTTP %s %s" % (path0.rsplit("_", 1)[-1], code, json.dumps(data, ensure_ascii=False)[:200] if code >= 300 else ""))
                return self._json({"ok": 200 <= code < 300, "msg": None if 200 <= code < 300 else ("HTTP %s" % code)})
            except Exception as e:
                return self._json({"ok": False, "msg": str(e)}, 400)
        return self._json({"ok": False}, 404)

    def log_message(self, *a):
        """每个请求都会走到这里 —— 用它记录"页面还在"，其余（含静态文件）静音不刷屏"""
        touch()
        if self.path.startswith("/data/"):
            return
        pass


def promo_notify_loop():
    """每 2 分钟跑一次 _promo_notify.py：轮询新晋升提报 → 判定学习进度 → 推企微。
    断点在 data/promo_state.json（lastTs），服务停摆期间漏的会在下次启动补推。"""
    py = sys.executable
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_promo_notify.py")
    while True:
        try:
            subprocess.run([py, script], capture_output=True, timeout=300,
                           creationflags=_CREATIONFLAGS)
        except Exception as e:
            print("[promo-notify] loop err:", e)
        time.sleep(120)


def idle_guard():
    """关掉网页后自动退出（Rain 要求：不留后台和黑框）。正在更新时不退。"""
    while True:
        time.sleep(5)
        if IDLE_EXIT <= 0:
            continue
        if state.get("running"):
            continue
        if time.time() - _last_hit > IDLE_EXIT:
            os._exit(0)


if __name__ == "__main__":
    touch()
    _ensure_butler()
    threading.Thread(target=idle_guard, daemon=True).start()
    threading.Thread(target=promo_notify_loop, daemon=True).start()
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
    except OSError:
        # 端口已被占用 = 已有实例在跑（管家重复拉起时直接退出）
        pass
