package io.github.dengjiajun.codexreach;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
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
                evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-chat\"]').click(); null");
                await(webView, "document.querySelector('#messages').textContent.includes('连接已准备就绪')");
                evaluate(webView, "document.querySelector('#message-input').value='请验证消息收发'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#message-form').requestSubmit(); null");
                await(webView, "document.querySelector('#messages').textContent.includes('REACH_CHAT_OK') && document.querySelector('#delivery-note').hidden");
                assertEquals("true", evaluate(webView, "!window.fixtureScriptExecuted && Boolean(document.querySelector('#messages table')) && Boolean(document.querySelector('#messages pre'))"));
                evaluate(webView, "document.querySelector('#message-input').value='保留的手机草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); null");
                SystemClock.sleep(1200);
            } else {
                assertEquals("chat-persist", stage);
                await(webView, "document.querySelector('#messages').textContent.includes('REACH_CHAT_OK') && document.querySelector('#chat-state').textContent==='离线'");
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
