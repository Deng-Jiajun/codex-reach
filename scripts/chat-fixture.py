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

models = [
    {"model": "fixture-standard", "displayName": "标准验证模型", "isDefault": True,
     "defaultReasoningEffort": "low", "supportedReasoningEfforts": [
         {"reasoningEffort": "low", "description": "低"},
         {"reasoningEffort": "high", "description": "高"},
     ]},
    {"model": "fixture-deep", "displayName": "深度验证模型", "isDefault": False,
     "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [
         {"reasoningEffort": "medium", "description": "中"},
         {"reasoningEffort": "xhigh", "description": "较高"},
     ]},
]


def initial_task_state():
    return {
        "requests": {}, "created": None, "createCount": 0,
        "parameterRequests": [], "stopRequests": [], "stopMismatches": 0,
        "task": None, "holdTaskLive": False,
        "holdInitial": True, "holdOlder": True,
        "initialReads": 0, "olderReads": 0, "loadingLiveReads": 0,
        "loadingRevision": 1,
    }


task_state = initial_task_state()


def loading_turn(older=False):
    if older:
        messages = [{"id": "loading-older", "kind": "assistant", "text": "LOADING_OLDER", "phase": "final_answer"}]
    else:
        messages = [
            {"id": "loading-latest", "kind": "assistant", "text": "LOADING_LATEST", "phase": "final_answer"},
            {"id": "loading-live", "kind": "assistant", "text": f"LOADING_LIVE_{task_state['loadingRevision']}", "phase": "final_answer"},
        ]
    return {"id": "loading-turn", "status": "completed", "messages": messages}


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
            with condition:
                self.reply({"sends": len(state["requests"]), **{
                    key: task_state[key] for key in ["created", "createCount", "parameterRequests", "stopRequests",
                        "stopMismatches", "initialReads", "olderReads", "loadingLiveReads"]
                }})
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
            elif url.path == "/api/models":
                result = {"models": models}
            elif url.path.endswith("/settings"):
                task = task_state["task"] if url.path == "/api/threads/fixture-task/settings" else None
                result = {"model": task["model"] if task else "fixture-standard", "thinking": task["thinking"] if task else "low"}
            elif url.path == "/api/threads":
                result = {"threads": [
                    {"id": "fixture-chat", "title": "连接与缓存验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": state["status"], "updatedAt": 1794326400},
                    {"id": "fixture-error", "title": "历史读取异常验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": "idle", "updatedAt": 1794326400},
                    {"id": "fixture-loading", "title": "加载状态验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": "notLoaded", "updatedAt": 1794326400},
                ], "nextCursor": None}
                if task_state["task"]:
                    result["threads"].append({"id": "fixture-task", "title": "任务创建验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": task_state["task"]["status"], "updatedAt": 1794326400})
            elif url.path == "/api/threads/fixture-loading/history":
                older = bool(parse_qs(url.query).get("cursor"))
                task_state["olderReads" if older else "initialReads"] += 1
                hold = "holdOlder" if older else "holdInitial"
                deadline = time.monotonic() + 15
                while task_state[hold] and time.monotonic() < deadline:
                    condition.wait(timeout=deadline-time.monotonic())
                if task_state[hold]:
                    self.reply({"error": "Loading verification was not released"}, 503)
                    return
                result = {"id": "fixture-loading", "title": "加载状态验证", "cwd": "C:\\Example", "status": "notLoaded",
                    "turns": [loading_turn(older)], "nextCursor": None if older else "loading-older", "hasMore": not older}
            elif url.path == "/api/threads/fixture-loading/live":
                task_state["loadingLiveReads"] += 1
                if parse_qs(url.query).get("after", [None])[0] == str(task_state["loadingRevision"]):
                    condition.wait(timeout=0.3)
                result = {"available": True, "revision": str(task_state["loadingRevision"]), "turns": [loading_turn()],
                    "complete": False, "status": "idle", "activeTurnId": None, "model": "fixture-standard", "waiting": False}
            elif url.path in ("/api/threads/fixture-task/history", "/api/threads/fixture-task/live"):
                task = task_state["task"]
                if not task:
                    self.reply({"error": "Unknown task fixture"}, 404)
                    return
                if url.path.endswith("/live"):
                    if parse_qs(url.query).get("after", [None])[0] == str(task["revision"]):
                        condition.wait(timeout=0.4)
                    deadline = time.monotonic() + 15
                    while task_state["holdTaskLive"] and time.monotonic() < deadline:
                        condition.wait(timeout=deadline-time.monotonic())
                    result = {"available": True, "revision": str(task["revision"]), "turns": task["turns"], "complete": True,
                        "status": task["status"], "activeTurnId": task["activeTurnId"], "model": task["model"], "waiting": False}
                else:
                    result = {"id": "fixture-task", "title": "任务创建验证", "cwd": "C:\\Example", "status": task["status"],
                        "turns": task["turns"], "nextCursor": None, "hasMore": False}
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
                result = {"available": True, "revision": str(state["revision"]), "turns": state["turns"], "complete": True, "status": state["status"],
                    "activeTurnId": state["turns"][-1]["id"] if state["status"] == "active" else None, "model": "fixture-standard", "waiting": False}
            elif url.path.startswith("/api/requests/"):
                request_id = url.path.rsplit("/", 1)[1]
                result = state["requests"].get(request_id) or task_state["requests"].get(request_id)
                if result is None:
                    self.reply({"error": "未找到发送记录"}, 404)
                    return
            else:
                self.reply({"error": "Unknown fixture endpoint"}, 404)
                return
            self.reply(result)

    def do_POST(self):
        if self.path in ("/control/tasks-reset", "/control/release-initial", "/control/release-older", "/control/loading-pulse", "/control/advance-task"):
            with condition:
                if self.path == "/control/tasks-reset":
                    task_state.clear()
                    task_state.update(initial_task_state())
                    state["online"] = True
                elif self.path == "/control/release-initial":
                    task_state["holdInitial"] = False
                elif self.path == "/control/release-older":
                    task_state["holdOlder"] = False
                elif self.path == "/control/loading-pulse":
                    task_state["loadingRevision"] += 1
                else:
                    task = task_state["task"]
                    task["turns"][-1]["status"] = "completed"
                    task["activeTurnId"] = "task-turn-2"
                    task["turns"].append({"id": "task-turn-2", "status": "inProgress", "messages": [
                        {"id": "task-next-turn", "kind": "assistant", "text": "TASK_NEXT_TURN", "phase": None}]})
                    task["revision"] += 1
                    task_state["holdTaskLive"] = True
                condition.notify_all()
                self.reply({"ok": True})
            return
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
        if self.path in ("/api/threads", "/api/threads/fixture-task/stop", "/api/threads/fixture-task/messages"):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with condition:
                request_id = request["requestId"]
                receipt = task_state["requests"].get(request_id)
                if receipt:
                    self.reply(receipt, 202)
                    return
                result = None
                if self.path == "/api/threads":
                    task_state["created"] = request
                    task_state["createCount"] += 1
                    task_state["task"] = {"model": request.get("model", "fixture-standard"), "thinking": request.get("thinking", "low"),
                        "status": "active", "activeTurnId": "task-turn-1", "revision": 1, "turns": [
                            {"id": "task-turn-1", "status": "inProgress", "messages": [
                                {"id": "task-user", "kind": "user", "text": request["prompt"], "phase": None},
                                {"id": "task-created", "kind": "assistant", "text": "TASK_CREATED", "phase": None},
                            ]}]}
                    result = {"threadId": "fixture-task"}
                elif self.path.endswith("/stop"):
                    task = task_state["task"]
                    task_state["stopRequests"].append(request)
                    interrupted = task["activeTurnId"] if request["expectedTurnId"] == task["activeTurnId"] else None
                    if interrupted:
                        task["status"] = "idle"
                        task["activeTurnId"] = None
                        task["turns"][-1]["status"] = "interrupted"
                        task["turns"][-1]["messages"].append({"id": "task-stopped", "kind": "assistant", "text": "TASK_STOPPED", "phase": "final_answer"})
                    else:
                        task_state["stopMismatches"] += 1
                    task["revision"] += 1
                    task_state["holdTaskLive"] = False
                    result = {"ok": True, "interruptedTurnId": interrupted}
                else:
                    task = task_state["task"]
                    task_state["parameterRequests"].append(request)
                    task["model"] = request.get("model", task["model"])
                    task["thinking"] = request.get("thinking", task["thinking"])
                    task["turns"].append({"id": request_id, "status": "completed", "messages": [
                        {"id": "parameters-user", "kind": "user", "text": request["prompt"], "phase": None},
                        {"id": "parameters-reply", "kind": "assistant", "text": "TASK_PARAMETER_OK", "phase": "final_answer"},
                    ]})
                    task["revision"] += 1
                receipt = {"requestId": request_id, "chatId": "fixture-task", "status": "accepted", "error": None, "result": result}
                task_state["requests"][request_id] = receipt
                condition.notify_all()
                self.reply(receipt, 202)
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
