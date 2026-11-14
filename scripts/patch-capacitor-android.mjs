import assert from 'node:assert/strict';
import fs from 'node:fs';

// Capacitor #8616: navigation can send a fast plugin response to the previous page.
// Keep this patch scoped to the installed version; review it on dependency upgrades.
const dependency = new URL('../node_modules/@capacitor/android/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('package.json', dependency), 'utf8'));
assert.equal(manifest.version, '8.6.0', 'Review the Capacitor reply-proxy patch for this version');
const file = new URL('capacitor/src/main/java/com/getcapacitor/MessageHandler.java', dependency);
const source = fs.readFileSync(file, 'utf8');
const newline = source.includes('\r\n') ? '\r\n' : '\n';
const dispatch = '                    postMessage(message.getData());';
const assign = '                    javaScriptReplyProxy = replyProxy;';
const before = dispatch + newline + assign;
const after = assign + newline + dispatch;
const originalCount = source.split(before).length - 1;
const patchedCount = source.split(after).length - 1;
assert.ok((originalCount === 1 && patchedCount === 0) || (originalCount === 0 && patchedCount === 1),
  'Unexpected Capacitor message handler; review the patch');
if (originalCount === 1) {
  fs.writeFileSync(file, source.replace(before, after), 'utf8');
}
console.log('Capacitor Android: reply proxy is set before plugin dispatch');
