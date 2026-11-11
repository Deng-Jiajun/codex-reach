"""Serve synthetic chat data for the Android HTTP and persistence checks."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

condition = threading.Condition()
state = {
    "online": True,
    "history_error": True,
    "revision": 1,
    "status": "idle",
    "requests": {},
    "turns": [{
        "id": "initial-turn", "status": "completed",
        "messages": [{"id": "welcome", "kind": "assistant", "text": "连接已准备就绪。", "phase": "final_answer"}],
    }],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def reply(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if self.headers.get("Authorization") != "Bearer fixture-access":
            self.reply({"error": "访问密钥无效"}, 401)
            return False
        if not state["online"]:
            self.reply({"error": "测试服务暂时离线"}, 503)
            return False
        return True

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/control/stats":
            self.reply({"sends": len(state["requests"])})
            return
        if not self.authorized():
            return
        if url.path == '/api/threads':
            time.sleep(1)
        with condition:
            if url.path == "/api/status":
                result = {"serverId": "android-fixture", "version": "0.2.0", "desktopConnected": True}
            elif url.path == "/api/projects":
                result = {"projects": [{"id": "fixture-project", "name": "验证项目", "path": "C:\\Example"}]}
            elif url.path == "/api/threads":
                result = {"threads": [
                    {"id": "fixture-chat", "title": "连接与缓存验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": state["status"], "updatedAt": 1794326400},
                    {"id": "fixture-error", "title": "历史读取异常验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": "idle", "updatedAt": 1794326400},
                ], "nextCursor": None}
            elif url.path == "/api/threads/fixture-error/history":
                if state["history_error"]:
                    self.reply({"error": "此会话历史暂时无法读取"}, 422)
                    return
                result = {"id": "fixture-error", "title": "历史读取异常验证", "cwd": "C:\\Example", "status": "idle",
                    "turns": [{"id": "recovered", "status": "completed", "messages": [{"id": "ok", "kind": "assistant", "text": "READ_ERROR_RECOVERED", "phase": "final_answer"}]}],
                    "nextCursor": None, "hasMore": False}
            elif url.path == "/api/threads/fixture-error/live":
                result = {"available": False}
            elif url.path == "/api/threads/fixture-chat/history":
                result = {"id": "fixture-chat", "title": None, "cwd": "C:\\Example", "status": state["status"], "turns": state["turns"], "nextCursor": None, "hasMore": False}
            elif url.path == "/api/threads/fixture-chat/live":
                after = parse_qs(url.query).get("after", [None])[0]
                if after == str(state["revision"]):
                    condition.wait(timeout=2)
                result = {"available": True, "revision": str(state["revision"]), "turns": state["turns"], "complete": True, "status": state["status"], "model": "fixture", "waiting": False}
            elif url.path.startswith("/api/requests/"):
                result = state["requests"].get(url.path.rsplit("/", 1)[1])
                if result is None:
                    self.reply({"error": "未找到发送记录"}, 404)
                    return
            else:
                self.reply({"error": "Unknown fixture endpoint"}, 404)
                return
            self.reply(result)

    def do_POST(self):
        if self.path == "/control/history-ok":
            with condition:
                state["history_error"] = False
            self.reply({"ok": True})
            return
        if self.path in ("/control/offline", "/control/online"):
            with condition:
                state["online"] = self.path == "/control/online"
                if state["online"]:
                    state["turns"][-1]["messages"].append({
                        "id": f"reconnected-{state['revision']}", "kind": "assistant",
                        "text": "REACH_RECONNECTED", "phase": "final_answer",
                    })
                    state["revision"] += 1
                condition.notify_all()
            self.reply({"ok": True})
            return
        if not self.authorized():
            return
        if self.path != "/api/threads/fixture-chat/messages":
            self.reply({"error": "Unknown fixture endpoint"}, 404)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with condition:
            request_id = request["requestId"]
            receipt = state["requests"].get(request_id)
            if receipt is None:
                receipt = {"requestId": request_id, "chatId": "fixture-chat", "status": "accepted", "error": None}
                state["requests"][request_id] = receipt
                state["turns"].append({
                    "id": request_id, "status": "inProgress",
                    "messages": [{"id": "sent-user", "kind": "user", "text": request["prompt"], "phase": None}],
                })
                state["status"] = "active"
                state["revision"] += 1
                condition.notify_all()
                threading.Thread(target=finish_reply, daemon=True).start()
            self.reply(receipt, 202)


def finish_reply():
    time.sleep(0.4)
    with condition:
        state["turns"][-1]["messages"].append({
            "id": "sent-assistant", "kind": "assistant", "phase": "final_answer",
            "text": "## 连接验证通过\n\nREACH_CHAT_OK\n\n| 检查 | 结果 |\n| --- | --- |\n| HTTP 收发 | 通过 |\n| 本地缓存 | 已保存 |\n\n```text\nmessage → Rust service → Codex\n```\n\n<script>window.fixtureScriptExecuted = true</script>",
        })
        state["turns"][-1]["status"] = "completed"
        state["status"] = "idle"
        state["revision"] += 1
        condition.notify_all()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 4320), Handler).serve_forever()
