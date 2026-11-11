"""Serve synthetic chat data for the Android HTTP and persistence checks."""

import base64
import copy
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


def interaction_request(request_id, method, params, **details):
    return {
        "id": request_id, "method": method,
        "params": {"threadId": "fixture-interactions", "turnId": "interaction-turn", **params},
        **details,
    }


def initial_interaction_state():
    return {
        "revision": 1, "pulse": 0, "receipts": {}, "responses": [],
        "messageRequests": [], "editRequests": [], "openCount": 0,
        "postCounts": {"respond": 0, "messages": 0, "edit": 0},
        "awaitingMessages": [], "awaitingEdits": [], "skillReady": False,
        "editableTurn": None,
        "turns": [{"id": "interaction-turn", "status": "completed", "messages": [
            {"id": "interaction-user", "kind": "user", "text": "INTERACTION_USER", "phase": None},
            {"id": "interaction-pulse", "kind": "assistant", "text": "INTERACTION_PULSE_0", "phase": "final_answer"},
        ]}],
        "pending": [
            interaction_request(47, "item/commandExecution/requestApproval", {
                "itemId": "command-item", "kind": "command", "startedAtMs": 1794326400000,
                "approvalId": "callback-id-is-not-request-id", "environmentId": None,
                "reason": "COMMAND_NUMERIC_ID", "command": "fixture-tool --check", "cwd": "C:\\Example",
                "availableDecisions": ["accept", {"acceptWithExecpolicyAmendment": {
                    "execpolicy_amendment": ["fixture-tool", "--check"]}}, "decline", "cancel"],
            }),
            interaction_request("47", "item/fileChange/requestApproval", {
                "itemId": "file-item", "startedAtMs": 1794326400000,
                "reason": "FILE_STRING_ID", "grantRoot": "C:\\Example\\output",
            }, changes=[{"path": "C:\\Example\\output\\result.txt", "kind": {"type": "update"},
                "diff": "@@ -1 +1 @@\n-before\n+after"}]),
            interaction_request("network-rule", "item/commandExecution/requestApproval", {
                "itemId": "network-item", "kind": "command", "startedAtMs": 1794326400000,
                "environmentId": None, "command": "fixture-network-check", "cwd": "C:\\Example",
                "availableDecisions": [{"applyNetworkPolicyAmendment": {
                    "network_policy_amendment": {"host": "fixture.invalid", "action": "deny"}}}, "cancel"],
            }),
            interaction_request("permission", "item/permissions/requestApproval", {
                "itemId": "permission-item", "startedAtMs": 1794326400000,
                "environmentId": None, "cwd": "C:\\Example", "reason": "PERMISSION_FIELDS",
                "permissions": {"network": {"enabled": True}, "fileSystem": {
                    "read": ["C:\\Example\\input"], "write": None, "globScanMaxDepth": 3,
                    "entries": [
                        {"path": {"type": "path", "path": "C:\\Example\\output"}, "access": "write"},
                        {"path": {"type": "glob_pattern", "pattern": "C:\\Example\\private\\**"}, "access": "deny"},
                    ],
                }},
            }),
            interaction_request("mcp-form", "mcpServer/elicitation/request", {
                "mode": "form", "serverName": "fixture", "message": "MCP_FORM_VALUES", "_meta": None,
                "requestedSchema": {"type": "object", "properties": {
                    "name": {"type": "string", "title": "名称", "minLength": 2},
                    "count": {"type": "integer", "title": "数量", "minimum": 1, "maximum": 3},
                    "confirmed": {"type": "boolean", "title": "确认"},
                    "mode": {"type": "string", "title": "方式", "enum": ["safe", "fast"], "enumNames": ["安全", "快速"]},
                    "features": {"type": "array", "title": "内容", "minItems": 1, "maxItems": 2,
                        "items": {"type": "string", "enum": ["logs", "summary"]}},
                    "note": {"type": "string", "title": "可选备注"},
                }, "required": ["name", "count", "confirmed", "mode", "features"]},
            }),
            interaction_request(48, "mcpServer/elicitation/request", {
                "mode": "url", "serverName": "fixture", "message": "MCP_URL_CONTINUE", "_meta": None,
                "url": "https://fixture.invalid/verification", "elicitationId": "url-elicitation-id",
            }),
            interaction_request("unsupported-form", "mcpServer/elicitation/request", {
                "mode": "form", "serverName": "fixture", "message": "UNSUPPORTED_NESTED_FORM", "_meta": None,
                "requestedSchema": {"type": "object", "properties": {"nested": {"type": "object", "properties": {}}}},
            }),
            interaction_request("verification", "mcpServer/elicitation/request", {
                "mode": "openai/userVerification", "serverName": "fixture", "title": "IDENTITY_REQUIRED",
                "description": "Synthetic desktop verification", "challenge": "synthetic-challenge", "_meta": None,
            }, desktopRequired=True),
            interaction_request("file-incomplete", "item/fileChange/requestApproval", {
                "itemId": "incomplete-file", "startedAtMs": 1794326400000, "reason": "MISSING_DIFF",
            }),
            interaction_request("completed-request", "mcpServer/elicitation/request", {
                "mode": "url", "serverName": "fixture", "message": "COMPLETED_REQUEST_MUST_HIDE", "_meta": None,
                "url": "https://fixture.invalid/completed", "elicitationId": "completed",
            }, completed=True),
        ],
    }


interaction_state = initial_interaction_state()


organization_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS9nyHwAEEAI26XT+MQAAAABJRU5ErkJggg=="
organization_files = {
    "C:/Example": {"path": "C:/Example", "name": "Example", "directory": True, "image": False},
    "C:/Example/docs": {"path": "C:/Example/docs", "name": "docs", "directory": True, "image": False},
    "C:/Example/desktop.txt": {"path": "C:/Example/desktop.txt", "name": "desktop.txt", "directory": False, "image": False},
    "C:/Example/docs/readme.md": {"path": "C:/Example/docs/readme.md", "name": "readme.md", "directory": False, "image": False},
    "C:/Example/photo.png": {"path": "C:/Example/photo.png", "name": "photo.png", "directory": False, "image": True},
    "C:/Example/history.png": {"path": "C:/Example/history.png", "name": "history.png", "directory": False, "image": True},
}


def initial_organization_state():
    return {
        "receipts": {}, "pinRequests": [], "forkRequests": [], "forkPosts": 0, "forkCreateCount": 0,
        "fileQueries": [], "resolveRequests": [], "uploadRequests": [], "previewRequests": [],
        "uploadedFiles": {}, "uploadedData": {}, "messageRequests": [], "sendPosts": 0, "sendCount": 0,
        "pendingFork": None, "awaitingMessages": [], "pinned": {},
        "threads": {"fixture-organization": {
            "id": "fixture-organization", "title": "组织与附件验证", "cwd": "C:/Example", "revision": 1,
            "turns": [{"id": "organization-history", "status": "completed", "messages": [
                {"id": "organization-user", "kind": "user", "text": "ORGANIZATION_USER", "phase": None,
                    "attachments": [organization_files["C:/Example/history.png"]]},
                {"id": "organization-answer", "kind": "assistant", "text": "QUOTE_SOURCE_LINE\n第二行可引用", "phase": "final_answer"},
            ]}],
        }},
    }


organization_state = initial_organization_state()


def organization_listing(path):
    paths = {
        None: (None, ["C:/"]),
        "C:/": (None, ["C:/Example"]),
        "C:/Example": ("C:/", ["C:/Example/docs", "C:/Example/desktop.txt", "C:/Example/photo.png"]),
        "C:/Example/docs": ("C:/Example", ["C:/Example/docs/readme.md"]),
    }
    if path not in paths:
        return None
    parent, children = paths[path]
    entries = []
    for child in children:
        item = organization_files.get(child, {"name": child, "path": child, "directory": True})
        entries.append({"name": item["name"], "path": child, "directory": item["directory"],
            "size": None if item["directory"] else 70 if child.endswith(".png") else 24})
    return {"path": path, "parent": parent, "entries": entries}


def release_organization_fork():
    request_id = organization_state["pendingFork"]
    if request_id is None:
        return
    child = copy.deepcopy(organization_state["threads"]["fixture-organization"])
    child["id"] = "fixture-organization-child"
    child["title"] = "组织分支验证"
    organization_state["threads"][child["id"]] = child
    organization_state["forkCreateCount"] += 1
    organization_state["receipts"][request_id].update({"status": "accepted", "result": {
        "threadId": child["id"], "synchronization": {"status": "complete"},
    }})
    organization_state["pendingFork"] = None


def release_organization_messages():
    for request in organization_state["awaitingMessages"]:
        chat = organization_state["threads"][request["chatId"]]
        chat["turns"].append({"id": "organization-send-" + request["requestId"], "status": "completed", "messages": [
            {"id": "organization-sent-user-" + request["requestId"], "kind": "user", "text": request["prompt"], "phase": None,
                "attachments": copy.deepcopy(request.get("attachments", []))},
            {"id": "organization-sent-assistant-" + request["requestId"], "kind": "assistant", "text": "ORGANIZATION_ATTACHMENTS_OK", "phase": "final_answer"},
        ]})
        chat["revision"] += 1
        organization_state["receipts"][request["requestId"]]["status"] = "accepted"
    organization_state["awaitingMessages"].clear()


def same_request_id(left, right):
    return type(left) is type(right) and left == right


def release_interaction_messages():
    for request in interaction_state["awaitingMessages"]:
        prompt = request["prompt"]
        replies = None
        if prompt.startswith("<send_user_message_question_reply>\n"):
            replies = json.loads(prompt.split("\n", 1)[1].rsplit("\n", 1)[0])
        turn_id = "interaction-message-" + request["requestId"]
        user_id = "user-" + request["requestId"]
        user = {"id": user_id, "kind": "user", "text": prompt, "phase": None}
        if replies:
            user["questionReplies"] = replies
        interaction_state["turns"].append({"id": turn_id, "status": "completed", "messages": [
            user, {"id": "reply-" + request["requestId"], "kind": "assistant", "phase": "final_answer",
                "text": "ASYNC_REPLY_ACCEPTED" if replies else "SKILL_PRE_EDIT_REPLY"},
        ]})
        if not replies:
            interaction_state["editableTurn"] = {"turnId": turn_id, "messageId": user_id, "prompt": prompt}
        interaction_state["receipts"][request["requestId"]]["status"] = "accepted"
        interaction_state["receipts"][request["requestId"]]["error"] = None
    interaction_state["awaitingMessages"].clear()


def release_interaction_edits():
    for request in interaction_state["awaitingEdits"]:
        turn_index = next(index for index, turn in enumerate(interaction_state["turns"]) if turn["id"] == request["turnId"])
        turn_id = "interaction-edited-" + request["requestId"]
        user_id = "edited-user-" + request["requestId"]
        interaction_state["turns"][turn_index:] = [{"id": turn_id, "status": "completed", "messages": [
            {"id": user_id, "kind": "user", "text": request["prompt"], "phase": None},
            {"id": "edited-reply", "kind": "assistant", "text": "EDIT_REPLACED_REPLY", "phase": "final_answer"},
        ]}]
        interaction_state["editableTurn"] = {"turnId": turn_id, "messageId": user_id, "prompt": request["prompt"]}
        interaction_state["receipts"][request["requestId"]]["status"] = "accepted"
    interaction_state["awaitingEdits"].clear()


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
        if url.path == "/control/interaction-stats":
            with condition:
                self.reply({key: interaction_state[key] for key in [
                    "responses", "messageRequests", "editRequests", "openCount", "postCounts",
                ]})
            return
        if url.path == "/control/organization-stats":
            with condition:
                self.reply({key: organization_state[key] for key in [
                    "pinRequests", "forkRequests", "forkPosts", "forkCreateCount", "fileQueries", "resolveRequests",
                    "uploadRequests", "previewRequests", "messageRequests", "sendPosts", "sendCount",
                ]})
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
            elif url.path == "/api/files":
                path = parse_qs(url.query).get("path", [None])[0]
                organization_state["fileQueries"].append(path)
                result = organization_listing(path)
                if result is None:
                    self.reply({"error": "合成目录不存在"}, 404)
                    return
            elif url.path.startswith("/api/threads/fixture-organization") and url.path.endswith("/pin"):
                chat_id = url.path.split("/")[3]
                result = {"pinned": organization_state["pinned"].get(chat_id, False)}
            elif url.path.endswith("/settings"):
                task = task_state["task"] if url.path == "/api/threads/fixture-task/settings" else None
                result = {"model": task["model"] if task else "fixture-standard", "thinking": task["thinking"] if task else "low"}
            elif url.path == "/api/threads":
                result = {"threads": [
                    {"id": "fixture-chat", "title": "连接与缓存验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": state["status"], "updatedAt": 1794326400},
                    {"id": "fixture-error", "title": "历史读取异常验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": "idle", "updatedAt": 1794326400},
                    {"id": "fixture-loading", "title": "加载状态验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": "notLoaded", "updatedAt": 1794326400},
                    {"id": "fixture-interactions", "title": "审批与问答验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": "idle", "updatedAt": 1794326400},
                ], "nextCursor": None}
                if task_state["task"]:
                    result["threads"].append({"id": "fixture-task", "title": "任务创建验证", "projectId": "fixture-project", "cwd": "C:\\Example", "status": task_state["task"]["status"], "updatedAt": 1794326400})
                for chat in organization_state["threads"].values():
                    result["threads"].append({"id": chat["id"], "title": chat["title"], "projectId": "fixture-project",
                        "cwd": chat["cwd"], "status": "idle", "updatedAt": 1794326400,
                        "pinned": organization_state["pinned"].get(chat["id"], False)})
            elif url.path.startswith("/api/threads/fixture-organization") and url.path.endswith(("/history", "/live")):
                chat_id = url.path.split("/")[3]
                chat = organization_state["threads"].get(chat_id)
                if chat is None:
                    self.reply({"error": "合成分支尚未创建"}, 404)
                    return
                if url.path.endswith("/live"):
                    if parse_qs(url.query).get("after", [None])[0] == str(chat["revision"]):
                        condition.wait(timeout=0.4)
                    result = {"available": True, "revision": str(chat["revision"]), "turns": chat["turns"],
                        "complete": True, "status": "idle", "activeTurnId": None, "requests": [], "waiting": False,
                        "editableTurn": None, "model": "fixture-standard"}
                else:
                    result = {"id": chat_id, "title": chat["title"], "cwd": chat["cwd"], "status": "idle",
                        "turns": chat["turns"], "nextCursor": None, "hasMore": False}
            elif url.path in ("/api/threads/fixture-interactions/history", "/api/threads/fixture-interactions/live"):
                if url.path.endswith("/live"):
                    if parse_qs(url.query).get("after", [None])[0] == str(interaction_state["revision"]):
                        condition.wait(timeout=0.4)
                    result = {"available": True, "revision": str(interaction_state["revision"]),
                        "turns": interaction_state["turns"], "complete": True, "status": "idle",
                        "activeTurnId": None, "model": "fixture-standard", "requests": interaction_state["pending"],
                        "waiting": any(not request.get("completed") for request in interaction_state["pending"]),
                        "editableTurn": interaction_state["editableTurn"]}
                else:
                    result = {"id": "fixture-interactions", "title": "审批与问答验证", "cwd": "C:\\Example", "status": "idle",
                        "turns": interaction_state["turns"], "nextCursor": None, "hasMore": False}
            elif url.path == "/api/threads/fixture-interactions/skills":
                result = {"skills": [
                    {"name": "interaction-check", "path": "C:\\Skills\\interaction-check\\SKILL.md", "description": "精确协议与交互核对"},
                    {"name": "review-only", "path": "C:\\Skills\\review-only\\SKILL.md", "description": "只读代码审查"},
                ], "errors": [], "sendingSupported": interaction_state["skillReady"]}
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
                result = state["requests"].get(request_id) or task_state["requests"].get(request_id) or interaction_state["receipts"].get(request_id) or organization_state["receipts"].get(request_id)
                if result is None:
                    self.reply({"error": "未找到发送记录"}, 404)
                    return
            else:
                self.reply({"error": "Unknown fixture endpoint"}, 404)
                return
            self.reply(result)

    def do_POST(self):
        if self.path in ("/control/organization-reset", "/control/release-organization-fork", "/control/release-organization-message"):
            with condition:
                if self.path == "/control/organization-reset":
                    organization_state.clear()
                    organization_state.update(initial_organization_state())
                    state["online"] = True
                elif self.path == "/control/release-organization-fork":
                    release_organization_fork()
                else:
                    release_organization_messages()
                condition.notify_all()
                self.reply({"ok": True})
            return
        if self.path in ("/control/interactions-reset", "/control/interaction-pulse", "/control/resolve-response",
                "/control/interaction-questions", "/control/message-unknown", "/control/release-message", "/control/release-edit"):
            with condition:
                if self.path == "/control/interactions-reset":
                    interaction_state.clear()
                    interaction_state.update(initial_interaction_state())
                    state["online"] = True
                elif self.path == "/control/interaction-pulse":
                    interaction_state["pulse"] += 1
                    interaction_state["turns"][0]["messages"][1]["text"] = f"INTERACTION_PULSE_{interaction_state['pulse']}"
                elif self.path == "/control/resolve-response":
                    interaction_state["pending"] = [pending for pending in interaction_state["pending"] if not any(
                        same_request_id(pending["id"], response["approvalRequestId"]) for response in interaction_state["responses"])]
                elif self.path == "/control/interaction-questions":
                    interaction_state["pending"] = [interaction_request("sync-input", "item/tool/requestUserInput", {
                        "itemId": "input-item", "questions": [
                            {"id": "choice", "header": "方式", "question": "请选择处理方式", "isOther": True, "isSecret": False,
                                "options": [{"label": "检查", "description": "先检查"}, {"label": "继续", "description": "继续执行"}]},
                            {"id": "detail", "header": "说明", "question": "补充处理说明", "isOther": True, "isSecret": False, "options": None},
                        ],
                    })]
                    interaction_state["turns"][0]["messages"].append({"id": "async-question-item", "kind": "assistant",
                        "text": "ASYNC_QUESTIONS_READY", "phase": "commentary", "questions": [
                            {"title": "选择下一步", "options": ["检查", "继续"]},
                            {"title": "填写后续说明", "options": None},
                        ]})
                elif self.path == "/control/message-unknown":
                    for request in interaction_state["awaitingMessages"]:
                        receipt = interaction_state["receipts"][request["requestId"]]
                        receipt["status"] = "unknown"
                        receipt["error"] = "合成回执暂时无法确认"
                elif self.path == "/control/release-message":
                    release_interaction_messages()
                else:
                    release_interaction_edits()
                interaction_state["revision"] += 1
                condition.notify_all()
                self.reply({"ok": True})
            return
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
        if self.path.startswith("/api/files/"):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with condition:
                if self.path == "/api/files/resolve":
                    organization_state["resolveRequests"].append(request)
                    files = {**organization_files, **organization_state["uploadedFiles"]}
                    if any(path not in files for path in request["paths"]):
                        self.reply({"error": "合成附件不存在"}, 404)
                        return
                    self.reply({"attachments": [files[path] for path in request["paths"]]})
                elif self.path == "/api/files/upload":
                    data = base64.b64decode(request["data"], validate=True)
                    if len(data) > 20 * 1024 * 1024:
                        self.reply({"error": "上传文件不能超过 20 MiB"}, 422)
                        return
                    path = "C:/Example/uploads/" + str(len(organization_state["uploadRequests"]) + 1) + "/" + request["name"]
                    attachment = {"path": path, "name": request["name"], "directory": False,
                        "image": request["name"].lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp"))}
                    organization_state["uploadedFiles"][path] = attachment
                    organization_state["uploadedData"][path] = request["data"]
                    organization_state["uploadRequests"].append({"name": request["name"], "size": len(data), "path": path})
                    self.reply(attachment)
                elif self.path == "/api/files/preview":
                    path = request["path"]
                    organization_state["previewRequests"].append(request)
                    data = organization_state["uploadedData"].get(path)
                    if data is None and path in ("C:/Example/photo.png", "C:/Example/history.png"):
                        data = organization_png
                    if data is None:
                        self.reply({"error": "合成图片不存在"}, 404)
                        return
                    self.reply({"mime": "image/png", "data": data})
                else:
                    self.reply({"error": "Unknown fixture endpoint"}, 404)
            return
        if self.path.startswith("/api/threads/fixture-organization") and self.path.endswith(("/pin", "/fork", "/messages")):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            chat_id = self.path.split("/")[3]
            operation = self.path.rsplit("/", 1)[1]
            with condition:
                if operation == "pin":
                    organization_state["pinRequests"].append({"chatId": chat_id, **request})
                    organization_state["pinned"][chat_id] = request["pinned"]
                    self.reply({"pinned": request["pinned"]})
                    return
                request_id = request["requestId"]
                organization_state["forkPosts" if operation == "fork" else "sendPosts"] += 1
                receipt = organization_state["receipts"].get(request_id)
                if receipt is None:
                    if operation == "fork":
                        organization_state["forkRequests"].append({"chatId": chat_id, **request})
                        organization_state["pendingFork"] = request_id
                    else:
                        message = {"chatId": chat_id, **request}
                        organization_state["messageRequests"].append(message)
                        organization_state["awaitingMessages"].append(message)
                        organization_state["sendCount"] += 1
                    receipt = {"requestId": request_id, "chatId": chat_id, "status": "sending", "error": None, "result": None}
                    organization_state["receipts"][request_id] = receipt
                self.reply(receipt, 202)
            return
        if self.path == "/api/threads/fixture-interactions/open":
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with condition:
                interaction_state["openCount"] += 1
                interaction_state["skillReady"] = True
                self.reply({"ok": True})
            return
        if self.path in ("/api/threads/fixture-interactions/respond", "/api/threads/fixture-interactions/messages", "/api/threads/fixture-interactions/edit"):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            operation = self.path.rsplit("/", 1)[1]
            with condition:
                interaction_state["postCounts"][operation] += 1
                request_id = request["requestId"]
                receipt = interaction_state["receipts"].get(request_id)
                if receipt:
                    self.reply(receipt, 202)
                    return
                if operation == "respond":
                    if not any(not pending.get("completed") and same_request_id(pending["id"], request["approvalRequestId"])
                            for pending in interaction_state["pending"]):
                        self.reply({"error": "待处理请求已变化"}, 409)
                        return
                    interaction_state["responses"].append(request)
                elif operation == "messages":
                    interaction_state["messageRequests"].append(request)
                    interaction_state["awaitingMessages"].append(request)
                else:
                    if not interaction_state["editableTurn"] or request["turnId"] != interaction_state["editableTurn"]["turnId"]:
                        self.reply({"error": "可编辑轮次已变化"}, 409)
                        return
                    interaction_state["editRequests"].append(request)
                    interaction_state["awaitingEdits"].append(request)
                receipt = {"requestId": request_id, "chatId": "fixture-interactions",
                    "status": "accepted" if operation == "respond" else "sending", "error": None, "result": {"ok": True}}
                interaction_state["receipts"][request_id] = receipt
                self.reply(receipt, 202)
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
