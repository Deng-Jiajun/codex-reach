"""Check the packaged service's versioned HTTP routes without a running desktop."""
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
binary = Path(sys.argv[1]).resolve()

with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = {"serverId": "fixture", "callerThreadId": str(uuid.uuid4()), "apiKey": "fixture",
              "appToolsPipe": r"\\.\pipe\reach-api-test-" + uuid.uuid4().hex, "listen": ["127.0.0.1:0"]}
    (home / "server.json").write_text(json.dumps(config), encoding="utf-8")
    process = subprocess.Popen([binary], env={**os.environ, "CODEX_REACH_HOME": directory},
                               stdout=subprocess.PIPE, encoding="utf-8")
    try:
        address = process.stdout.readline().strip().removeprefix("Codex Reach listening on http://")
        assert address.startswith("127.0.0.1:"), address

        def request(method, path, data=None, key="fixture"):
            connection = http.client.HTTPConnection(address, timeout=5)
            try:
                connection.request(method, path, json.dumps(data) if data is not None else None,
                                   {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                reply = connection.getresponse()
                return reply.status, reply.read()
            finally:
                connection.close()

        base = "/api/" + version
        upload = {"id": str(uuid.uuid4()), "name": "sample.txt", "size": 0}
        for prefix in ("/api", "/api/0.6.8-preview"):
            for method, path, body in (("GET", "/status", None), ("POST", "/uploads", upload)):
                status, payload = request(method, prefix + path, body)
                assert status == 412 and "同步更新" in json.loads(payload)["error"], (prefix, status)
        assert request("POST", base + "/uploads", upload, key="invalid")[0] == 401
        with closing(sqlite3.connect(home / "uploads" / ".uploads.db")) as db:
            assert db.execute("SELECT count(*) FROM uploads").fetchone() == (0,)
        status, payload = request("POST", base + "/uploads", upload)
        assert status == 200 and json.loads(payload)["id"] == upload["id"], status
        assert request("GET", base + "/uploads/" + upload["id"])[0] == 200
        for old_path in ("/files/upload", "/files/preview"):
            assert request("POST", base + old_path, {})[0] == 404
        assert request("POST", base + "/threads/test/approval", {"policy": "never"})[0] == 422
    finally:
        process.terminate()
        process.wait(timeout=10)
        process.stdout.close()
print("Matching, missing and mismatched API versions verified")
