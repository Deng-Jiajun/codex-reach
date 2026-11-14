package io.github.dengjiajun.codexreach;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.PopupMenu;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ReaderActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String url;
    private String name;
    private LinearLayout root;
    private TextView status;
    private ImageButton expand;
    private WebView web;
    private PdfRenderer pdf;
    private File pdfFile;
    private Bitmap bitmap;
    private ImageView picture;
    private Button previous;
    private Button next;
    private int pageIndex;
    private boolean full;
    private volatile boolean closed;
    private boolean pdfLoading;
    private boolean backRegistered;
    private final android.window.OnBackInvokedCallback webBack = () -> web.goBack();
    private float gestureStart;

    private Button button(String label, Runnable action) {
        Button button = new Button(this, null, android.R.attr.borderlessButtonStyle);
        button.setText(label);
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(48));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private ImageButton iconButton(int icon, String label, Runnable action) {
        ImageButton button = new ImageButton(this, null, android.R.attr.borderlessButtonStyle);
        button.setImageResource(icon);
        button.setContentDescription(label);
        button.setTooltipText(label);
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        url = getIntent().getStringExtra("url");
        name = getIntent().getStringExtra("name");
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        root.setFitsSystemWindows(true);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackgroundColor(Color.rgb(247, 248, 245));
        TextView title = new TextView(this);
        title.setText(name);
        title.setSingleLine(true);
        title.setTextSize(16);
        title.setTextColor(Color.rgb(38, 57, 42));
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        title.setPadding(dp(12), 0, 0, 0);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        expand = iconButton(R.drawable.reader_expand, "展开阅读面板", () -> { full = !full; resize(); });
        ImageButton more = iconButton(R.drawable.reader_more, "阅读操作", () -> {});
        more.setOnClickListener(view -> {
            PopupMenu menu = new PopupMenu(this, more);
            menu.getMenu().add("重新读取").setOnMenuItemClickListener(item -> { if (web != null) web.reload(); else loadPdf(); return true; });
            if (getIntent().getBooleanExtra("savable", false)) menu.getMenu().add("保存到手机").setOnMenuItemClickListener(item -> { save(); return true; });
            else menu.getMenu().add("在浏览器打开").setOnMenuItemClickListener(item -> { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(web == null ? url : web.getUrl()))); return true; });
            menu.show();
        });
        header.addView(more);
        header.addView(expand);
        header.addView(iconButton(R.drawable.reader_close, "关闭", this::finish));
        header.setOnTouchListener((view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) { gestureStart = event.getRawY(); return true; }
            if (event.getAction() == MotionEvent.ACTION_UP) {
                float distance = event.getRawY() - gestureStart;
                if (Math.abs(distance) > dp(40)) { full = distance < 0; resize(); }
                else view.performClick();
                return true;
            }
            return true;
        });
        root.addView(header);
        status = new TextView(this);
        status.setPadding(dp(12), dp(4), dp(12), dp(4));
        root.addView(status);
        if ("pdf".equals(getIntent().getStringExtra("kind"))) openPdf();
        else openWeb();
        setContentView(root);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        resize();
    }

    private void resize() {
        int height = getWindowManager().getMaximumWindowMetrics().getBounds().height();
        getWindow().setGravity(Gravity.BOTTOM);
        getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, full ? ViewGroup.LayoutParams.MATCH_PARENT : height / 2);
        expand.setImageResource(full ? R.drawable.reader_collapse : R.drawable.reader_expand);
        expand.setContentDescription(full ? "收起阅读面板" : "展开阅读面板");
        expand.setTooltipText(full ? "收起阅读面板" : "展开阅读面板");
    }

    @Override public void onConfigurationChanged(Configuration configuration) { super.onConfigurationChanged(configuration); resize(); }

    private void openWeb() {
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) {
                status.setText(progress < 100 ? "正在读取… " + progress + "%" : "");
                status.setVisibility(progress < 100 ? View.VISIBLE : View.GONE);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void doUpdateVisitedHistory(WebView view, String address, boolean isReload) {
                boolean canGoBack = view.canGoBack();
                if (canGoBack == backRegistered) return;
                if (canGoBack) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, webBack);
                else getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(webBack);
                backRegistered = canGoBack;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                status.setText("此链接需要对应的手机应用打开");
                status.setVisibility(View.VISIBLE);
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) { status.setText("读取失败，" + error.getDescription()); status.setVisibility(View.VISIBLE); }
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        web.loadUrl(url);
    }

    private void openPdf() {
        LinearLayout navigation = new LinearLayout(this);
        previous = button("上一页", () -> renderPage(pageIndex - 1));
        next = button("下一页", () -> renderPage(pageIndex + 1));
        previous.setEnabled(false);
        next.setEnabled(false);
        navigation.addView(previous);
        navigation.addView(next);
        root.addView(navigation);
        ScrollView scroll = new ScrollView(this);
        picture = new ImageView(this);
        picture.setAdjustViewBounds(true);
        scroll.addView(picture);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        loadPdf();
    }

    private void loadPdf() {
        if (pdfLoading || closed) return;
        pdfLoading = true;
        int requestedPage = pageIndex;
        previous.setEnabled(false);
        next.setEnabled(false);
        status.setVisibility(View.VISIBLE);
        status.setText("正在下载 PDF…");
        worker.execute(() -> {
            File downloaded = null;
            try {
                downloaded = File.createTempFile("reader-", ".pdf", getCacheDir());
                try (FileOutputStream output = new FileOutputStream(downloaded)) { ReaderPlugin.download(url, output); }
                if (closed) return;
                PdfRenderer replacement = new PdfRenderer(ParcelFileDescriptor.open(downloaded, ParcelFileDescriptor.MODE_READ_ONLY));
                if (pdf != null) pdf.close();
                if (pdfFile != null) pdfFile.delete();
                pdf = replacement;
                pdfFile = downloaded;
                downloaded = null;
                int index = Math.min(requestedPage, pdf.getPageCount() - 1);
                runOnUiThread(() -> { pdfLoading = false; if (!closed) renderPage(index); });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    pdfLoading = false;
                    if (closed) return;
                    status.setText("PDF 读取失败，" + error.getMessage());
                    previous.setEnabled(pdf != null && pageIndex > 0);
                    next.setEnabled(pdf != null && pageIndex + 1 < pdf.getPageCount());
                });
            } finally { if (downloaded != null) downloaded.delete(); }
        });
    }

    private void renderPage(int index) {
        if (pdfLoading || closed) return;
        previous.setEnabled(false);
        next.setEnabled(false);
        status.setText("正在读取页面…");
        worker.execute(() -> {
            try {
                if (closed || pdf == null || index < 0 || index >= pdf.getPageCount()) return;
                Bitmap rendered;
                try (PdfRenderer.Page page = pdf.openPage(index)) {
                    float scale = Math.min(Math.min(2048, getResources().getDisplayMetrics().widthPixels) / (float) page.getWidth(), 4096f / page.getHeight());
                    int width = Math.max(1, Math.round(page.getWidth() * scale));
                    int height = Math.max(1, Math.round(page.getHeight() * scale));
                    rendered = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    rendered.eraseColor(Color.WHITE);
                    page.render(rendered, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                }
                int count = pdf.getPageCount();
                runOnUiThread(() -> {
                    if (closed || pdfLoading) { rendered.recycle(); return; }
                    picture.setImageBitmap(rendered);
                    if (bitmap != null) bitmap.recycle();
                    bitmap = rendered;
                    pageIndex = index;
                    status.setText((index + 1) + " / " + count);
                    previous.setEnabled(index > 0);
                    next.setEnabled(index + 1 < count);
                });
            } catch (Exception error) { runOnUiThread(() -> { if (!closed && !pdfLoading) status.setText("页面读取失败，" + error.getMessage()); }); }
        });
    }

    private void save() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(intent, 1);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 1 || resultCode != RESULT_OK || data == null) return;
        Uri target = data.getData();
        status.setVisibility(View.VISIBLE);
        status.setText("正在保存…");
        worker.execute(() -> {
            try (OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) throw new Exception("无法写入文件");
                ReaderPlugin.download(url, output);
                runOnUiThread(() -> status.setText("已保存到所选位置"));
            } catch (Exception error) { runOnUiThread(() -> status.setText("保存失败，" + error.getMessage())); }
        });
    }

    @Override protected void onDestroy() {
        closed = true;
        if (backRegistered) getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(webBack);
        if (web != null) web.destroy();
        if (bitmap != null) bitmap.recycle();
        worker.execute(() -> {
            if (pdf != null) pdf.close();
            if (pdfFile != null) pdfFile.delete();
        });
        worker.shutdown();
        super.onDestroy();
    }
}
