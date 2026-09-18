# -*- coding: utf-8 -*-
"""【学习看板】更新结果通知（企微机器人）。

在 GitHub Actions 里由 daily-update.yml 的最后一步（if: always()）调用：
无论成功还是失败，都会往企微群推一条带【学习看板】标识的消息。

本地手动测试（PowerShell）：
  $env:WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
  $env:JOB_STATUS="success"; python notify_wecom.py --test
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data" / "data.json"
SITE = "https://joker-lyy.github.io/study-dashboard/"
TAG = "【学习看板】"

STEP_LABELS = [
    ("FETCH_OUTCOME", "抓取数据"),
    ("VERIFY_OUTCOME", "校验抓取结果"),
    ("PUBLISH_OUTCOME", "提交并发布数据"),
    ("NOTIFY_ONLY_OUTCOME", "仅推送测试"),
]


def beijing_now():
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")


def read_data():
    """读取本轮抓取结果；读不到就返回 None（失败场景下很常见）。"""
    try:
        d = json.loads(DATA.read_text(encoding="utf-8"))
    except Exception:
        return None
    plans = d.get("plans") or []
    ok = [p for p in plans if not p.get("fetchError")]
    bad = [p for p in plans if p.get("fetchError")]
    size_kb = DATA.stat().st_size // 1024 if DATA.exists() else 0
    return {"plans": plans, "len": len(plans), "ok": len(ok), "bad": len(bad),
            "generatedAt": d.get("generatedAt") or "-", "size_kb": size_kb,
            "badNames": [str(p.get("planName") or p.get("name") or "?") for p in bad][:3]}


def failed_steps():
    out = []
    for env_key, label in STEP_LABELS:
        v = (os.environ.get(env_key) or "").strip().lower()
        if v and v not in ("success", "skipped"):
            out.append("%s(%s)" % (label, v))
    return out


def reason_from_log():
    """从抓取日志尾部取一条有用的失败原因。"""
    log = HERE / "fetch.log"
    if not log.exists():
        return ""
    try:
        tail = log.read_text(encoding="utf-8", errors="replace").strip().splitlines()
    except Exception:
        return ""
    skip = ("抓取", "开始", "完成", "进度", "===")
    for line in reversed(tail[-80:]):
        s = line.strip()
        if not s or any(s.startswith(k) for k in skip):
            continue
        if any(k in s for k in ("Error", "error", "失败", "异常", "Traceback",
                                "timed out", "Timeout", "TimeoutError", "HTTP")):
            return s[:220]
    return (tail[-1].strip()[:220] if tail else "")


def run_url():
    rid = os.environ.get("GITHUB_RUN_ID")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if rid and repo:
        return "https://github.com/%s/actions/runs/%s" % (repo, rid)
    return ""


def build_message(status, test=False):
    st = read_data()
    best = (st or {}).get("generatedAt", "-")
    ok = (st or {}).get("ok", 0)
    bad = (st or {}).get("bad", 0)
    lines = ["时间：" + beijing_now()]

    if status == "success":
        lines.append("计划数：%d 个（成功 %d / 失败 %d）" % ((st or {}).get("len", ok + bad), ok, bad))
        if bad:
            lines.append("未抓到的计划：" + "、".join((st or {}).get("badNames") or []) + "（下轮自动重试）")
        lines.append("数据大小：%d KB" % (st or {}).get("size_kb", 0))
        lines.append("数据生成时间：" + str(best))
        lines.append("线上地址：" + SITE)
        head = TAG + "✅ 每日自动更新成功"
        if test:
            head += "（测试消息，可忽略）"
    else:
        lines.append("失败环节：" + ("、".join(failed_steps()) or "未知"))
        why = reason_from_log()
        if why:
            lines.append("原因：" + why)
        lines.append("线上仍是上一版数据，页面不会挂")
        if run_url():
            lines.append("运行日志：" + run_url())
        head = TAG + "❌ 每日自动更新失败"

    return head + "\n" + "\n".join(lines)


def send(text):
    hook = (os.environ.get("WECOM_WEBHOOK") or "").strip()
    if not hook:
        print("[warn] 未提供 WECOM_WEBHOOK，跳过推送")
        print(text)
        return 0
    body = json.dumps({"msgtype": "text", "text": {"content": text}}).encode()
    req = urllib.request.Request(hook, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            res = json.loads(r.read().decode("utf-8", "replace"))
        print("[notify]", res)
        return 0 if res.get("errcode") == 0 else 1
    except Exception as e:
        print("[notify] 推送异常:", e)
        return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", default=os.environ.get("JOB_STATUS", "success"),
                    help="success / failure / cancelled（非 success 一律按失败播报）")
    ap.add_argument("--test", action="store_true", help="本地测试：消息里注明是测试")
    a = ap.parse_args()
    msg = build_message("success" if a.status == "success" else "failure", test=a.test)
    print(msg)
    print("-" * 40)
    return send(msg)


if __name__ == "__main__":
    sys.exit(main())
