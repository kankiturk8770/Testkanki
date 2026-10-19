package com.kanki.tunnel;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

public class KankiService extends Service {
    public static final String CH = "kanki";

    @Override public int onStartCommand(Intent i, int flags, int startId) {
        if (i == null) { stopSelf(); return START_NOT_STICKY; }
        if ("STOP".equals(i.getAction())) {
            KankiNative.nativeStop();
            stopForeground(true); stopSelf();
            return START_NOT_STICKY;
        }
        createChannel();
        Intent stop = new Intent(this, KankiService.class).setAction("STOP");
        PendingIntent pi = PendingIntent.getService(this, 0, stop,
                PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH)
                .setContentTitle("KANKI tunnel")
                .setContentText("127.0.0.1:" + i.getIntExtra("localPort", 5000) +
                        " → " + i.getStringExtra("server"))
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .addAction(0, "Stop", pi)
                .setOngoing(true).build();
        startForeground(1, n);

        int r = KankiNative.nativeStart(
                i.getStringExtra("server"),
                i.getIntExtra("serverPort", 4000),
                i.getIntExtra("localPort", 5000),
                i.getStringExtra("key"),
                i.getIntExtra("repeat", 4),
                i.getIntExtra("fecK", 8),
                i.getBooleanExtra("fec", true),
                i.getBooleanExtra("autotune", false),
                i.getIntExtra("jitter", 1500));
        if (r != 0) { stopForeground(true); stopSelf(); }
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CH, "KANKI",
                    NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(c);
        }
    }

    @Override public void onDestroy() { KankiNative.nativeStop(); super.onDestroy(); }
    @Override public IBinder onBind(Intent i) { return null; }
}
