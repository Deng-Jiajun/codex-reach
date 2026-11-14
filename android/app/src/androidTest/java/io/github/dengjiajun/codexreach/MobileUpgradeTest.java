package io.github.dengjiajun.codexreach;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertArrayEquals;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.view.View;
import android.view.ViewGroup;
import android.view.MotionEvent;
import android.webkit.WebView;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class MobileUpgradeTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test public void verifiesReaderAndNotificationLifecycle() throws Exception {
        String stage = InstrumentationRegistry.getArguments().getString("stage", "reader");
        request("/control/online", null);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> view = new AtomicReference<>();
            scenario.onActivity(activity -> view.set(activity.getBridge().getWebView()));
            WebView web = view.get();
            await(web, "document.querySelector('#connect-button')?.disabled===false || document.querySelector('.app-header [data-connection-status]').textContent==='已连接'");
            if (evaluate(web, "!localStorage.getItem('codex-reach-connection')").equals("true")) {
                evaluate(web, "document.querySelector('#server-url').value='http://10.0.2.2:4320';document.querySelector('#server-key').value='fixture-access';document.querySelector('#connection-form').requestSubmit();null");
            }
            await(web, "document.querySelector('[data-connection-status]').textContent==='已连接'");
            if (stage.equals("reader")) verifyReaders(web);
            else if (stage.equals("notifications")) verifyNotifications(web, scenario);
            else if (stage.equals("notifications-persist")) {
                awaitNotification("mobile-after-stop");
                assertEquals(1, notificationCount("mobile-after-stop"));
                evaluate(web, "localStorage.setItem('codex-reach-notifications:android-fixture',JSON.stringify({enabled:false}));null");
                NotificationsPlugin.preferences(context).edit().putBoolean("enabled", false).commit();
                context.stopService(new Intent(context, NotificationService.class));
            } else throw new AssertionError("Unknown stage " + stage);
            if (stage.equals("notifications")) {
                assertTrue(InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS));
            }
            screenshot(stage);
            if (stage.equals("notifications")) {
                InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            }
        }
    }

    private void openOrganization(WebView web) throws Exception {
        if (evaluate(web, "!document.querySelector('#chat-view').hidden").equals("true")) evaluate(web, "document.querySelector('#back-button').click();null");
        await(web, "!document.querySelector('#inbox-view').hidden && document.querySelector('#refresh-indicator').getAttribute('aria-busy')!=='true' && Boolean(document.querySelector('[data-thread-id=fixture-organization]'))");
        evaluate(web, "document.querySelector('[data-thread-id=fixture-organization]').click();null");
        await(web, "document.querySelector('#messages').textContent.includes('HTML 阅读')");
    }

    private void verifyReaders(WebView web) throws Exception {
        openOrganization(web);
        evaluate(web, "document.querySelector('#message-input').value='READER_DRAFT_RETAINED';document.querySelector('#message-input').dispatchEvent(new Event('input'));[...document.querySelectorAll('.message-content a')].find(link=>link.textContent==='HTML 阅读').click();null");
        ReaderActivity reader = awaitReader("html");
        WebView document = readerWeb(reader);
        await(document, "document.querySelector('h1')?.textContent==='READER_HTML' && document.querySelector('img').naturalWidth===1");
        assertEquals("false", evaluate(document, "window.bridgePresent"));
        assertEquals("\"rgb(231, 240, 227)\"", evaluate(document, "getComputedStyle(document.body).backgroundColor"));
        evaluate(document, "document.querySelector('button').click();null");
        await(document, "document.querySelector('#result').textContent==='READER_SCRIPT_OK'");
        assertTrue(windowRatio(reader) > .40 && windowRatio(reader) < .70);
        clickText(reader, "展开阅读面板");
        awaitCondition(() -> windowRatio(reader) > .85, "reader expanded");
        screenshot("reader-html");
        tapElement(document, "#next-page");
        await(document, "location.href.endsWith('/next.html') && document.readyState==='complete'");
        AtomicReference<Boolean> hasBackHistory = new AtomicReference<>(false);
        awaitCondition(() -> {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> hasBackHistory.set(document.canGoBack()));
            return hasBackHistory.get();
        }, "WebView back history created by page link");
        shell("input keyevent KEYCODE_BACK");
        await(document, "location.href.endsWith('/mobile.html')");
        shell("input keyevent KEYCODE_BACK");
        await(web, "document.querySelector('#message-input').value==='READER_DRAFT_RETAINED'");
        evaluate(web, "[...document.querySelectorAll('.message-content a')].find(link=>link.textContent==='PDF 阅读').click();null");
        ReaderActivity pdf = awaitReader("pdf");
        awaitCondition(() -> hasText(pdf, "1 / 1"), "PDF first page");
        int readsBeforeReload = pdfReads();
        clickText(pdf, "阅读操作");
        awaitCondition(() -> {
            android.view.accessibility.AccessibilityNodeInfo menu = InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
            if (menu == null) return false;
            for (android.view.accessibility.AccessibilityNodeInfo item : menu.findAccessibilityNodeInfosByText("重新读取")) {
                while (item != null && !item.isClickable()) item = item.getParent();
                if (item != null && item.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) return true;
            }
            return false;
        }, "PDF reload menu action");
        awaitCondition(() -> pdfReads() > readsBeforeReload, "PDF downloaded again");
        awaitCondition(() -> hasText(pdf, "1 / 1"), "PDF page after reload");
        screenshot("reader-pdf");
        clickText(pdf, "关闭");
        ByteArrayOutputStream saved = new ByteArrayOutputStream();
        ReaderPlugin.download("http://10.0.2.2:4320/reader/fixture/image.png", saved);
        assertArrayEquals(android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS9nyHwAEEAI26XT+MQAAAABJRU5ErkJggg==", android.util.Base64.DEFAULT), saved.toByteArray());
    }

    private void verifyNotifications(WebView web, ActivityScenario<MainActivity> scenario) throws Exception {
        request("/control/mobile-reset", new JSONObject());
        context.getSystemService(NotificationManager.class).cancelAll();
        shell("pm grant " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        evaluate(web, "document.querySelector(document.querySelector('#chat-view').hidden?'#list-menu-button':'#chat-menu-button').click(); document.querySelector('dialog[open] .menu-connection').click();document.querySelector('#notification-settings').click();null");
        await(web, "Boolean(document.querySelector('.notification-options'))");
        evaluate(web, "document.querySelector('.notification-options input[name=enabled]').checked=true;document.querySelector('.notification-options').requestSubmit();null");
        awaitCondition(() -> NotificationsPlugin.preferences(context).contains("cursor:android-fixture") && NotificationService.running, "notification connection established");
        event("mobile-foreground", "completed");
        awaitNotification("mobile-foreground");
        event("mobile-foreground", "completed");
        SystemClock.sleep(900);
        assertEquals(1, notificationCount("mobile-foreground"));
        notification("mobile-foreground").getNotification().contentIntent.send();
        await(web, "document.querySelector('#chat-title').textContent==='组织与附件验证'");
        scenario.moveToState(Lifecycle.State.CREATED);
        event("mobile-background", "approval");
        awaitNotification("mobile-background");
        shell("input keyevent KEYCODE_SLEEP");
        try { event("mobile-lockscreen", "question"); awaitNotification("mobile-lockscreen"); }
        finally { shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard"); }
        request("/control/offline", null);
        event("mobile-offline", "failed");
        SystemClock.sleep(1200);
        request("/control/online", null);
        awaitNotification("mobile-offline");
        scenario.moveToState(Lifecycle.State.RESUMED);
        assertTrue(NotificationService.running);
    }

    private void event(String id, String kind) throws Exception { request("/control/mobile-event", new JSONObject().put("id", id).put("kind", kind)); }

    private int pdfReads() {
        try {
            HttpURLConnection connection = (HttpURLConnection) URI.create("http://10.0.2.2:4320/control/mobile-stats").toURL().openConnection();
            connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
            try { return new JSONObject(new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8)).getInt("pdfReads"); }
            finally { connection.disconnect(); }
        } catch (Exception error) { throw new AssertionError("Cannot read PDF download count", error); }
    }

    private int notificationCount(String tag) {
        int count = 0;
        for (StatusBarNotification notification : context.getSystemService(NotificationManager.class).getActiveNotifications()) if (tag.equals(notification.getTag())) count++;
        return count;
    }

    private StatusBarNotification notification(String tag) {
        for (StatusBarNotification notification : context.getSystemService(NotificationManager.class).getActiveNotifications()) if (tag.equals(notification.getTag())) return notification;
        throw new AssertionError("Notification missing " + tag);
    }

    private void awaitNotification(String tag) throws Exception { awaitCondition(() -> notificationCount(tag) == 1, "notification " + tag); }

    private ReaderActivity awaitReader(String kind) throws Exception {
        AtomicReference<ReaderActivity> reader = new AtomicReference<>();
        awaitCondition(() -> {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                for (Activity activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) if (activity instanceof ReaderActivity && kind.equals(activity.getIntent().getStringExtra("kind"))) reader.set((ReaderActivity) activity);
            });
            return reader.get() != null;
        }, "ReaderActivity resumed");
        return reader.get();
    }

    private WebView readerWeb(Activity activity) {
        AtomicReference<WebView> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> result.set(findWeb(activity.getWindow().getDecorView())));
        assertTrue(result.get() != null); return result.get();
    }

    private WebView findWeb(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) { WebView found = findWeb(((ViewGroup) view).getChildAt(i)); if (found != null) return found; }
        return null;
    }

    private View text(View view, String text) {
        if (text.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(text)) return view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) { View found = text(((ViewGroup) view).getChildAt(i), text); if (found != null) return found; }
        return null;
    }

    private boolean hasText(Activity activity, String label) {
        AtomicReference<Boolean> found = new AtomicReference<>(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> found.set(text(activity.getWindow().getDecorView(), label) != null)); return found.get();
    }

    private void clickText(Activity activity, String label) { InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { View target = text(activity.getWindow().getDecorView(), label); assertTrue(target != null); target.performClick(); }); }

    private void tapElement(WebView web, String selector) throws Exception {
        JSONObject point = new JSONObject(evaluate(web, "(()=>{const rect=document.querySelector(" + JSONObject.quote(selector)
            + ").getBoundingClientRect();return {x:(rect.left+rect.width/2)*devicePixelRatio,y:(rect.top+rect.height/2)*devicePixelRatio}})()"));
        int[] origin = new int[2];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.getLocationOnScreen(origin));
        float x = origin[0] + (float) point.getDouble("x");
        float y = origin[1] + (float) point.getDouble("y");
        long started = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(started, started, MotionEvent.ACTION_DOWN, x, y, 0);
        InstrumentationRegistry.getInstrumentation().sendPointerSync(down);
        down.recycle();
        SystemClock.sleep(60);
        MotionEvent up = MotionEvent.obtain(started, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0);
        InstrumentationRegistry.getInstrumentation().sendPointerSync(up);
        up.recycle();
    }

    private double windowRatio(Activity activity) {
        AtomicReference<Double> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> result.set(activity.getWindow().getDecorView().getHeight() / (double) activity.getWindowManager().getMaximumWindowMetrics().getBounds().height())); return result.get();
    }

    private void screenshot(String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        if (name.equals("notifications")) {
            // Ongoing notification updates can prevent global accessibility idleness.
            awaitCondition(() -> {
                android.view.accessibility.AccessibilityNodeInfo root =
                    InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
                return root != null && "com.android.systemui".contentEquals(root.getPackageName());
            }, "notification panel visible");
        } else {
            InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10000);
        }
        File file = new File(context.getExternalFilesDir(null), "verification-" + name + ".png");
        try (FileOutputStream output = new FileOutputStream(file)) { Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot(); assertTrue(bitmap != null); bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); bitmap.recycle(); }
    }

    private void shell(String command) throws Exception {
        try (ParcelFileDescriptor output = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command);
             java.io.InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(output)) { input.readAllBytes(); }
    }

    private void request(String path, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create("http://10.0.2.2:4320" + path).toURL().openConnection();
        try {
            connection.setRequestMethod("POST"); connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
            if (body != null) { connection.setDoOutput(true); connection.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            assertEquals(200, connection.getResponseCode()); connection.getInputStream().readAllBytes();
        } finally { connection.disconnect(); }
    }

    private void awaitCondition(BooleanSupplier condition, String description) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 30000;
        while (!condition.getAsBoolean()) { assertTrue("Timed out waiting for " + description, SystemClock.elapsedRealtime() < deadline); SystemClock.sleep(150); }
    }

    private void await(WebView web, String condition) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 30000;
        while (!evaluate(web, "Boolean(" + condition + ")").equals("true")) { assertTrue("Timed out waiting for " + condition, SystemClock.elapsedRealtime() < deadline); SystemClock.sleep(150); }
    }

    private String evaluate(WebView web, String script) throws InterruptedException {
        CountDownLatch complete = new CountDownLatch(1); AtomicReference<String> value = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, result -> { value.set(result); complete.countDown(); }));
        assertTrue(complete.await(10, TimeUnit.SECONDS)); return value.get();
    }
}
