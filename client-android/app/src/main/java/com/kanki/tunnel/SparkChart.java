package com.kanki.tunnel;

import android.content.Context;
import android.graphics.*;
import android.util.AttributeSet;
import android.view.View;

/** Live chart: server ping as a gradient line, packet loss as bars. */
public class SparkChart extends View {
    private float[] rtt = new float[0], loss = new float[0];
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG), fill = new Paint(Paint.ANTI_ALIAS_FLAG),
        bar = new Paint(Paint.ANTI_ALIAS_FLAG), grid = new Paint(Paint.ANTI_ALIAS_FLAG), label = new Paint(Paint.ANTI_ALIAS_FLAG);

    public SparkChart(Context c, AttributeSet a) {
        super(c, a);
        line.setStyle(Paint.Style.STROKE); line.setStrokeWidth(dp(2.2f)); line.setStrokeJoin(Paint.Join.ROUND);
        bar.setColor(0xCCF87171);
        grid.setColor(0x1FFFFFFF); grid.setStrokeWidth(dp(1));
        label.setColor(0xFF8C93B8); label.setTextSize(dp(10));
    }

    private float dp(float v) { return v * getResources().getDisplayMetrics().density; }

    /** rttMs: -1 means no answer; lossPm: per-mille. */
    public void setData(float[] rttMs, float[] lossPm) { rtt = rttMs; loss = lossPm; invalidate(); }

    @Override protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight(), top = dp(14), bottom = h - dp(4);
        for (int i = 0; i < 3; i++) { float y = top + (bottom - top) * i / 2f; c.drawLine(0, y, w, y, grid); }
        int n = rtt.length;
        if (n < 2) { c.drawText("پس از اتصال، نمودار اینجا نمایش داده می‌شود", dp(8), h / 2, label); return; }
        float max = 50;
        for (float v : rtt) max = Math.max(max, v);
        max = (float) (Math.ceil(max / 50.0) * 50);
        float step = w / (n - 1);
        for (int i = 0; i < n; i++) {
            if (loss[i] <= 0) continue;
            float bh = Math.min(1f, loss[i] / 500f) * (bottom - top);
            c.drawRect(i * step - step * 0.35f, bottom - bh, i * step + step * 0.35f, bottom, bar);
        }
        Path p = new Path(), area = new Path();
        boolean open = false; float lastX = 0;
        for (int i = 0; i < n; i++) {
            float x = i * step;
            if (rtt[i] < 0) { if (open) { area.lineTo(lastX, bottom); area.close(); } open = false; continue; }
            float y = bottom - (rtt[i] / max) * (bottom - top);
            if (!open) { p.moveTo(x, y); area.moveTo(x, bottom); area.lineTo(x, y); open = true; }
            else { p.lineTo(x, y); area.lineTo(x, y); }
            lastX = x;
        }
        if (open) { area.lineTo(lastX, bottom); area.close(); }
        fill.setShader(new LinearGradient(0, top, 0, bottom, 0x557C5CFF, 0x007C5CFF, Shader.TileMode.CLAMP));
        c.drawPath(area, fill);
        line.setShader(new LinearGradient(0, 0, w, 0, 0xFF9F8CFF, 0xFF22D3EE, Shader.TileMode.CLAMP));
        c.drawPath(p, line);
        c.drawText((int) max + " ms", dp(4), top - dp(3), label);
    }
}
