package com.kanki.tunnel;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.*;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Round connect button: gradient ring, soft glow, spinning arc while connecting. */
public class ConnectButton extends View {
    public static final int IDLE = 0, CONNECTING = 1, CONNECTED = 2, WARNING = 3;
    private int state = IDLE;
    private float phase;
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG), glow = new Paint(Paint.ANTI_ALIAS_FLAG),
        face = new Paint(Paint.ANTI_ALIAS_FLAG), arc = new Paint(Paint.ANTI_ALIAS_FLAG),
        text = new Paint(Paint.ANTI_ALIAS_FLAG), sub = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final ValueAnimator spin = ValueAnimator.ofFloat(0f, 1f);

    public ConnectButton(Context c, AttributeSet a) {
        super(c, a);
        setLayerType(LAYER_TYPE_SOFTWARE, null);           // BlurMaskFilter glow
        setClickable(true);
        ring.setStyle(Paint.Style.STROKE);
        arc.setStyle(Paint.Style.STROKE); arc.setStrokeCap(Paint.Cap.ROUND);
        text.setColor(Color.WHITE); text.setTextAlign(Paint.Align.CENTER); text.setFakeBoldText(true);
        sub.setColor(0xFFB9BEDD); sub.setTextAlign(Paint.Align.CENTER);
        spin.setDuration(1600); spin.setRepeatCount(ValueAnimator.INFINITE); spin.setInterpolator(new LinearInterpolator());
        spin.addUpdateListener(v -> { phase = (float) v.getAnimatedValue(); invalidate(); });
        spin.start();
    }

    public void setState(int s) { if (s != state) { state = s; invalidate(); } }

    private int[] colors() {
        switch (state) {
            case CONNECTED: return new int[]{0xFF34D399, 0xFF22D3EE};
            case WARNING: return new int[]{0xFFFBBF24, 0xFFF87171};
            case CONNECTING: return new int[]{0xFF7C5CFF, 0xFF22D3EE};
            default: return new int[]{0xFF5B5F86, 0xFF8A8FB8};
        }
    }

    @Override protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight(), cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 * 0.80f;
        int[] col = colors();
        float pulse = state == CONNECTED ? 0.5f + 0.5f * (float) Math.sin(phase * Math.PI * 2) : 0.6f;
        glow.setShader(new RadialGradient(cx, cy, r * 1.25f, new int[]{(col[0] & 0x00FFFFFF) | ((int) (0x60 * pulse) << 24), 0x00000000}, null, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, r * 1.25f, glow);
        face.setShader(new LinearGradient(0, cy - r, 0, cy + r, 0x33FFFFFF, 0x0DFFFFFF, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, r, face);
        ring.setStrokeWidth(r * 0.06f);
        ring.setShader(new SweepGradient(cx, cy, new int[]{col[0], col[1], col[0]}, null));
        ring.setMaskFilter(state == IDLE ? null : new BlurMaskFilter(r * 0.05f, BlurMaskFilter.Blur.SOLID));
        c.drawCircle(cx, cy, r, ring);
        if (state == CONNECTING || state == WARNING) {
            arc.setStrokeWidth(r * 0.09f); arc.setColor(Color.WHITE);
            RectF box = new RectF(cx - r, cy - r, cx + r, cy + r);
            c.drawArc(box, phase * 360f - 90f, 70f, false, arc);
        }
        text.setTextSize(r * 0.26f);
        String label = state == IDLE ? "اتصال" : state == CONNECTED ? "متصل" : state == WARNING ? "ضعیف" : "…";
        c.drawText(label, cx, cy + r * 0.06f, text);
        sub.setTextSize(r * 0.12f);
        c.drawText(state == IDLE ? "برای اتصال بزنید" : "برای قطع بزنید", cx, cy + r * 0.32f, sub);
    }

    @Override protected void onDetachedFromWindow() { spin.cancel(); super.onDetachedFromWindow(); }
    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); if (!spin.isStarted()) spin.start(); }
}
