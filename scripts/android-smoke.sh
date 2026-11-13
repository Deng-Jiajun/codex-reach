#!/usr/bin/env bash
set -euo pipefail

package=io.github.dengjiajun.codexreach.verification
mkdir -p artifacts
trap 'adb logcat -d > artifacts/logcat.txt || true' EXIT
adb logcat -c
{
  adb shell getprop ro.build.version.release
  adb shell getprop ro.product.cpu.abi
  adb shell getconf PAGE_SIZE
  adb shell dumpsys webviewupdate
} > artifacts/android-environment.txt
apk=android/app/build/outputs/apk/debug/app-debug.apk
adb install -r "${UPGRADE_APK:-$apk}"
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

for stage in write persist; do
  if [[ "$stage" == persist ]]; then
    adb install -r "$apk" | tee artifacts/upgrade-install.txt
    grep -q Success artifacts/upgrade-install.txt
  fi
  adb shell am force-stop "$package"
  adb shell am instrument -w -r \
    -e class io.github.dengjiajun.codexreach.SQLiteBridgeTest \
    -e stage "$stage" \
    "$package.test/androidx.test.runner.AndroidJUnitRunner" \
    | tee "artifacts/instrumentation-$stage.txt"
  grep -q 'OK (1 test)' "artifacts/instrumentation-$stage.txt"
done

adb pull "/sdcard/Android/data/$package/files/verification-write.png" artifacts/
adb pull "/sdcard/Android/data/$package/files/verification-persist.png" artifacts/

python3 scripts/chat-fixture.py > artifacts/chat-fixture.txt 2>&1 &
fixture_pid=$!
trap 'kill "$fixture_pid"; adb logcat -d > artifacts/logcat.txt || true' EXIT
for stage in chat chat-persist; do
  if [[ "$stage" == chat-persist ]]; then
    curl --fail --silent --request POST http://127.0.0.1:4320/control/offline
  fi
  adb shell am force-stop "$package"
  adb shell am instrument -w -r \
    -e class io.github.dengjiajun.codexreach.ChatFlowTest \
    -e stage "$stage" \
    "$package.test/androidx.test.runner.AndroidJUnitRunner" \
    | tee "artifacts/instrumentation-$stage.txt"
  grep -q 'OK (1 test)' "artifacts/instrumentation-$stage.txt"
  adb pull "/sdcard/Android/data/$package/files/verification-$stage.png" artifacts/
done
curl --fail --silent http://127.0.0.1:4320/control/stats > artifacts/chat-stats.json
python3 -c 'import json; from pathlib import Path; assert json.loads(Path("artifacts/chat-stats.json").read_text(encoding="utf-8"))["sends"] == 1'

adb shell am force-stop "$package"
adb shell am instrument -w -r \
  -e class io.github.dengjiajun.codexreach.TaskFlowTest \
  "$package.test/androidx.test.runner.AndroidJUnitRunner" \
  | tee artifacts/instrumentation-task-flow.txt
grep -q 'OK (1 test)' artifacts/instrumentation-task-flow.txt
adb pull "/sdcard/Android/data/$package/files/verification-task-flow.png" artifacts/
curl --fail --silent http://127.0.0.1:4320/control/stats > artifacts/task-stats.json

for stage in approvals questions question-persist skills-edit; do
  adb shell am force-stop "$package"
  adb shell am instrument -w -r \
    -e class io.github.dengjiajun.codexreach.InteractionFlowTest \
    -e stage "$stage" \
    "$package.test/androidx.test.runner.AndroidJUnitRunner" \
    | tee "artifacts/instrumentation-interaction-$stage.txt"
  grep -q 'OK (1 test)' "artifacts/instrumentation-interaction-$stage.txt"
  adb pull "/sdcard/Android/data/$package/files/verification-interaction-$stage.png" artifacts/
done
curl --fail --silent http://127.0.0.1:4320/control/interaction-stats > artifacts/interaction-stats.json
python3 - <<'PY'
import json
from pathlib import Path

stats = json.loads(Path("artifacts/interaction-stats.json").read_text(encoding="utf-8"))
assert len(stats["responses"]) == 7
assert type(stats["responses"][0]["approvalRequestId"]) is int
assert type(stats["responses"][1]["approvalRequestId"]) is str
assert len(stats["messageRequests"]) == 3
assert len(stats["editRequests"]) == 1
assert stats["postCounts"] == {"respond": 7, "messages": 3, "edit": 1}
assert stats["openCount"] == 0
PY

adb logcat -d -s CodexReachVerification:I '*:S' > artifacts/sqlite-results.txt
python3 - <<'PY'
import json
from pathlib import Path

lines = Path("artifacts/sqlite-results.txt").read_text(encoding="utf-8").splitlines()
results = [json.loads(line[line.index('{'):]) for line in lines if '{' in line]
assert len(results) == 2, f"Expected two results, got {len(results)}"
assert results[0]["stage"] == "write" and results[1]["stage"] == "persist"
assert results[0]["token"] == results[1]["token"], "Stored token changed after process restart"
print(json.dumps(results, ensure_ascii=False, indent=2))
Path("artifacts/sqlite-results.json").write_text(
    json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
PY
