package io.github.dengjiajun.codexreach;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

@CapacitorPlugin(name = "ReachReader")
public class ReaderPlugin extends Plugin {
    private final ExecutorService worker = Executors.newFixedThreadPool(2);

    @Override public void load() {
        File directory = new File(getContext().getCacheDir(), "reader-images");
        File[] previous = directory.listFiles();
        if (previous != null) for (File file : previous) file.delete();
        directory.mkdirs();
    }

    static void download(String address, OutputStream output) throws Exception {
        if (address.startsWith("data:image/") && address.contains(";base64,")) {
            int start = address.indexOf(";base64,") + 8;
            byte[] encoded = address.substring(start).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            try (InputStream input = new android.util.Base64InputStream(new java.io.ByteArrayInputStream(encoded), android.util.Base64.DEFAULT)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            return;
        }
        URL url = new URL(address);
        if (!url.getProtocol().equals("http") && !url.getProtocol().equals("https")) throw new Exception("文件地址协议不受支持");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(25000);
        connection.setRequestProperty("Accept-Encoding", "gzip");
        try {
            if (connection.getResponseCode() != 200) throw new Exception("文件读取失败，HTTP " + connection.getResponseCode());
            InputStream stream = connection.getInputStream();
            if ("gzip".equalsIgnoreCase(connection.getContentEncoding())) stream = new GZIPInputStream(stream);
            try (InputStream input = stream) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
        } finally { connection.disconnect(); }
    }

    @PluginMethod public void open(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) { call.reject("地址协议不受支持"); return; }
        Intent intent = new Intent(getActivity(), ReaderActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("name", call.getString("name", uri.getHost()));
        intent.putExtra("kind", call.getString("kind", "html"));
        intent.putExtra("savable", call.getBoolean("savable", false));
        startActivityForResult(call, intent, "closed");
    }

    @ActivityCallback private void closed(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve();
    }

    @PluginMethod public void image(PluginCall call) {
        worker.execute(() -> {
            File file = null;
            try {
                file = File.createTempFile("image-", ".bin", new File(getContext().getCacheDir(), "reader-images"));
                try (FileOutputStream output = new FileOutputStream(file)) { download(call.getString("url", ""), output); }
                call.resolve(new JSObject().put("path", file.getAbsolutePath()));
            } catch (Exception error) { if (file != null) file.delete(); call.reject(error.getMessage()); }
        });
    }

    @PluginMethod public void save(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "文件"));
        startActivityForResult(call, intent, "saveSelected");
    }

    @ActivityCallback private void saveSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("saved", false)); return;
        }
        Uri target = result.getData().getData();
        worker.execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) throw new Exception("无法写入所选文件");
                download(call.getString("url", ""), output);
                call.resolve(new JSObject().put("saved", true));
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }

    @Override protected void handleOnDestroy() { worker.shutdown(); }
}
