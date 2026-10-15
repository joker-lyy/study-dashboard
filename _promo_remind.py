# -*- coding: utf-8 -*-
"""每月25号晋升提报提醒：推送到企微机器人（晋升提报群）。
用法：python _promo_remind.py [--dry]
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WECOM_KEY = "a09cfa00-21e5-46b1-8316-84a90f726bac"
LINK = "https://joker-lyy.github.io/study-dashboard/signup.html"
DRY = "--dry" in sys.argv

MD = (
    "📢 **每月25号 · 晋升提报提醒**\n"
    "各位店长：本月晋升提报通道已开启，请于近期完成提报。\n"
    "提报入口：<%s|点击进入「直营店晋升提报」>\n"
    "填写内容：门店 / 姓名 / 提报职位\n"
    "⚠️ 提报前请确认员工已完成当前职位学习地图的全部内容，\n"
    "提交后培训部将核对学习进度并回复确认。" % LINK
)


def main():
    body = json.dumps({"msgtype": "markdown", "markdown": {"content": MD}}).encode("utf-8")
    if DRY:
        print(MD)
        print("bytes =", len(MD.encode("utf-8")))
        return
    req = urllib.request.Request(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + WECOM_KEY,
        data=body, headers={"Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=25).read())
    if resp.get("errcode") != 0:
        print("[promo-remind] 推送失败:", resp)
        sys.exit(2)
    print("[promo-remind] 提醒推送 OK")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print("[promo-remind] 异常:", e)
        sys.exit(1)
