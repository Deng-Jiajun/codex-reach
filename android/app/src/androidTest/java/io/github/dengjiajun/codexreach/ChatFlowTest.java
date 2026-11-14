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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ChatFlowTest {
    @Test
    public void connectsSendsAndRetainsCachedConversation() throws Exception {
        String stage = InstrumentationRegistry.getArguments().getString("stage", "chat");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> view = new AtomicReference<>();
            scenario.onActivity(activity -> view.set(activity.getBridge().getWebView()));
            WebView webView = view.get();

            if (stage.equals("chat")) {
                await(webView, "document.querySelector('#connect-button')?.disabled === false");
                evaluate(webView, "document.querySelector('#server-url').value='http://10.0.2.2:4320'; document.querySelector('#server-key').value='wrong-key'; document.querySelector('#connection-form').requestSubmit(); null");
                await(webView, "document.querySelector('#notice').textContent.includes('访问密钥无效') && !document.querySelector('#connect-button').disabled");
                evaluate(webView, "document.querySelector('#server-key').value='fixture-access'; document.querySelector('#connection-form').requestSubmit(); null");
                await(webView, "!document.querySelector('#inbox-view').hidden && Boolean(document.querySelector('[data-thread-id=\"fixture-chat\"]'))");
                assertEquals("true", evaluate(webView, "document.querySelectorAll('.inbox-heading [data-connection-status],.chat-header [data-connection-status]').length===0 && document.querySelector('#project-filter-label').textContent==='全部对话'"));
                evaluate(webView, "document.querySelector('#project-filter-button').click(); null");
                assertEquals("true", evaluate(webView, "document.querySelectorAll('dialog[open]').length===1 && document.querySelector('.project-choice input:checked').value===''"));
                evaluate(webView, "document.querySelector('.project-choice input[value=\"fixture-project\"]').click(); null");
                await(webView, "!document.querySelector('dialog[open]') && document.querySelector('#project-filter-label').textContent==='验证项目'");
                evaluate(webView, "document.querySelector('#project-filter-button').click(); null");
                assertEquals("true", evaluate(webView, "document.querySelector('.project-choice input:checked').value==='fixture-project'"));
                InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                await(webView, "!document.querySelector('dialog[open]') && document.querySelector('#project-filter-button').getAttribute('aria-expanded')==='false'");
                evaluate(webView, "document.querySelector('#project-filter-button').click(); document.querySelector('.project-choice input[value=\"__none__\"]').click(); null");
                assertEquals("true", evaluate(webView, "document.querySelector('#project-filter-label').textContent==='无项目' && document.querySelectorAll('.thread-row').length===0"));
                evaluate(webView, "document.querySelector('#project-filter-button').click(); document.querySelector('.project-choice input[value=\"\"]').click(); document.querySelector('#list-menu-button').click(); null");
                assertEquals("true", evaluate(webView, "!document.querySelector('.menu-dialog select') && [...document.querySelectorAll('.menu-actions button')].every(button=>button.querySelector('svg')) && document.querySelector('.menu-connection [data-connection-status]').textContent==='已连接' && document.querySelector('.menu-actions').lastElementChild.classList.contains('menu-connection')"));
                evaluate(webView, "document.querySelector('.menu-dialog .dialog-close').click(); null");
                evaluate(webView, "document.querySelector('#list-menu-button').click(); document.querySelector('#refresh-button').click(); null");
                assertEquals("true", evaluate(webView, "document.querySelector('#refresh-indicator').getAttribute('aria-busy')==='true' && getComputedStyle(document.querySelector('#refresh-indicator svg')).animationName==='refresh-spin'"));
                await(webView, "document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true' && document.querySelector('#refresh-status').textContent.startsWith('已刷新')");
                evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-chat\"]').click(); null");
                await(webView, "document.querySelector('#messages').textContent.includes('连接已准备就绪')");
                assertEquals("true", evaluate(webView, "document.querySelector('#chat-title').textContent==='连接与缓存验证' && document.querySelector('.app-header').hidden"));
                evaluate(webView, "document.querySelector('#message-input').value='请验证消息收发'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#message-form').requestSubmit(); null");
                await(webView, "document.querySelector('#messages').textContent.includes('REACH_CHAT_OK') && document.querySelector('#delivery-note').hidden");
                assertEquals("true", evaluate(webView, "!window.fixtureScriptExecuted && Boolean(document.querySelector('#messages table')) && Boolean(document.querySelector('#messages pre'))"));
                evaluate(webView, "document.querySelector('#message-input').value='保留的手机草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); null");
                evaluate(webView, "document.querySelector('#messages-scroll').scrollTop=10; window.savedScrollTop=document.querySelector('#messages-scroll').scrollTop; document.querySelector('#chat-menu-button').click(); document.querySelector('.menu-connection').click(); null");
                await(webView, "!document.querySelector('#connection-view').hidden && !document.querySelector('#cancel-settings').hidden");
                assertEquals("true", evaluate(webView, "Boolean(document.querySelector('.app-header #cancel-settings svg')) && document.querySelector('#cancel-settings').getBoundingClientRect().left<60"));
                evaluate(webView, "document.querySelector('#server-key').value='wrong-key'; document.querySelector('#connection-form').requestSubmit(); null");
                await(webView, "document.querySelector('#notice').textContent.includes('访问密钥无效') && !document.querySelector('#connect-button').disabled");
                evaluate(webView, "document.querySelector('#cancel-settings').click(); null");
                await(webView, "!document.querySelector('#chat-view').hidden");
                assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的手机草稿'"));
                assertEquals("Reading position " + evaluate(webView, "JSON.stringify({saved:window.savedScrollTop,actual:document.querySelector('#messages-scroll').scrollTop})"),
                    "true", evaluate(webView, "Math.abs(document.querySelector('#messages-scroll').scrollTop-window.savedScrollTop)<2"));
                evaluate(webView, "document.querySelector('#chat-menu-button').click(); document.querySelector('.menu-connection').click(); document.querySelector('#connection-form').requestSubmit(); null");
                await(webView, "!document.querySelector('#chat-view').hidden");
                assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的手机草稿'"));

                control("offline");
                await(webView, "!document.querySelector('#reconnect-notice').hidden && document.querySelector('.app-header [data-connection-status]').textContent==='重连中'");
                evaluate(webView, "document.querySelector('#chat-menu-button').click(); document.querySelector('.menu-connection').click(); null");
                InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                await(webView, "!document.querySelector('#chat-view').hidden");
                assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的手机草稿'"));
                evaluate(webView, "document.querySelector('#reconnect-button').click(); null");
                control("online");
                await(webView, "document.querySelector('#reconnect-notice').hidden && document.querySelector('#messages').textContent.includes('REACH_RECONNECTED')");

                evaluate(webView, "document.querySelector('#back-button').click(); null");
                await(webView, "!document.querySelector('#inbox-view').hidden && document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true'");
                control("offline");
                evaluate(webView, "document.querySelector('#list-menu-button').click(); document.querySelector('#refresh-button').click(); null");
                await(webView, "!document.querySelector('#reconnect-notice').hidden && document.querySelector('#refresh-status').textContent==='刷新失败'");
                control("online");
                await(webView, "document.querySelector('#reconnect-notice').hidden && document.querySelector('#refresh-status').textContent.startsWith('已刷新')");
                evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-chat\"]').click(); null");
                await(webView, "document.querySelector('#chat-state').dataset.status==='idle' && document.querySelector('#chat-state').hidden && document.querySelector('#messages').textContent.includes('REACH_CHAT_OK')");
                evaluate(webView, "document.querySelector('#back-button').click(); null");
                await(webView, "!document.querySelector('#inbox-view').hidden && document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true'");
                evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-error\"]').click(); null");
                await(webView, "!document.querySelector('#chat-error').hidden");
                assertEquals("true", evaluate(webView, "document.querySelector('#reconnect-notice').hidden && document.querySelector('.app-header [data-connection-status]').textContent==='已连接'"));
                control("history-ok");
                evaluate(webView, "document.querySelector('#retry-history').click(); null");
                await(webView, "document.querySelector('#chat-error').hidden && document.querySelector('#messages').textContent.includes('READ_ERROR_RECOVERED')");
                evaluate(webView, "document.querySelector('#back-button').click(); null");
                await(webView, "!document.querySelector('#inbox-view').hidden && document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true'");
                evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-chat\"]').click(); null");
                await(webView, "document.querySelector('#messages').textContent.includes('REACH_CHAT_OK')");
                SystemClock.sleep(1200);
                assertEquals("true", evaluate(webView, "!document.querySelector('#notice').textContent.includes('缓存') && document.querySelector('#message-input').value==='保留的手机草稿'"));
            } else {
                assertEquals("chat-persist", stage);
                await(webView, "document.querySelector('#messages').textContent.includes('REACH_CHAT_OK') && document.querySelector('.app-header [data-connection-status]').textContent==='重连中'");
                assertEquals("true", evaluate(webView, "document.querySelector('#chat-title').textContent==='连接与缓存验证'"));
                assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的手机草稿'"));
            }

            assertEquals("true", evaluate(webView, "document.scrollingElement.scrollTop===0 && document.querySelector('#messages-scroll').getBoundingClientRect().top >= document.querySelector('.chat-header').getBoundingClientRect().bottom-1"));
            InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10_000);
            File screenshot = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), "verification-" + stage + ".png");
            try (FileOutputStream output = new FileOutputStream(screenshot)) {
                Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
                assertTrue("Screenshot capture failed", bitmap != null);
                assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
                bitmap.recycle();
            }
        }
    }

    private void control(String mode) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create("http://10.0.2.2:4320/control/" + mode).toURL().openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            assertEquals(200, connection.getResponseCode());
        } finally {
            connection.disconnect();
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
