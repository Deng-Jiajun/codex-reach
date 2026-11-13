"""Synthetic reader, upload, queue and notification APIs for Android regression tests."""
import base64
import gzip
import hashlib
import json
import time
import uuid
from urllib.parse import parse_qs, unquote, urlparse

uploads = {}
grants = {}
events = []
queues = {}
event_reads = 0


def pdf_bytes():
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    stream = b"BT /F1 18 Tf 30 240 Td (REACH PDF CHECK) Tj ET"
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010} 00000 n \n".encode())
    result.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(result)


def binary(handler, body, content_type):
    status = 200
    total = len(body)
    content_range = None
    if handler.headers.get("Range", "").startswith("bytes="):
        start, end = handler.headers["Range"][6:].split("-")
        start, end = int(start), min(int(end or total - 1), total - 1)
        body = body[start:end + 1]
        status = 206
        content_range = f"bytes {start}-{end}/{total}"
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    if content_range:
        handler.send_header("Content-Range", content_range)
    handler.end_headers()
    handler.wfile.write(body)


def file_bytes(organization, source, fallback):
    content = organization["uploadedData"].get(source, fallback)
    return base64.b64decode(content) if isinstance(content, str) else content


def get(handler, url, organization, files, png):
    global event_reads
    path = url.path
    if path == "/control/mobile-stats":
        handler.reply({"eventReads": event_reads, "events": events, "queues": queues})
    elif path.startswith("/reader/"):
        parts = path.split("/", 3)
        name = unquote(parts[-1])
        source = grants.get(parts[2], "")
        if name.endswith(".css"):
            binary(handler, b"body{background:rgb(231,240,227)}", "text/css")
        elif name.endswith(".html"):
            binary(handler, b'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><h1>READER_HTML</h1><img src="image.png"><button onclick="document.querySelector(\'#result\').textContent=\'READER_SCRIPT_OK\'">Run</button><p id="result"></p><script>window.bridgePresent=!!window.Capacitor</script></body></html>', "text/html; charset=utf-8")
        elif name.endswith(".pdf"):
            binary(handler, pdf_bytes(), "application/pdf")
        elif name.endswith(".png"):
            binary(handler, file_bytes(organization, source, png), "image/png")
        else:
            binary(handler, file_bytes(organization, source, b"READER_TEXT_CHECK\n"), "text/plain; charset=utf-8")
    elif path == "/api/context":
        if parse_qs(url.query).get("kind", [""])[0] == "skills":
            handler.reply({"skills": [{"name": "interaction-check", "path": "C:\\Skills\\interaction-check\\SKILL.md", "description": "精确协议与交互核对"}, {"name": "review-only", "path": "C:\\Skills\\review-only\\SKILL.md", "description": "只读代码审查"}], "errors": []})
        else:
            handler.reply({"files": [{"file_name": "desktop.txt", "root": "C:/Example", "path": "desktop.txt", "match_type": "file"}]})
    elif path.startswith("/api/uploads/"):
        upload = uploads.get(path.split("/")[3])
        handler.reply(receipt(upload) if upload else {"error": "上传不存在"}, 200 if upload else 404)
    elif path.endswith("/queue"):
        handler.reply({"items": queues.get(path.split("/")[3], [])})
    elif path.endswith("/state"):
        handler.reply({"available": False})
    elif path.endswith("/approval"):
        handler.reply({"available": True, "approvalPolicy": "never", "allowed": ["never", "on-request", "untrusted"]})
    elif path == "/api/events":
        event_reads += 1
        after = int(parse_qs(url.query).get("after", ["-1"])[0])
        if after >= len(events) and after >= 0:
            time.sleep(0.5)
        handler.reply({"events": [] if after < 0 else events[after:], "cursor": len(events), "monitorError": None})
    else:
        return False
    return True


def receipt(upload):
    return {key: upload[key] for key in ["id", "name", "size", "offset", "attachment"]}


def post(handler, organization, files, png):
    path = urlparse(handler.path).path
    if not (path.startswith("/api/uploads") or path == "/api/files/read" or path.startswith("/control/mobile") or "/queue" in path or path.endswith("/read") or path.endswith("/approval")):
        return False
    if path.startswith("/api/") and not handler.authorized():
        return True
    body = handler.rfile.read(int(handler.headers.get("Content-Length", "0")))
    data = json.loads(body or b"{}")
    if path == "/control/mobile-event":
        event = {"id": data.get("id", str(uuid.uuid4())), "threadId": data.get("threadId", "fixture-organization"), "turnId": data.get("turnId", "organization-history"), "kind": data.get("kind", "completed"), "title": "组织与附件验证", "body": data.get("body", "MOBILE_EVENT"), "requestId": data.get("requestId"), "createdAt": int(time.time())}
        events.append(event)
        handler.reply(event)
    elif path == "/control/mobile-reset":
        events.clear()
        queues.clear()
        handler.reply({"ok": True})
    elif path == "/api/files/read":
        source = data["path"].replace("\\", "/")
        name = source.rsplit("/", 1)[-1]
        kind = "image" if name.endswith(".png") else "html" if name.endswith(".html") else "pdf" if name.endswith(".pdf") else "markdown" if name.endswith(".md") else "text"
        token = str(uuid.uuid4())
        grants[token] = source
        organization["previewRequests"].append({"path": source})
        content = file_bytes(organization, source, png if kind == "image" else pdf_bytes() if kind == "pdf" else b"READER_TEXT_CHECK\n")
        handler.reply({"name": name, "size": len(content), "kind": kind, "prefix": f"/reader/{token}/", "relative": name})
    elif path == "/api/uploads":
        uploads.setdefault(data["id"], {**data, "offset": 0, "attachment": None, "data": bytearray()})
        handler.reply(receipt(uploads[data["id"]]))
    elif path.startswith("/api/uploads/"):
        upload = uploads[path.split("/")[3]]
        if path.endswith("/chunk"):
            decoded = base64.b64decode(data["data"])
            upload["transferBytes"] = upload.get("transferBytes", 0) + len(decoded)
            upload["gzipChunks"] = upload.get("gzipChunks", 0) + int(data["gzip"])
            if data["gzip"]:
                decoded = gzip.decompress(decoded)
            assert hashlib.sha256(decoded).hexdigest() == data["sha256"]
            if data["offset"] == upload["offset"]:
                upload["data"].extend(decoded)
                upload["offset"] += len(decoded)
            else:
                assert upload["data"][data["offset"]:data["offset"] + len(decoded)] == decoded
        elif path.endswith("/finish") and upload["attachment"] is None:
            assert upload["offset"] == upload["size"]
            source = "C:/Example/uploads/2026-11-13/" + upload["name"]
            upload["attachment"] = {"path": source, "name": upload["name"], "directory": False, "image": upload["name"].endswith(".png")}
            organization["uploadedFiles"][source] = upload["attachment"]
            organization["uploadedData"][source] = bytes(upload["data"])
            organization["uploadRequests"].append({"name": upload["name"], "size": upload["size"], "transferBytes": upload.get("transferBytes", 0), "gzipChunks": upload.get("gzipChunks", 0), "sha256": hashlib.sha256(upload["data"]).hexdigest()})
        handler.reply(receipt(upload))
    elif path.endswith("/queue"):
        chat = path.split("/")[3]
        options = {key: value for key, value in data.items() if key not in ["requestId", "prompt"]}
        item = {"requestId": data["requestId"], "chatId": chat, "prompt": data["prompt"], "options": options, "status": "queued", "version": 0}
        if not any(existing["requestId"] == item["requestId"] for existing in queues.setdefault(chat, [])):
            queues[chat].append(item)
        handler.reply({"items": queues[chat]})
    elif "/queue/" in path:
        chat, request = path.split("/")[3], path.split("/")[-1]
        item = next(item for item in queues[chat] if item["requestId"] == request)
        if data["action"] == "cancel":
            item["status"] = "cancelled"
        elif data["action"] == "edit":
            item.update(prompt=data["prompt"], options=data["options"])
        item["version"] += 1
        handler.reply({"items": queues[chat]})
    else:
        handler.reply(data)
    return True
