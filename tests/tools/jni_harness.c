/* Runs the Android app's real native worker (client-android/.../kanki_jni.c) on
   Linux with a minimal fake JNI layer, against a TUN device, so network tests can
   exercise exactly the code that ships in the APK.
   usage: jni_harness SERVER_IPV4 PORT KEYHEX TUN_NAME SECONDS */
#include "../../client-android/app/src/main/cpp/kanki_jni.c"
#include <linux/if_tun.h>
#include <net/if.h>
#include <sys/ioctl.h>

static jint attach(JavaVM *v, void **env, void *a) { (void)v; (void)a; extern JNIEnv fake_env; *env = &fake_env; return JNI_OK; }
static jint detach(JavaVM *v) { (void)v; return JNI_OK; }
static jclass get_class(JNIEnv *e, jobject o) { (void)e; return (jclass)o; }
static jmethodID method(JNIEnv *e, jclass c, const char *n, const char *s) { (void)e; (void)c; (void)n; (void)s; return (jmethodID)1; }
static jboolean call_bool(JNIEnv *e, jobject o, jmethodID m, ...) { (void)e; (void)o; (void)m; return JNI_TRUE; }
static jboolean no_exception(JNIEnv *e) { (void)e; return JNI_FALSE; }
static void delete_ref(JNIEnv *e, jobject o) { (void)e; (void)o; }
static const char *utf(JNIEnv *e, jstring s, jboolean *c) { (void)e; if (c) *c = 0; return (const char *)s; }
static void release_utf(JNIEnv *e, jstring s, const char *c) { (void)e; (void)s; (void)c; }
static jint get_vm(JNIEnv *e, JavaVM **v) { (void)e; extern JavaVM fake_vm_ptr; *v = &fake_vm_ptr; return JNI_OK; }
static jobject global(JNIEnv *e, jobject o) { (void)e; return o; }
static jlong stats_buf[NSTATS];
static jlongArray new_long_array(JNIEnv *e, jsize n) { (void)e; (void)n; return (jlongArray)stats_buf; }
static void set_long_region(JNIEnv *e, jlongArray a, jsize s, jsize n, const jlong *v) { (void)e; (void)a; memcpy(stats_buf + s, v, n * sizeof *v); }

static struct JNINativeInterface_ fns;
static struct JNIInvokeInterface_ vmfns;
JNIEnv fake_env;
JavaVM fake_vm_ptr;

int main(int argc, char **argv) {
    if (argc != 6) { fprintf(stderr, "usage: jni_harness SERVER PORT KEYHEX TUN SECONDS\n"); return 2; }
    fns.GetObjectClass = get_class; fns.GetMethodID = method; fns.CallBooleanMethod = call_bool;
    fns.ExceptionCheck = no_exception; fns.DeleteLocalRef = delete_ref; fns.GetStringUTFChars = utf;
    fns.ReleaseStringUTFChars = release_utf; fns.GetJavaVM = get_vm; fns.NewGlobalRef = global;
    fns.DeleteGlobalRef = delete_ref; fns.NewLongArray = new_long_array; fns.SetLongArrayRegion = set_long_region;
    vmfns.AttachCurrentThread = (void *)attach; vmfns.DetachCurrentThread = detach;
    fake_env = &fns; fake_vm_ptr = &vmfns;
    int tun = open("/dev/net/tun", O_RDWR);
    struct ifreq req = {0}; req.ifr_flags = IFF_TUN | IFF_NO_PI; snprintf(req.ifr_name, sizeof req.ifr_name, "%s", argv[4]);
    if (tun < 0 || ioctl(tun, TUNSETIFF, &req)) { perror("tun"); return 1; }
    JNIEnv *env = &fake_env;
    int r = Java_com_kanki_tunnel_KankiNative_nativeStart(env, NULL, (jobject)1, (jstring)argv[1], atoi(argv[2]),
                                                         (jstring)argv[3], 4, 8, 1, 1, 0, tun);
    if (r) { fprintf(stderr, "nativeStart=%d\n", r); return 1; }
    for (int t = 0; t < atoi(argv[5]) * 2; t++) {
        usleep(500000);
        Java_com_kanki_tunnel_KankiNative_nativeStats(env, NULL);
        printf("{\"t\":%.1f,\"state\":%lld,\"rtt\":%lld,\"dn_loss_pm\":%lld,\"dn_lost\":%lld,\"dn_rec\":%lld,\"up_loss_pm\":%lld,"
               "\"up_lost\":%lld,\"up_rec\":%lld,\"hops\":%lld,\"silence_ms\":%lld,\"qual\":%lld}\n", t / 2.0,
               (long long)stats_buf[0], (long long)stats_buf[1], (long long)stats_buf[4], (long long)stats_buf[5],
               (long long)stats_buf[6], (long long)stats_buf[7], (long long)stats_buf[8], (long long)stats_buf[9],
               (long long)stats_buf[10], (long long)stats_buf[12], (long long)stats_buf[13]);
        fflush(stdout);
    }
    Java_com_kanki_tunnel_KankiNative_nativeStop(env, NULL);
    close(tun);
    return 0;
}
