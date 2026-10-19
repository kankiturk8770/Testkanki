package com.kanki.tunnel;

public class KankiNative {
    static { System.loadLibrary("kanki"); }
    public static native int nativeStart(String server, int serverPort, int localPort,
                                         String keyHex, int repeat, int fecK,
                                         boolean fecOn, boolean autotune, int jitter);
    public static native void nativeStop();
    public static native boolean nativeRunning();
}
