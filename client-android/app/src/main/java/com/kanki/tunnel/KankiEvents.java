package com.kanki.tunnel;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** In-memory connection timeline and quality history shared by the service and the screen. */
public final class KankiEvents {
    public static final int OK = 0, INFO = 1, WARN = 2, BAD = 3;
    public static final class Event {
        public final String time, text; public final int level;
        Event(String time, String text, int level) { this.time = time; this.text = text; this.level = level; }
    }
    private static final int MAX_EVENTS = 60, HISTORY = 180;
    private static final ArrayList<Event> events = new ArrayList<>();
    private static final float[] rtt = new float[HISTORY], loss = new float[HISTORY];
    private static int samples;

    private KankiEvents() {}

    public static synchronized void add(int level, String text) {
        events.add(0, new Event(new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()), text, level));
        while (events.size() > MAX_EVENTS) events.remove(events.size() - 1);
    }
    public static synchronized List<Event> list() { return new ArrayList<>(events); }
    public static synchronized void clear() { events.clear(); }

    public static synchronized void sample(float rttMs, float lossPm) {
        System.arraycopy(rtt, 1, rtt, 0, HISTORY - 1); System.arraycopy(loss, 1, loss, 0, HISTORY - 1);
        rtt[HISTORY - 1] = rttMs; loss[HISTORY - 1] = lossPm;
        if (samples < HISTORY) samples++;
    }
    public static synchronized float[][] history() {
        float[] r = new float[samples], l = new float[samples];
        System.arraycopy(rtt, HISTORY - samples, r, 0, samples);
        System.arraycopy(loss, HISTORY - samples, l, 0, samples);
        return new float[][]{r, l};
    }
    public static synchronized void resetHistory() { samples = 0; }
}
