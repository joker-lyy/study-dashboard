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
        return self._json({"ok": False}, 404)

    def log_message(self, *a):
        """每个请求都会走到这里 —— 用它记录"页面还在"，其余（含静态文件）静音不刷屏"""
        touch()
        if self.path.startswith("/data/"):
            return
        pass


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
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
    except OSError:
        # 端口已被占用 = 已有实例在跑（管家重复拉起时直接退出）
        pass
