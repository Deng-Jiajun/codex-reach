package io.github.dengjiajun.codexreach;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class OrganizationFlowTest {
    private static final String SOURCE_ID = "fixture-organization";
    private static final String QUOTED_DRAFT = "原有手机草稿";
    private static final String SYNTHETIC_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS9nyHwAEEAI26XT+MQAAAABJRU5ErkJggg==";

    @Test
    public void organizesThreadsAndRetainsAttachmentDrafts() throws Exception {
        String stage = InstrumentationRegistry.getArguments().getString("stage", "organization");
        if (stage.equals("organization")) control("organization-reset");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> view = new AtomicReference<>();
            scenario.onActivity(activity -> view.set(activity.getBridge().getWebView()));
            WebView webView = view.get();
            connectIfNeeded(webView);
            if (stage.equals("organization")) {
                openThread(webView, SOURCE_ID, "组织与附件验证");
                verifyProcessGroup(webView);
                verifyPin(webView);
                verifyQuoteAndAttachments(webView);
            } else {
                assertEquals("organization-persist", stage);
                verifyPersistedDraftAndSend(webView);
            }
            InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10_000);
            captureScreenshot(stage);
        }
    }

    private void connectIfNeeded(WebView webView) throws Exception {
        await(webView, "document.querySelector('#connect-button')?.disabled===false || document.querySelector('#chat-view [data-connection-status]').textContent==='已连接'");
        if (evaluate(webView, "!localStorage.getItem('codex-reach-connection')").equals("true")) {
            evaluate(webView, "document.querySelector('#server-url').value='http://10.0.2.2:4320'; document.querySelector('#server-key').value='fixture-access'; document.querySelector('#connection-form').requestSubmit(); null");
        }
        await(webView, "document.querySelector('#chat-view [data-connection-status]').textContent==='已连接'");
    }

    private void openThread(WebView webView, String id, String title) throws Exception {
        if (evaluate(webView, "!document.querySelector('#chat-view').hidden").equals("true")) {
            evaluate(webView, "document.querySelector('#back-button').click(); null");
        }
        String row = "document.querySelector('[data-thread-id=\"" + id + "\"]')";
        await(webView, "!document.querySelector('#inbox-view').hidden && !document.querySelector('#refresh-button').disabled && Boolean(" + row + ")");
        evaluate(webView, row + ".click(); null");
        await(webView, "!document.querySelector('#chat-view').hidden && document.querySelector('#chat-title').textContent===" + JSONObject.quote(title) + " && document.querySelector('#messages').textContent.includes('QUOTE_SOURCE_LINE') && document.querySelector('#chat-state').dataset.status==='idle' && document.querySelector('#chat-state').hidden");
    }

    private void verifyProcessGroup(WebView webView) throws Exception {
        assertEquals("true", evaluate(webView, "document.querySelectorAll('.turn-process').length===1 && !document.querySelector('.turn-process').open"));
        assertEquals("true", evaluate(webView, "!document.querySelector('[data-message-id=\"organization-answer\"]').closest('.turn-process')"));
        evaluate(webView, "document.querySelector('.turn-process > summary').click(); null");
        assertEquals("true", evaluate(webView, "document.querySelector('.turn-process').open && document.querySelector('.turn-process [data-message-id=\"organization-progress\"]')!==null"));
        assertEquals("true", evaluate(webView, "document.querySelectorAll('.process-records[data-kind=tool]').length===1 && document.querySelectorAll('.process-records[data-kind=reasoning]').length===1 && [...document.querySelectorAll('.process-records')].every(group=>!group.open && group.querySelector('summary').textContent.includes('（2）'))"));
        evaluate(webView, "document.querySelector('.process-records[data-kind=tool] > summary').click(); document.querySelector('.process-records[data-kind=reasoning] > summary').click(); null");
        SystemClock.sleep(700);
        assertEquals("true", evaluate(webView, "[...document.querySelectorAll('.process-records')].every(group=>group.open && group.querySelectorAll('.record-messages > .message').length===2 && !group.querySelector('.message details'))"));
        evaluate(webView, "document.querySelector('.turn-process > summary').click(); null");
    }

    private void verifyPin(WebView webView) throws Exception {
        String pin = "document.querySelector('#chat-pin-button')";
        assertEquals("true", evaluate(webView, pin + ".getAttribute('aria-pressed')==='false'"));
        evaluate(webView, pin + ".click(); " + pin + ".click(); null");
        await(webView, "!" + pin + ".disabled && " + pin + ".getAttribute('aria-pressed')==='true'");
        evaluate(webView, "document.querySelector('#back-button').click(); null");
        String listPin = "document.querySelector('[data-pin-id=\"fixture-organization\"]')";
        await(webView, "!document.querySelector('#refresh-button').disabled && " + listPin + ".getAttribute('aria-pressed')==='true'");
        evaluate(webView, listPin + ".click(); null");
        await(webView, "!" + listPin + ".disabled && " + listPin + ".getAttribute('aria-pressed')==='false'");
        assertEquals("false", evaluate(webView, "document.querySelector('#inbox-view').hidden"));
        JSONArray pins = stats().getJSONArray("pinRequests");
        assertEquals(2, pins.length());
        assertTrue(pins.getJSONObject(0).getBoolean("pinned"));
        assertEquals(false, pins.getJSONObject(1).getBoolean("pinned"));
        openThread(webView, SOURCE_ID, "组织与附件验证");
        assertEquals("true", evaluate(webView, pin + ".getAttribute('aria-pressed')==='false'"));
        assertEquals("true", evaluate(webView, "!document.querySelector('#chat-actions-button') && !document.body.textContent.includes('创建完整历史分支')"));
    }

    private void verifyQuoteAndAttachments(WebView webView) throws Exception {
        setComposer(webView, "原有手机草稿");
        assertEquals("true", evaluate(webView, "document.querySelectorAll('.quote-message').length===0 && document.querySelector('#selection-toolbar').hidden"));
        String source = "[data-message-id=\"organization-answer\"] .message-content";
        evaluate(webView, "document.querySelector(" + JSONObject.quote(source) + ").scrollIntoView({block:'center'}); null");
        pressElement(webView, source, true);
        await(webView, "!document.querySelector('#selection-toolbar').hidden");
        captureScreenshot("selection-popover");
        pressElement(webView, "#selection-toolbar button", false);
        await(webView, "document.querySelector('#annotation-dialog')?.open");
        assertEquals("true", evaluate(webView, "Boolean(document.querySelector('#annotation-dialog [data-excerpt]').textContent.trim()) && !document.querySelector('#annotation-dialog .annotation-source').open"));
        evaluate(webView, "document.querySelector('#annotation-dialog [data-back]').click(); null");
        evaluate(webView, "(()=>{const content=document.querySelector(" + JSONObject.quote(source) + "); const range=document.createRange(); range.setStart(content.firstChild.firstChild,0); range.setEnd(content.firstChild.firstChild,17); const selected=window.getSelection(); selected.removeAllRanges(); selected.addRange(range)})(); null");
        await(webView, "!document.querySelector('#selection-toolbar').hidden");
        evaluate(webView, "document.querySelector('#selection-toolbar button').click(); null");
        await(webView, "document.querySelector('#annotation-dialog')?.open");
        assertEquals("true", evaluate(webView, "document.querySelector('#annotation-dialog [data-excerpt]').textContent==='QUOTE_SOURCE_LINE' && !document.querySelector('#annotation-dialog [data-add]').disabled && document.querySelector('#message-input').value==='原有手机草稿'"));
        evaluate(webView, "document.querySelector('#annotation-dialog [data-comment]').value='只针对这一段核查'; document.querySelector('#annotation-dialog [data-add]').click(); null");
        await(webView, "!document.querySelector('#annotation-dialog') && document.querySelectorAll('#selected-annotations .annotation-card').length===1");
        assertEquals("true", evaluate(webView, "document.querySelector('#selected-annotations').textContent.includes('QUOTE_SOURCE_LINE') && document.querySelector('#selected-annotations').textContent.includes('只针对这一段核查')"));
        assertComposer(webView, QUOTED_DRAFT);
        assertEquals("true", evaluate(webView, "document.querySelectorAll('#selected-annotations .annotation-card').length===1"));
        assertEquals(0, stats().getInt("sendPosts"));

        evaluate(webView, "document.querySelector('[data-message-id=\"organization-user\"] .attachment-image-button').click(); null");
        verifyPreview(webView, "history.png");

        openPicker(webView);
        clickNamedButton(webView, "document.querySelector('.files-dialog .files-navigation')", "盘符");
        await(webView, "Boolean(document.querySelector('.files-entry[aria-label=\"打开文件夹 C:/\"]'))");
        evaluate(webView, "document.querySelector('.files-entry[aria-label=\"打开文件夹 C:/\"]').click(); null");
        await(webView, "Boolean(document.querySelector('.files-entry[aria-label=\"打开文件夹 Example\"]'))");
        evaluate(webView, "document.querySelector('.files-entry[aria-label=\"打开文件夹 Example\"]').click(); null");
        await(webView, "Boolean(document.querySelector('.files-entry[aria-label=\"选择文件 desktop.txt\"]'))");
        evaluate(webView, "document.querySelector('.files-entry[aria-label=\"选择文件 desktop.txt\"]').click(); null");
        awaitSelectedFiles(webView, 1);

        openPicker(webView);
        evaluate(webView, "document.querySelector('.files-entry[aria-label=\"打开文件夹 docs\"]').click(); null");
        await(webView, "document.querySelector('.files-path-form input').value==='C:/Example/docs' && document.querySelector('.files-dialog').getAttribute('aria-busy')==='false'");
        clickNamedButton(webView, "document.querySelector('.files-dialog .files-navigation')", "选用当前文件夹");
        awaitSelectedFiles(webView, 2);

        openPicker(webView);
        evaluate(webView, "document.querySelector('.files-path-form input').value='C:/Example/photo.png'; null");
        clickNamedButton(webView, "document.querySelector('.files-dialog .files-path-actions')", "添加路径");
        awaitSelectedFiles(webView, 3);
        evaluate(webView, "document.querySelector('#selected-files [aria-label=\"预览图片 photo.png\"]').click(); null");
        verifyPreview(webView, "photo.png");

        openPicker(webView);
        // This synthesizes a FileList. The Android system file picker needs separate device acceptance.
        evaluate(webView, "(()=>{const bytes=Uint8Array.from(atob(" + JSONObject.quote(SYNTHETIC_PNG) + "),char=>char.charCodeAt(0)); const selection=new DataTransfer(); selection.items.add(new File([bytes],'mobile.png',{type:'image/png'})); selection.items.add(new File([new Uint8Array(20*1024*1024+1)],'too-large.bin',{type:'application/octet-stream'})); const input=document.querySelector('.files-upload input[type=file]'); input.files=selection.files; input.dispatchEvent(new Event('change',{bubbles:true})); return null})()");
        await(webView, "document.querySelector('.files-dialog')?.getAttribute('aria-busy')==='false' && document.querySelector('.files-dialog [role=alert]').textContent.includes('too-large.bin 超过 20 MiB') && document.querySelectorAll('#selected-files .attachment-chip').length===4");
        JSONArray uploads = stats().getJSONArray("uploadRequests");
        assertEquals(1, uploads.length());
        assertEquals("mobile.png", uploads.getJSONObject(0).getString("name"));
        assertEquals(70, uploads.getJSONObject(0).getInt("size"));
        assertComposer(webView, QUOTED_DRAFT);
        evaluate(webView, "document.querySelector('.files-dialog .dialog-header button').click(); null");
        evaluate(webView, "document.querySelector('#selected-files [aria-label=\"预览图片 mobile.png\"]').click(); null");
        verifyPreview(webView, "mobile.png");
        assertEquals(3, stats().getJSONArray("previewRequests").length());
        assertEquals(3, stats().getJSONArray("resolveRequests").length());
        assertComposer(webView, QUOTED_DRAFT);
        SystemClock.sleep(800);
    }

    private void verifyPersistedDraftAndSend(WebView webView) throws Exception {
        await(webView, "document.querySelector('#chat-title').textContent==='组织与附件验证' && document.querySelectorAll('#selected-files .attachment-chip').length===4 && document.querySelector('#chat-state').dataset.status==='idle' && document.querySelector('#chat-state').hidden");
        assertComposer(webView, QUOTED_DRAFT);
        assertEquals("true", evaluate(webView, "document.querySelectorAll('#selected-annotations .annotation-card').length===1 && document.querySelector('#selected-annotations').textContent.includes('只针对这一段核查')"));
        for (String name : new String[] {"desktop.txt", "docs", "photo.png", "mobile.png"}) {
            assertEquals("true", evaluate(webView, "[...document.querySelectorAll('#selected-files .attachment-name,#selected-files .attachment-image-button')].some(node=>node.textContent===" + JSONObject.quote(name) + ")"));
        }
        evaluate(webView, "document.querySelector('#message-form').requestSubmit(); document.querySelector('#message-form').requestSubmit(); null");
        awaitCount("messageRequests", 1);
        await(webView, "!document.querySelector('#delivery-note').hidden && document.querySelectorAll('#selected-files .attachment-chip').length===4");
        JSONObject sent = stats().getJSONArray("messageRequests").getJSONObject(0);
        String prompt = sent.getString("prompt");
        assertTrue(prompt.endsWith("## My request:\n" + QUOTED_DRAFT));
        JSONObject annotation = new JSONArray(prompt.split("<response-annotations>\n", 2)[1].split("\n</response-annotations>", 2)[0]).getJSONObject(0);
        assertEquals("QUOTE_SOURCE_LINE", annotation.getString("text"));
        assertEquals("只针对这一段核查", annotation.getString("annotation"));
        assertEquals("organization-answer", annotation.getJSONObject("source").getString("messageId"));
        assertEquals(0, annotation.getJSONObject("source").getInt("startOffset"));
        assertEquals(17, annotation.getJSONObject("source").getInt("endOffset"));
        JSONArray attachments = sent.getJSONArray("attachments");
        assertEquals(4, attachments.length());
        assertAttachment(attachments.getJSONObject(0), "C:/Example/desktop.txt", false, false);
        assertAttachment(attachments.getJSONObject(1), "C:/Example/docs", true, false);
        assertAttachment(attachments.getJSONObject(2), "C:/Example/photo.png", false, true);
        assertAttachment(attachments.getJSONObject(3), "C:/Example/uploads/1/mobile.png", false, true);
        setComposer(webView, "附件发送期间的新草稿");
        control("release-organization-message");
        await(webView, "document.querySelector('#delivery-note').hidden && document.querySelector('#selected-files').hidden && document.querySelector('#messages').textContent.includes('ORGANIZATION_ATTACHMENTS_OK')");
        assertComposer(webView, "附件发送期间的新草稿");
        assertEquals("true", evaluate(webView, "document.querySelector('#selected-annotations').hidden && document.querySelectorAll('#messages article.user .annotation-card').length===1 && !document.querySelector('#messages').textContent.includes('<response-annotations>')"));
        assertEquals("true", evaluate(webView, "[...document.querySelectorAll('#messages article.user')].at(-1).querySelectorAll('.attachment-chip').length===4"));
        assertEquals(1, stats().getInt("sendPosts"));
        assertEquals(1, stats().getInt("sendCount"));

        openPicker(webView);
        evaluate(webView, "document.querySelector('.files-entry[aria-label=\"选择文件 desktop.txt\"]').click(); null");
        awaitSelectedFiles(webView, 1);
        setComposer(webView, "");
        assertEquals("false", evaluate(webView, "document.querySelector('#send-button').disabled"));
        evaluate(webView, "document.querySelector('#message-form').requestSubmit(); document.querySelector('#message-form').requestSubmit(); null");
        awaitCount("messageRequests", 2);
        JSONObject attachmentOnly = stats().getJSONArray("messageRequests").getJSONObject(1);
        assertEquals("", attachmentOnly.getString("prompt"));
        assertEquals(1, attachmentOnly.getJSONArray("attachments").length());
        setComposer(webView, "最终保留草稿");
        control("release-organization-message");
        await(webView, "document.querySelector('#delivery-note').hidden && document.querySelector('#selected-files').hidden");
        assertComposer(webView, "最终保留草稿");
        assertEquals(2, stats().getInt("sendPosts"));
        assertEquals(2, stats().getInt("sendCount"));
        assertEquals(1, stats().getJSONArray("uploadRequests").length());
    }

    private void openPicker(WebView webView) throws Exception {
        evaluate(webView, "document.querySelector('#files-button').click(); null");
        await(webView, "document.querySelector('.files-dialog')?.open && document.querySelector('.files-dialog').getAttribute('aria-busy')==='false' && Boolean(document.querySelector('.files-entry[aria-label=\"选择文件 desktop.txt\"]'))");
    }

    private void awaitSelectedFiles(WebView webView, int count) throws Exception {
        await(webView, "!document.querySelector('.files-dialog') && document.querySelectorAll('#selected-files .attachment-chip').length===" + count);
    }

    private void verifyPreview(WebView webView, String name) throws Exception {
        await(webView, "document.querySelector('.attachment-preview')?.open && !document.querySelector('.attachment-preview-image').hidden && document.querySelector('.attachment-preview-image').complete && document.querySelector('.attachment-preview-image').naturalWidth===1");
        assertEquals("true", evaluate(webView, "document.querySelector('.attachment-preview-image').alt===" + JSONObject.quote(name)));
        evaluate(webView, "document.querySelector('.attachment-preview .dialog-header button').click(); null");
        await(webView, "!document.querySelector('.attachment-preview')");
    }

    private void assertAttachment(JSONObject attachment, String path, boolean directory, boolean image) throws Exception {
        assertEquals(path, attachment.getString("path"));
        assertEquals(directory, attachment.getBoolean("directory"));
        assertEquals(image, attachment.getBoolean("image"));
    }

    private void assertComposer(WebView webView, String text) throws Exception {
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value===" + JSONObject.quote(text)));
    }

    private void setComposer(WebView webView, String text) throws Exception {
        evaluate(webView, "document.querySelector('#message-input').value=" + JSONObject.quote(text) + "; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); null");
    }

    private void clickNamedButton(WebView webView, String parent, String label) throws Exception {
        evaluate(webView, "[..." + parent + ".querySelectorAll('button')].find(button=>button.textContent===" + JSONObject.quote(label) + ").click(); null");
    }

    private void pressElement(WebView webView, String selector, boolean longPress) throws Exception {
        String horizontal = longPress ? "Math.min(24,r.width/2)" : "r.width/2";
        String vertical = longPress ? "Math.min(12,r.height/2)" : "r.height/2";
        JSONObject point = new JSONObject(evaluate(webView, "(()=>{const r=document.querySelector(" + JSONObject.quote(selector) + ").getBoundingClientRect();return {x:(r.left+" + horizontal + ")*devicePixelRatio,y:(r.top+" + vertical + ")*devicePixelRatio}})()"));
        int[] origin = new int[2];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> webView.getLocationOnScreen(origin));
        float x = (float) point.getDouble("x") + origin[0];
        float y = (float) point.getDouble("y") + origin[1];
        long downTime = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0);
        InstrumentationRegistry.getInstrumentation().sendPointerSync(down);
        down.recycle();
        SystemClock.sleep(longPress ? ViewConfiguration.getLongPressTimeout() + 300 : 60);
        MotionEvent up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0);
        InstrumentationRegistry.getInstrumentation().sendPointerSync(up);
        up.recycle();
    }

    private void captureScreenshot(String name) throws Exception {
        File screenshot = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), "verification-" + name + ".png");
        try (FileOutputStream output = new FileOutputStream(screenshot)) {
            Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            assertTrue("Screenshot capture failed", bitmap != null);
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
            bitmap.recycle();
        }
    }

    private void control(String name) throws Exception {
        request("/control/" + name, "POST");
    }

    private JSONObject stats() throws Exception {
        return new JSONObject(request("/control/organization-stats", "GET"));
    }

    private String request(String path, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create("http://10.0.2.2:4320" + path).toURL().openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            assertEquals(200, connection.getResponseCode());
            return new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private void awaitCount(String name, int expected) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 20_000;
        while (stats().getJSONArray(name).length() != expected) {
            assertTrue("Timed out waiting for fixture list " + name, SystemClock.elapsedRealtime() < deadline);
            SystemClock.sleep(100);
        }
    }

    private void await(WebView webView, String condition) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 30_000;
        while (!evaluate(webView, "Boolean(" + condition + ")").equals("true")) {
            assertTrue("Timed out waiting for " + condition, SystemClock.elapsedRealtime() < deadline);
            SystemClock.sleep(200);
        }
    }

    private String evaluate(WebView webView, String script) throws InterruptedException {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            webView.evaluateJavascript(script, result -> {
                value.set(result);
                completed.countDown();
            })
        );
        assertTrue("WebView evaluation timed out", completed.await(10, TimeUnit.SECONDS));
        return value.get();
    }
}
