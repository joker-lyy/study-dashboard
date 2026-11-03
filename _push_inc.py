# -*- coding: utf-8 -*-
"""【学习看板】本地推送：把本轮 data 变更发布到 GitHub main + 企微通知。

被 update_server.py 调用：python _push_inc.py <触发原因>
与 honor 机旧版不同（旧版内嵌 GitHub 令牌走 HTTPS，因此被 gitignore）：
本机走 SSH 主通道（仓库已配 core.sshCommand = id_ed25519_hyy），文件内无任何令牌，
但文件名保持 _push_inc.py（update_server.py 按此名调用，且 .gitignore 已忽略它）。

成功判定行（update_server.py 依赖，勿改格式）：
    main 更新 OK -> <commit>

企微通知 webhook 来源（优先级）：
    环境变量 WECOM_WEBHOOK > data/wecom_webhook.txt（本地文件，不入库）
    都没有则跳过通知（不影响发布流程）。
"""
import datetime
import json
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = "【学习看板】"
SITE = "https://joker-lyy.github.io/study-dashboard/"
DATA_FILES = ["data/data.json", "data/cat_overrides.json", "data/leave.json", "data/fission_feishu_map.json",
              "data/public_course_emp.json", "data/known_maps.json"]  # fix241: 公开课花名册/明细随增量更新，不再停在手工刷新版

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _git_exe():
    """定位 git：优先 WorkBuddy 便携版（无窗口环境系统 PATH 不可靠），回落系统 PATH。
    返回 (git可执行路径, 需前置到PATH的目录或None)。"""
    try:
        base = r"C:\Users\Rain\.workbuddy\binaries\PortableGit\versions"
        for v in sorted(os.listdir(base), reverse=True):
            p = os.path.join(base, v, "cmd", "git.exe")
            if os.path.exists(p):
                return p, os.path.dirname(p)
    except Exception:
        pass
    return "git", None


GIT_EXE, GIT_DIR = _git_exe()


def _run(args):
    env = dict(os.environ)
    if GIT_DIR:
        env["PATH"] = GIT_DIR + os.pathsep + env.get("PATH", "")
    # 无窗口/无交互环境兜底（与 hyy-dashboard _run_git 同约定）
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    env["GIT_ASKPASS"] = "echo"
    return subprocess.run([GIT_EXE] + args, cwd=HERE, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=300, env=env)


def beijing_now():
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")


def data_stats():
    try:
        p = os.path.join(HERE, "data", "data.json")
        d = json.loads(open(p, encoding="utf-8").read())
        plans = d.get("plans") or []
        ok = sum(1 for x in plans if not x.get("fetchError"))
        return {"n": len(plans), "ok": ok, "bad": len(plans) - ok,
                "size": os.path.getsize(p) // 1024, "gen": d.get("generatedAt") or "-"}
    except Exception:
        return None


def webhook():
    v = (os.environ.get("WECOM_WEBHOOK") or "").strip()
    if v:
        return v
    p = os.path.join(HERE, "data", "wecom_webhook.txt")
    if os.path.exists(p):
        try:
            return open(p, encoding="utf-8").read().strip()
        except Exception:
            pass
    return ""


def notify(text):
    hook = webhook()
    if not hook:
        print("[notify] 未配置 WECOM_WEBHOOK / data/wecom_webhook.txt，跳过企微通知")
        print(text)
        return 0
    body = json.dumps({"msgtype": "text", "text": {"content": text[:2000]}}).encode()
    req = urllib.request.Request(hook, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            res = json.loads(r.read().decode("utf-8", "replace"))
        print("[notify]", res)
        return 0 if res.get("errcode") == 0 else 1
    except Exception as e:
        print("[notify] 推送异常:", e)
        return 1


def commit_msg(reason):
    return "%sdata: 本地%s %s" % (TAG, reason, beijing_now())


def main():
    reason = sys.argv[1] if len(sys.argv) > 1 else "手动更新"

    _run(["add"] + DATA_FILES)
    if _run(["diff", "--cached", "--quiet"]).returncode == 0:
        print("数据无变化，跳过提交")
        print("main 更新 OK -> no-change")
        return 0

    c = _run(["commit", "-m", commit_msg(reason)])
    if c.returncode != 0:
        print("commit 失败:", (c.stderr or c.stdout or "")[:400])
        notify(TAG + "❌ 手动更新发布失败\n时间：" + beijing_now()
               + "\n触发：" + reason + "\n原因：git commit 失败\n"
               + (c.stderr or "")[:150])
        return 1

    # 先同步远端再推（与云端 workflow 同策略：冲突时以本地新抓数据为准）
    pull = _run(["pull", "--rebase", "origin", "main"])
    if pull.returncode != 0:
        print("rebase 冲突，改为以本地新数据为准")
        _run(["rebase", "--abort"])
        _run(["fetch", "origin", "main"])
        _run(["reset", "--soft", "origin/main"])
        _run(["add"] + DATA_FILES)
        c = _run(["commit", "-m", commit_msg(reason)])
        if c.returncode != 0:
            print("二次 commit 失败:", (c.stderr or "")[:400])
            return 1

    push = _run(["push", "origin", "main"])
    if push.returncode != 0:
        print("push 失败:", (push.stderr or push.stdout or "")[:500])
        notify(TAG + "❌ 手动更新发布失败\n时间：" + beijing_now()
               + "\n触发：" + reason + "\n原因：git push 失败\n"
               + (push.stderr or "")[:150])
        return 1

    sha = (_run(["rev-parse", "--short", "HEAD"]).stdout or "").strip()
    print("main 更新 OK -> " + sha)

    st = data_stats()
    lines = [TAG + "✅ 手动更新完成",
             "触发：" + reason,
             "时间：" + beijing_now()]
    if st:
        lines.append("计划数：%d 个（成功 %d / 失败 %d）" % (st["n"], st["ok"], st["bad"]))
        lines.append("数据大小：%d KB" % st["size"])
        lines.append("数据生成时间：" + str(st["gen"]))
    lines.append("线上地址：" + SITE)
    if reason in ("定时刷新", "夜间快照更新"):
        # 2026-09-20 与 Rain 约定：白天定时刷新不发企微成功通知；
        # 夜间 22:20 更新的通知由 _night_snapshot.js 发快照图替代；
        # 凌晨 00:05 云端更新的通知走 GitHub Actions notify_wecom.py，不受影响。
        print("[notify] 定时类更新（%s）按约定不发企微成功通知" % reason)
    else:
        notify("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
