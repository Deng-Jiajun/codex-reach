package io.github.dengjiajun.codexreach;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class NotificationService extends Service {
    static volatile boolean running;
    private volatile boolean stopped;
    private volatile HttpURLConnection connection;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private boolean started;
    private static final int SERVICE_NOTIFICATION = 17;
    private static final String SERVICE_CHANNEL = "reach-connection";

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!NotificationsPlugin.preferences(this).getBoolean("enabled", false)) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(SERVICE_CHANNEL, "电脑提醒连接", NotificationManager.IMPORTANCE_LOW));
        String[][] kinds = {{"completed", "任务完成"}, {"failed", "任务失败"}, {"approval", "等待审批"}, {"question", "等待回答"}};
        for (String[] kind : kinds) manager.createNotificationChannel(new NotificationChannel("reach-" + kind[0], kind[1],
            kind[0].equals("approval") || kind[0].equals("question") ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT));
        Notification notification = connectionNotification("正在接收电脑上的任务提醒");
        if (Build.VERSION.SDK_INT >= 34) startForeground(SERVICE_NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(SERVICE_NOTIFICATION, notification);
        if (!started) { started = true; stopped = false; running = true; worker.execute(this::receive); }
        return START_STICKY;
    }

    private Notification connectionNotification(String text) {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent open = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, SERVICE_CHANNEL).setSmallIcon(R.drawable.ic_stat_reach)
            .setContentTitle("Codex Reach").setContentText(text).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open).build();
    }

    private JSONObject request(String url, String key) throws Exception {
        HttpURLConnection current = (HttpURLConnection) new URL(url).openConnection();
        connection = current;
        current.setInstanceFollowRedirects(false); current.setConnectTimeout(8000); current.setReadTimeout(25000);
        current.setRequestProperty("Authorization", "Bearer " + key);
        try {
            int code = current.getResponseCode();
            if (code != 200) throw new Exception("提醒连接失败，HTTP " + code);
            try (InputStream input = current.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > 1048576) throw new Exception("提醒响应过大");
                    bytes.write(buffer, 0, count);
                }
                return new JSONObject(bytes.toString(java.nio.charset.StandardCharsets.UTF_8.name()));
            }
        } finally { current.disconnect(); if (connection == current) connection = null; }
    }

    private void receive() {
        int delay = 1000;
        NotificationManager manager = getSystemService(NotificationManager.class);
        while (!stopped) {
            SharedPreferences settings = NotificationsPlugin.preferences(this);
            if (!settings.getBoolean("enabled", false)) break;
            String serverId = settings.getString("serverId", "");
            String cursorKey = "cursor:" + serverId;
            try {
                long cursor = settings.getLong(cursorKey, -1);
                JSONObject page = request(settings.getString("url", "") + "/api/events?after=" + cursor + "&wait=true", settings.getString("key", ""));
                if (stopped || !settings.getBoolean("enabled", false) || !serverId.equals(settings.getString("serverId", ""))) continue;
                JSONArray events = page.getJSONArray("events");
                for (int index = 0; index < events.length(); index++) {
                    JSONObject event = events.getJSONObject(index);
                    if (settings.getBoolean(event.optString("kind"), true)) show(event, serverId);
                }
                String monitorError = page.isNull("monitorError") ? "" : page.optString("monitorError", "");
                settings.edit().putLong(cursorKey, page.getLong("cursor")).putLong("lastConnectedAt", System.currentTimeMillis()).putString("error", monitorError).commit();
                manager.notify(SERVICE_NOTIFICATION, connectionNotification(monitorError.isEmpty() ? "已连接电脑，正在接收任务提醒" : "电脑侧提醒暂不可用，正在重试"));
                delay = 1000;
            } catch (Exception error) {
                if (stopped) break;
                settings.edit().putString("error", "提醒连接中断，正在重新连接").apply();
                manager.notify(SERVICE_NOTIFICATION, connectionNotification("连接中断，正在重新连接"));
                try { Thread.sleep(delay); } catch (InterruptedException interrupted) { break; }
                delay = Math.min(30000, delay * 2);
            }
        }
        running = false;
    }

    private void show(JSONObject event, String serverId) throws Exception {
        event.put("serverId", serverId);
        String id = event.getString("id");
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction("reach.notification." + id);
        intent.putExtra("reachNotification", event.toString());
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, "reach-" + event.getString("kind"))
            .setSmallIcon(R.drawable.ic_stat_reach).setContentTitle(event.optString("title", "Codex Reach"))
            .setContentText(event.getString("body")).setStyle(new Notification.BigTextStyle().bigText(event.getString("body")))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true).setContentIntent(open).build();
        getSystemService(NotificationManager.class).notify(id, 1, notification);
    }

    @Override public void onDestroy() {
        stopped = true; running = false;
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
        worker.shutdownNow(); stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
