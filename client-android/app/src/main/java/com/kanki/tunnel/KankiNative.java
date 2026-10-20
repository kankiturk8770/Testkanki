package com.kanki.tunnel;
public final class KankiNative {
    static { System.loadLibrary("kanki"); }
    private KankiNative() {}
    public static synchronized native int nativeStart(KankiService service, String server,
        int serverPort, String keyHex, int repeat, int fecK,
        boolean fecOn, boolean autotune, int jitter, int tunFd);
    public static synchronized native void nativeStop();
    public static synchronized native boolean nativeRunning();
    /** Fields: 0 state (-1 failure, 0 idle, 1 connecting, 2 authenticated PONG), 1 RTT ms,
     *  2 RX bytes, 3 TX bytes, 4 downlink copy loss per-mille, 5 downlink lost packets,
     *  6 downlink FEC-recovered, 7 uplink loss per-mille (server), 8 uplink lost, 9 uplink
     *  FEC-recovered, 10 port moves, 11 current repeat, 12 ms since last PONG,
     *  13 1 when the server's uplink report is fresh. */
    public static synchronized native long[] nativeStats();
}
