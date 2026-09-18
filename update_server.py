# -*- coding: utf-8 -*-
"""学习看板 · 本地服务（端口 8767）= 静态页面 + 更新接口

页面上的「🔄 更新数据」按钮会请求本服务：
- GET  /ping、/api/ping  探活（看板管家与页面心跳都用它）
- GET  /status           当前任务状态 + 日志尾部
- POST /update           开始抓数(fetch_study.py)并推送(_push_inc.py)，同时只允许一个任务
- 其余路径              直接托管本目录静态文件 → 打开 http://localhost:8767/index.html 就是学习看板

① 无黑框：由「启动看板.vbs」/看板管家用 pythonw 无窗口拉起
② 空闲自退：网页关掉后约 3 分钟自动退出，不在后台留进程（正在更新时不退）
"""
import collections
import json
import os
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8767
DIR = os.path.dirname(os.path.abspath(__file__))
PY = r"C:\Users\honor\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
LOG_PATH = os.path.join(DIR, "data", "_update_log.txt")

IDLE_EXIT = int(os.environ.get("BOARD_IDLE_EXIT", "180"))     # 秒；0 = 不退（常驻）

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
                       encoding="utf-8", errors="replace", timeout=1800)
    out = (p.stdout or "") + (p.stderr or "")
    for ln in out.splitlines():
        if ln.strip():
            log(ln.strip()[:300])
    return p.returncode, out


def update_job():
    global state
    try:
        log("===== 开始更新 =====")
        rc1, out1 = run_step([PY, "fetch_study.py"])
        ok1 = rc1 == 0 and "完成: 成功" in out1 and "成功0 失败" not in out1
        if not ok1:
            state.update(running=False, lastOk=False, lastMsg="抓数失败，不推送")
            log("!! 抓数失败，不推送")
            return
        log("抓数完成，开始推送...")
        rc2, out2 = run_step([PY, "_push_inc.py", "页面手动更新"])
        ok2 = rc2 == 0 and ("main 更新 OK" in out2 or "OK ->" in out2)
        if ok2:
            commit = ""
            for ln in out2.splitlines():
                if "main 更新 OK" in ln:
                    commit = ln.split("->")[-1].strip()
            state.update(running=False, lastOk=True, lastMsg="更新完成 %s" % commit)
            log("===== 更新完成 commit=%s =====" % commit)
        else:
            state.update(running=False, lastOk=False, lastMsg="推送失败")
            log("!! 推送失败")
    except Exception as e:
        state.update(running=False, lastOk=False, lastMsg="异常: %s" % e)
        log("!! 异常: %s" % e)


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
            return self._json({"ok": True, **state, "log": list(log_tail)[-30:]})
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
        if self.path.startswith("/update"):
            with lock:
                if state["running"]:
                    return self._json({"ok": False, "msg": "已有更新在进行中"}, 409)
                state.update(running=True, startedAt=time.strftime("%H:%M:%S"),
                             lastMsg="更新中...", lastOk=None)
                log_tail.clear()
            threading.Thread(target=update_job, daemon=True).start()
            return self._json({"ok": True, "msg": "更新已开始，约7分钟"})
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
    threading.Thread(target=idle_guard, daemon=True).start()
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
    except OSError:
        # 端口已被占用 = 已有实例在跑（管家重复拉起时直接退出）
        pass
