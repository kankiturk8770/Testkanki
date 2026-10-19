package com.kanki.tunnel;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.SeekBar;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private EditText etServer, etPort, etLocal, etKey, etFecK, etJitter;
    private SeekBar sbRepeat;
    private TextView tvRepeat, tvStatus;
    private CheckBox cbFec, cbAutotune;
    private Button btn;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_main);
        etServer = findViewById(R.id.etServer);
        etPort   = findViewById(R.id.etPort);
        etLocal  = findViewById(R.id.etLocal);
        etKey    = findViewById(R.id.etKey);
        etFecK   = findViewById(R.id.etFecK);
        etJitter = findViewById(R.id.etJitter);
        sbRepeat = findViewById(R.id.sbRepeat);
        tvRepeat = findViewById(R.id.tvRepeat);
        tvStatus = findViewById(R.id.tvStatus);
        cbFec    = findViewById(R.id.cbFec);
        cbAutotune = findViewById(R.id.cbAutotune);
        btn      = findViewById(R.id.btnToggle);

        sbRepeat.setMax(7);           // 3..10
        sbRepeat.setProgress(1);      // default 4
        tvRepeat.setText("Repeat: 4x");
        sbRepeat.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar s, int p, boolean u) {
                tvRepeat.setText("Repeat: " + (p + 3) + "x");
            }
            public void onStartTrackingTouch(SeekBar s) {}
            public void onStopTrackingTouch(SeekBar s) {}
        });

        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);

        btn.setOnClickListener(v -> toggle());
        refresh();
    }

    private void toggle() {
        if (KankiNative.nativeRunning()) {
            Intent i = new Intent(this, KankiService.class).setAction("STOP");
            startService(i);
        } else {
            if (etKey.getText().toString().trim().length() != 64) {
                tvStatus.setText("Key must be 64 hex chars (openssl rand -hex 32)");
                return;
            }
            Intent i = new Intent(this, KankiService.class);
            i.putExtra("server", etServer.getText().toString().trim());
            i.putExtra("serverPort", parse(etPort, 4000));
            i.putExtra("localPort", parse(etLocal, 5000));
            i.putExtra("key", etKey.getText().toString().trim());
            i.putExtra("repeat", sbRepeat.getProgress() + 3);
            i.putExtra("fecK", parse(etFecK, 8));
            i.putExtra("fec", cbFec.isChecked());
            i.putExtra("autotune", cbAutotune.isChecked());
            i.putExtra("jitter", parse(etJitter, 1500));
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        }
        btn.postDelayed(this::refresh, 600);
    }

    private int parse(EditText e, int def) {
        try { return Integer.parseInt(e.getText().toString().trim()); }
        catch (Exception x) { return def; }
    }

    private void refresh() {
        boolean r = KankiNative.nativeRunning();
        btn.setText(r ? "Stop" : "Start");
        tvStatus.setText(r ? "● Tunnel running" : "○ Idle");
    }
}
