package io.github.dengjiajun.codexreach;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "ReachNotifications", permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }))
public class NotificationsPlugin extends Plugin {
    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("reach-notifications", Context.MODE_PRIVATE);
    }

    @Override public void load() { opened(getActivity().getIntent()); }

    @Override protected void handleOnNewIntent(Intent intent) { opened(intent); }

    private void opened(Intent intent) {
        String event = intent.getStringExtra("reachNotification");
        if (event == null) return;
        intent.removeExtra("reachNotification");
        try { notifyListeners("open", new JSObject(event), true); }
        catch (org.json.JSONException ignored) { }
    }

    @PluginMethod public void status(PluginCall call) {
        SharedPreferences settings = preferences(getContext());
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        call.resolve(new JSObject().put("enabled", settings.getBoolean("enabled", false))
            .put("permitted", manager.areNotificationsEnabled())
            .put("running", NotificationService.running)
            .put("lastConnectedAt", settings.getLong("lastConnectedAt", 0))
            .put("error", settings.getString("error", "")));
    }

    @PluginMethod public void configure(PluginCall call) {
        if (call.getBoolean("enabled", false) && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionResult");
            return;
        }
        apply(call);
    }

    @PermissionCallback private void permissionResult(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("通知权限尚未开启，可在系统设置中允许后重试");
            return;
        }
        apply(call);
    }

    private void apply(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        String url = call.getString("url", "");
        String serverId = call.getString("serverId", "");
        Uri uri = Uri.parse(url);
        if (enabled && ((!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) || serverId.isEmpty())) {
            call.reject("提醒服务地址无效"); return;
        }
        SharedPreferences settings = preferences(getContext());
        SharedPreferences.Editor editor = settings.edit().putBoolean("enabled", enabled);
        if (enabled) {
            editor.putString("url", url).putString("serverId", serverId).putString("key", call.getString("key", ""));
            for (String kind : new String[] { "completed", "failed", "approval", "question" }) editor.putBoolean(kind, call.getBoolean(kind, true));
        }
        editor.apply();
        Intent service = new Intent(getContext(), NotificationService.class);
        if (enabled) ContextCompat.startForegroundService(getContext(), service);
        else getContext().stopService(service);
        call.resolve(new JSObject().put("enabled", enabled));
    }

    @PluginMethod public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        getActivity().startActivity(intent); call.resolve();
    }
}
