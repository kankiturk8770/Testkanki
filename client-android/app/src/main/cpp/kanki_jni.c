/* kanki_jni.c — JNI bridge: runs the kanki client loop on a native thread */
#include <jni.h>
#include <pthread.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/select.h>
#include <android/log.h>

#include "kanki_link.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  "kanki", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "kanki", __VA_ARGS__)

static volatile int g_running = 0;
static pthread_t g_thread;
static int g_joinable = 0;        /* thread started and not yet joined */
static int g_tfd = -1, g_lfd = -1;

typedef struct {
    char server[256];
    uint16_t server_port;
    uint16_t local_port;
    uint8_t psk[32];
    int repeat, fec_k, fec_on, autotune, jitter;
} jni_cfg;

static jni_cfg g_cfg;

/* one wire packet from the server: deliver DATA (plus anything FEC rebuilt)
   to the local app, answer with TUNE if auto-tune asks for it */
static void tunnel_in(kanki_link *down, const struct sockaddr_in *server,
                      const uint8_t *buf, int n,
                      const struct sockaddr_in *app, socklen_t alen, int have_app) {
    kanki_pkt pkt;
    int r = link_recv(down, buf, n, &pkt);
    while (r) {
        if (have_app && (pkt.flags & FLAG_DATA))
            sendto(g_lfd, pkt.payload, pkt.payload_len, 0, (const struct sockaddr *)app, alen);
        r = link_recv_stashed(down, &pkt);
    }
    if (down->pending_tune)
        link_send_tune(down, g_tfd, (const struct sockaddr *)server, sizeof *server);
}

static void *client_thread(void *arg) {
    (void)arg;
    char port[16]; snprintf(port, sizeof port, "%u", g_cfg.server_port);
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM }, *ai;
    if (getaddrinfo(g_cfg.server, port, &hints, &ai) != 0) {
        LOGE("dns fail"); g_running = 0; return NULL;
    }
    struct sockaddr_in server = *(struct sockaddr_in *)ai->ai_addr;
    freeaddrinfo(ai);

    g_tfd = socket(AF_INET, SOCK_DGRAM, 0);
    g_lfd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in bind_addr = { .sin_family = AF_INET };
    bind_addr.sin_port = htons(g_cfg.local_port);
    inet_pton(AF_INET, "127.0.0.1", &bind_addr.sin_addr);
    if (g_tfd < 0 || g_lfd < 0 || bind(g_lfd, (struct sockaddr *)&bind_addr, sizeof bind_addr) < 0) {
        LOGE("bind fail");
        if (g_tfd >= 0) close(g_tfd);
        if (g_lfd >= 0) close(g_lfd);
        g_tfd = g_lfd = -1; g_running = 0;
        return NULL;
    }

    kanki_link up = {0}, down = {0};
    link_init(&up, g_cfg.psk, g_cfg.repeat, g_cfg.fec_k, g_cfg.fec_on);
    link_init(&down, g_cfg.psk, g_cfg.repeat, g_cfg.fec_k, g_cfg.fec_on);
    up.autotune = g_cfg.autotune; down.autotune = g_cfg.autotune;
    up.cfg.jitter_us = g_cfg.jitter; down.cfg.jitter_us = g_cfg.jitter;
    down.tx = &up;                     /* TUNE from the server adjusts what we send it */

    const char *hello = "KANKI-HELLO";
    link_send(&up, g_tfd, (struct sockaddr *)&server, sizeof server, FLAG_CONTROL,
              (const uint8_t *)hello, strlen(hello));
    LOGI("tunnel up: 127.0.0.1:%u -> %s:%u repeat=%d fec=%d autotune=%d",
         g_cfg.local_port, g_cfg.server, g_cfg.server_port,
         up.cfg.repeat, g_cfg.fec_on, g_cfg.autotune);

    struct sockaddr_in app = {0}; socklen_t alen = sizeof app; int have_app = 0;
    uint8_t buf[KANKI_MAX_PKT];
    int maxfd = (g_tfd > g_lfd ? g_tfd : g_lfd) + 1;
    while (g_running) {
        fd_set rf; FD_ZERO(&rf); FD_SET(g_tfd, &rf); FD_SET(g_lfd, &rf);
        struct timeval tv = link_poll_tv(&up);
        int sel = select(maxfd, &rf, NULL, NULL, &tv);
        link_fec_idle(&up, g_tfd, (struct sockaddr *)&server, sizeof server);
        if (sel <= 0) continue;
        if (FD_ISSET(g_lfd, &rf)) {
            struct sockaddr_in from; socklen_t flen = sizeof from;
            ssize_t n = recvfrom(g_lfd, buf, sizeof buf, 0, (struct sockaddr *)&from, &flen);
            if (n > 0) {
                app = from; alen = flen; have_app = 1;   /* follow the app's latest port */
                link_send(&up, g_tfd, (struct sockaddr *)&server, sizeof server,
                          FLAG_DATA, buf, (uint16_t)n);
            }
        }
        if (FD_ISSET(g_tfd, &rf)) {
            ssize_t n = recvfrom(g_tfd, buf, sizeof buf, 0, NULL, NULL);
            if (n > 0) tunnel_in(&down, &server, buf, (int)n, &app, alen, have_app);
        }
    }
    link_send(&up, g_tfd, (struct sockaddr *)&server, sizeof server, FLAG_TAIL, NULL, 0);
    close(g_tfd); close(g_lfd); g_tfd = g_lfd = -1;
    LOGI("tunnel stopped");
    return NULL;
}

static int parse_hex(const char *hex, uint8_t out[32]) {
    if (strlen(hex) != 64) return -1;
    for (int i = 0; i < 32; i++)
        if (sscanf(hex + 2 * i, "%2hhx", &out[i]) != 1) return -1;
    return 0;
}

JNIEXPORT jint JNICALL
Java_com_kanki_tunnel_KankiNative_nativeStart(JNIEnv *env, jclass cls,
        jstring server, jint serverPort, jint localPort, jstring keyHex,
        jint repeat, jint fecK, jboolean fecOn, jboolean autotune, jint jitter) {
    (void)cls;
    if (g_running) return -1;
    if (g_joinable) { pthread_join(g_thread, NULL); g_joinable = 0; }   /* thread that quit on its own */
    const char *srv = (*env)->GetStringUTFChars(env, server, NULL);
    const char *key = (*env)->GetStringUTFChars(env, keyHex, NULL);
    snprintf(g_cfg.server, sizeof g_cfg.server, "%s", srv);
    int bad = parse_hex(key, g_cfg.psk);
    (*env)->ReleaseStringUTFChars(env, server, srv);
    (*env)->ReleaseStringUTFChars(env, keyHex, key);
    if (bad) return -2;
    g_cfg.server_port = (uint16_t)serverPort;
    g_cfg.local_port  = (uint16_t)localPort;
    g_cfg.repeat = repeat; g_cfg.fec_k = fecK;
    g_cfg.fec_on = fecOn; g_cfg.autotune = autotune; g_cfg.jitter = jitter;
    g_running = 1;
    if (pthread_create(&g_thread, NULL, client_thread, NULL) != 0) { g_running = 0; return -3; }
    g_joinable = 1;
    return 0;
}

JNIEXPORT void JNICALL
Java_com_kanki_tunnel_KankiNative_nativeStop(JNIEnv *env, jclass cls) {
    (void)env; (void)cls;
    g_running = 0;
    if (g_joinable) { pthread_join(g_thread, NULL); g_joinable = 0; }
}

JNIEXPORT jboolean JNICALL
Java_com_kanki_tunnel_KankiNative_nativeRunning(JNIEnv *env, jclass cls) {
    (void)env; (void)cls;
    return g_running ? JNI_TRUE : JNI_FALSE;
}
