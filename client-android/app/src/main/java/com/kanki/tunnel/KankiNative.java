package com.kanki.tunnel;
public final class KankiNative {
    static { System.loadLibrary("kanki"); }
    private KankiNative() {}
    public static synchronized native int nativeStart(KankiService service, String server,
        int serverPort, String keyHex, int repeat, int fecK,
        boolean fecOn, boolean autotune, int jitter, int tunFd);
    public static synchronized native void nativeStop();
    public static synchronized native boolean nativeRunning();
    /** state: -1 failure, 0 idle, 1 connecting, 2 authenticated PONG; RTT ms, RX, TX. */
    public static synchronized native long[] nativeStats();
}
