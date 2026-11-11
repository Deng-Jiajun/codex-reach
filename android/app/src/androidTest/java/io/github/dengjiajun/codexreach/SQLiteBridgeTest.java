package io.github.dengjiajun.codexreach;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.graphics.Bitmap;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SQLiteBridgeTest {
    @Test
    public void verifiesNativeSQLiteFromWebView() throws Exception {
        String stage = InstrumentationRegistry.getArguments().getString("stage", "write");
        assertTrue("Unsupported verification stage", stage.equals("write") || stage.equals("persist"));

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> webView = new AtomicReference<>();
            scenario.onActivity(activity -> {
                webView.set(activity.getBridge().getWebView());
            });

            long mainDeadline = SystemClock.elapsedRealtime() + 30_000;
            while (!evaluate(webView.get(), "document.querySelector('#connect-button')?.disabled === false").equals("true")) {
                assertTrue("Main page did not become ready", SystemClock.elapsedRealtime() < mainDeadline);
                SystemClock.sleep(200);
            }
            evaluate(webView.get(), "location.href='/verification.html'; null");

            long readyDeadline = SystemClock.elapsedRealtime() + 30_000;
            while (!evaluate(webView.get(), "Boolean(window.codexReachVerification)").equals("true")) {
                assertTrue("Verification page did not become ready", SystemClock.elapsedRealtime() < readyDeadline);
                SystemClock.sleep(200);
            }

            evaluate(webView.get(), "window.codexReachVerification.run('" + stage + "'); null");
            long resultDeadline = SystemClock.elapsedRealtime() + 90_000;
            while (SystemClock.elapsedRealtime() < resultDeadline) {
                String encoded = evaluate(webView.get(), "JSON.stringify(window.codexReachVerification.result)");
                Object decoded = new JSONTokener(encoded).nextValue();
                if (decoded instanceof String && !decoded.equals("null")) {
                    JSONObject result = new JSONObject((String) decoded);
                    Log.i("CodexReachVerification", result.toString());
                    assertEquals(stage, result.getString("stage"));
                    assertTrue(result.toString(), result.getBoolean("ok"));
                    assertEquals(stage.equals("write") ? 7 : 2, result.getJSONArray("checks").length());
                    assertTrue("Missing persisted token", !result.getString("token").isEmpty());
                    InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10_000);
                    File screenshot = new File(
                        InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null),
                        "verification-" + stage + ".png"
                    );
                    try (FileOutputStream output = new FileOutputStream(screenshot)) {
                        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
                        assertTrue("Screenshot capture failed", bitmap != null);
                        assertTrue("Screenshot save failed", bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
                        bitmap.recycle();
                    }
                    return;
                }
                SystemClock.sleep(200);
            }
            fail("SQLite bridge verification timed out");
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
        assertTrue("WebView JavaScript evaluation timed out", completed.await(10, TimeUnit.SECONDS));
        return value.get();
    }
}
