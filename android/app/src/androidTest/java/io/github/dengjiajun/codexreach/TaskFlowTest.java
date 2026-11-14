package io.github.dengjiajun.codexreach;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.KeyEvent;
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
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class TaskFlowTest {
    @Test
    public void loadsHistoryCreatesConfiguresAndStopsTasks() throws Exception {
        control("tasks-reset");
        control("mobile-reset");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> view = new AtomicReference<>();
            scenario.onActivity(activity -> view.set(activity.getBridge().getWebView()));
            WebView webView = view.get();
            await(webView, "!document.querySelector('#chat-view').hidden && document.querySelector('.app-header [data-connection-status]').textContent==='已连接'");
            evaluate(webView, "document.querySelector('#back-button').click(); null");
            await(webView, "!document.querySelector('#inbox-view').hidden && document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true' && Boolean(document.querySelector('[data-thread-id=\"fixture-loading\"]'))");

            evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-loading\"]').click(); null");
            await(webView, "!document.querySelector('#history-status').hidden && document.querySelector('#history-status').textContent.includes('读取')");
            awaitCounter("initialReads", 1);
            assertEquals("true", evaluate(webView, "!document.querySelector('#messages').textContent.includes('LOADING_LATEST')"));
            control("release-initial");
            await(webView, "document.querySelector('#messages').textContent.includes('LOADING_LATEST') && !document.querySelector('#older-button').hidden && document.querySelector('#older-button').disabled===false");
            await(webView, "document.querySelector('#history-status').hidden");
            assertEquals("true", evaluate(webView, "document.querySelector('#chat-state').textContent!=='未加载'"));

            evaluate(webView, "document.querySelector('#older-button').click(); null");
            awaitCounter("olderReads", 1);
            control("loading-pulse");
            await(webView, "document.querySelector('#messages').textContent.includes('LOADING_LIVE_2')");
            assertEquals("true", evaluate(webView, "document.querySelector('#older-button').disabled && document.querySelector('#older-button').getAttribute('aria-busy')==='true'"));
            evaluate(webView, "document.querySelector('#older-button').click(); document.querySelector('#older-button').click(); null");
            assertEquals(1, stats().getInt("olderReads"));
            control("release-older");
            await(webView, "document.querySelector('#messages').textContent.includes('LOADING_OLDER') && document.querySelector('#older-button').getAttribute('aria-busy')!=='true'");
            assertEquals("true", evaluate(webView, "new Set([...document.querySelectorAll('#messages article')].map(item=>item.dataset.messageId)).size===document.querySelectorAll('#messages article').length"));

            evaluate(webView, "document.querySelector('#back-button').click(); null");
            await(webView, "!document.querySelector('#inbox-view').hidden && document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true'");
            evaluate(webView, "document.querySelector('#new-chat-button').click(); null");
            await(webView, "document.querySelector('#new-chat-dialog').getBoundingClientRect().height>0 && Boolean(document.querySelector('#new-chat-model option[value=\"fixture-standard\"]'))");
            evaluate(webView, "document.querySelector('#new-chat-prompt').value='NESTED_DRAFT'; document.querySelector('#new-chat-prompt').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#new-files-button').click(); null");
            await(webView, "document.querySelector('#new-chat-dialog').open && document.querySelector('#add-content-dialog').open");
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            await(webView, "!document.querySelector('#add-content-dialog').open && document.querySelector('#new-chat-dialog').open");
            assertEquals("\"NESTED_DRAFT\"", evaluate(webView, "document.querySelector('#new-chat-prompt').value"));
            evaluate(webView, "document.querySelector('#new-chat-project').value='fixture-project'; document.querySelector('#new-chat-project').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#new-chat-model').value='fixture-deep'; document.querySelector('#new-chat-model').dispatchEvent(new Event('change',{bubbles:true})); null");
            await(webView, "Boolean(document.querySelector('#new-chat-thinking option[value=\"xhigh\"]')) && !document.querySelector('#new-chat-thinking option[value=\"high\"]')");
            evaluate(webView, "document.querySelector('#new-chat-thinking').value='xhigh'; document.querySelector('#new-chat-thinking').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#new-chat-prompt').value='TASK_CREATE_CHECK'; document.querySelector('#new-chat-prompt').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#create-chat-button').click(); document.querySelector('#create-chat-button').click(); null");
            await(webView, "!document.querySelector('#chat-view').hidden && document.querySelector('#messages').textContent.includes('TASK_CREATED')");
            await(webView, "document.querySelector('#send-button').dataset.action==='stop' && !document.querySelector('#send-button').disabled");
            evaluate(webView, "document.querySelector('#message-input').value='待发送草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); null");
            assertEquals("true", evaluate(webView, "document.querySelector('#send-button').dataset.action==='send' && !document.querySelector('#send-mode-button').hidden && !document.querySelector('#stop-button')"));
            verifyQueueAttachments(webView);
            evaluate(webView, "document.querySelector('#message-input').value=''; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); null");
            assertEquals("true", evaluate(webView, "document.querySelector('#send-button').dataset.action==='stop' && document.querySelector('#send-mode-button').hidden && getComputedStyle(document.querySelector('#chat-state'),'::before').animationName==='refresh-spin'"));
            JSONObject creation = stats().getJSONObject("created");
            assertEquals(1, stats().getInt("createCount"));
            assertEquals("fixture-project", creation.getString("projectId"));
            assertEquals("fixture-deep", creation.getString("model"));
            assertEquals("xhigh", creation.getString("thinking"));
            assertEquals("TASK_CREATE_CHECK", creation.getString("prompt"));

            control("advance-task");
            evaluate(webView, "document.querySelector('#send-button').click(); null");
            awaitCounter("stopMismatches", 1);
            await(webView, "document.querySelector('#messages').textContent.includes('TASK_NEXT_TURN') && !document.querySelector('#send-button').disabled");
            assertEquals("true", evaluate(webView, "document.querySelector('#chat-state').textContent==='进行中' && !document.querySelector('#stop-status').textContent.includes('已停止')"));
            evaluate(webView, "document.querySelector('#send-button').click(); null");
            await(webView, "document.querySelector('#messages').textContent.includes('TASK_STOPPED') && document.querySelector('#send-button').dataset.action==='send' && document.querySelector('#send-button').disabled");
            JSONObject stopStats = stats();
            assertEquals(2, stopStats.getJSONArray("stopRequests").length());
            assertEquals("task-turn-1", stopStats.getJSONArray("stopRequests").getJSONObject(0).getString("expectedTurnId"));
            assertEquals("task-turn-2", stopStats.getJSONArray("stopRequests").getJSONObject(1).getString("expectedTurnId"));

            evaluate(webView, "document.querySelector('#parameters-button').click(); null");
            await(webView, "document.querySelector('#options-dialog').getBoundingClientRect().height>0 && !document.querySelector('#save-options').disabled && Boolean(document.querySelector('#options-model option[value=\"fixture-standard\"]'))");
            evaluate(webView, "document.querySelector('#options-model').value='fixture-standard'; document.querySelector('#options-model').dispatchEvent(new Event('change',{bubbles:true})); null");
            await(webView, "Boolean(document.querySelector('#options-thinking option[value=\"high\"]')) && !document.querySelector('#options-thinking option[value=\"xhigh\"]')");
            evaluate(webView, "document.querySelector('#options-thinking').value='high'; document.querySelector('#options-thinking').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#options-form').requestSubmit(); null");
            await(webView, "document.querySelector('#options-dialog').getBoundingClientRect().height===0");
            evaluate(webView, "document.querySelector('#message-input').value='TASK_PARAMETER_CHECK'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#message-form').requestSubmit(); null");
            await(webView, "document.querySelector('#messages').textContent.includes('TASK_PARAMETER_OK') && document.querySelector('#delivery-note').hidden");
            JSONObject finalStats = stats();
            assertEquals(1, finalStats.getInt("sends"));
            assertEquals(1, finalStats.getJSONArray("parameterRequests").length());
            JSONObject parameters = finalStats.getJSONArray("parameterRequests").getJSONObject(0);
            assertEquals("fixture-standard", parameters.getString("model"));
            assertEquals("high", parameters.getString("thinking"));
            assertEquals("TASK_PARAMETER_CHECK", parameters.getString("prompt"));

            InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10_000);
            File screenshot = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), "verification-task-flow.png");
            try (FileOutputStream output = new FileOutputStream(screenshot)) {
                Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
                assertTrue("Screenshot capture failed", bitmap != null);
                assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
                bitmap.recycle();
            }
        }
    }

    private void verifyQueueAttachments(WebView webView) throws Exception {
        evaluate(webView, "window.fixtureImmediateIcon=document.querySelector('#send-button').innerHTML; document.querySelector('#send-mode-button').click(); [...document.querySelectorAll('.send-mode-dialog .menu-actions button')].find(button=>button.textContent.startsWith('排队到下一轮')).click(); null");
        assertEquals("true", evaluate(webView, "document.querySelector('#send-button').getAttribute('aria-label')==='排队到下一轮' && document.querySelector('#send-button').innerHTML!==window.fixtureImmediateIcon"));
        evaluate(webView, "localStorage.setItem('codex-reach-attachments:android-fixture:fixture-task',JSON.stringify(['A','B','C'].map(name=>({name:name+'.txt',path:'C:/Example/'+name+'.txt',directory:false,image:false})))); window.dispatchEvent(new Event('reach-uploads')); document.querySelector('#send-button').click(); null");
        await(webView, "document.querySelector('#delivery-note').hidden && !document.querySelector('#queue-button').hidden");
        evaluate(webView, "document.querySelector('#queue-button').click(); null");
        await(webView, "Boolean(document.querySelector('.queue-item'))");
        evaluate(webView, "[...document.querySelectorAll('.queue-actions button')].find(button=>button.textContent==='查看／编辑').click(); document.querySelector('.queue-manage').click(); null");
        await(webView, "document.querySelector('.attachment-manager')?.open");
        evaluate(webView, "document.querySelector('.attachment-manager [aria-label=\"移除附件 A.txt\"]').click(); document.querySelector('.attachment-manager [aria-label=\"移除附件 B.txt\"]').click(); null");
        assertEquals("true", evaluate(webView, "document.querySelectorAll('.attachment-manager .attachment-label').length===1 && document.querySelector('.attachment-manager .attachment-label').textContent==='C.txt' && !document.querySelector('.attachment-manager [aria-label=\"移除附件 B.txt\"]')"));
        evaluate(webView, "document.querySelector('.attachment-manager .dialog-close').click(); document.querySelector('.queue-save').click(); null");
        await(webView, "!document.querySelector('.queue-save')");
        JSONObject item = new JSONObject(request("/control/mobile-stats", "GET")).getJSONObject("queues").getJSONArray("fixture-task").getJSONObject(0);
        assertEquals(1, item.getJSONObject("options").getJSONArray("attachments").length());
        assertEquals("C:/Example/C.txt", item.getJSONObject("options").getJSONArray("attachments").getJSONObject(0).getString("path"));
        evaluate(webView, "[...document.querySelectorAll('.queue-actions button')].find(button=>button.textContent==='取消').click(); null");
        await(webView, "!document.querySelector('.queue-item')");
        evaluate(webView, "document.querySelector('dialog[open] .dialog-close').click(); document.querySelector('#message-input').value='待发送草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#send-mode-button').click(); [...document.querySelectorAll('.send-mode-dialog .menu-actions button')].find(button=>button.textContent.startsWith('立即追加')).click(); null");
        assertEquals("true", evaluate(webView, "document.querySelector('#send-button').innerHTML===window.fixtureImmediateIcon"));
    }

    private void control(String name) throws Exception {
        request("/control/" + name, "POST");
    }

    private JSONObject stats() throws Exception {
        return new JSONObject(request("/control/stats", "GET"));
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

    private void awaitCounter(String name, int expected) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 20_000;
        while (stats().getInt(name) != expected) {
            assertTrue("Timed out waiting for fixture counter " + name, SystemClock.elapsedRealtime() < deadline);
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
