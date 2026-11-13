package io.github.dengjiajun.codexreach;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReaderPlugin.class);
        registerPlugin(NotificationsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
