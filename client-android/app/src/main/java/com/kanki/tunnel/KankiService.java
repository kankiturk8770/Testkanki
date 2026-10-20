package com.kanki.tunnel;
import android.app.*;
import android.content.Intent;
import android.net.*;
import android.os.*;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class KankiService extends VpnService {
    public static final String CH="kanki";
    private static volatile boolean active;
    public static boolean isActive(){return active;}
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ExecutorService resolver=Executors.newSingleThreadExecutor();
    private ParcelFileDescriptor tun;
    private Intent config;
    private int generation;
    private long attemptAt, lastGood, connectedAt, lossNoticeAt, lostNoticeAt, pingNoticeAt;
    private long prevState=Long.MIN_VALUE, prevHops, prevLost, silentSince;
    private static volatile long sessionStart;
    public static long connectedSince(){return sessionStart;}
    private Network selectedNetwork;
    private boolean resolving, destroyed;
    private ConnectivityManager cm;
    private final ConnectivityManager.NetworkCallback callback=new ConnectivityManager.NetworkCallback(){
        @Override public void onAvailable(Network n){handler.post(()->{if(config!=null&&!n.equals(selectedNetwork)&&underlay()==null)connect();});}
        @Override public void onLost(Network n){handler.post(()->{if(n.equals(selectedNetwork)){KankiEvents.add(KankiEvents.WARN,"شبکهٔ اینترنت گوشی قطع یا عوض شد");release();connect();}});}
    };
    @Override public void onCreate(){
        super.onCreate();cm=getSystemService(ConnectivityManager.class);
        NotificationChannel ch=new NotificationChannel(CH,"KANKI connection",NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
        cm.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(),callback);
    }
    private Network underlay(){
        for(Network n:cm.getAllNetworks()){
            NetworkCapabilities c=cm.getNetworkCapabilities(n);
            if(c!=null&&c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)&&c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN))return n;
        }return null;
    }
    private void notification(String text){
        PendingIntent stop=PendingIntent.getService(this,0,new Intent(this,KankiService.class).setAction("STOP"),PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open=PendingIntent.getActivity(this,1,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE);
        Notification n=new Notification.Builder(this,CH).setContentTitle("KANKI Tunnel").setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync).setContentIntent(open).setOngoing(true).addAction(0,"Disconnect",stop).build();
        startForeground(1,n);
    }
    @Override public int onStartCommand(Intent intent,int flags,int id){
        if(intent==null||"STOP".equals(intent.getAction())){shutdown();return START_NOT_STICKY;}
        if(VpnService.prepare(this)!=null){shutdown();return START_NOT_STICKY;}
        if(config!=null)return START_NOT_STICKY;
        active=true;config=new Intent(intent);notification("Connecting securely…");
        KankiEvents.resetHistory();KankiEvents.add(KankiEvents.INFO,"شروع اتصال به "+intent.getStringExtra("server")+":"+intent.getIntExtra("serverPort",0));
        prevState=Long.MIN_VALUE;lastGood=0;sessionStart=0;connect();handler.post(tick);return START_NOT_STICKY;
    }
    private void release(){release(false);}
    private void release(boolean closeTun){
        generation++;resolving=false;KankiNative.nativeStop();
        if(closeTun&&tun!=null){try{tun.close();}catch(Exception ignored){}tun=null;}
        selectedNetwork=null;
    }
    private void connect(){
        if(config==null||destroyed||resolving)return;
        release();attemptAt=SystemClock.elapsedRealtime();final int attempt=generation;final Intent options=new Intent(config);
        final Network network=underlay();
        if(network==null){notification("Waiting for an internet connection…");return;}
        resolving=true;selectedNetwork=network;
        resolver.execute(()->{
            try{
                String host=options.getStringExtra("server"),key=options.getStringExtra("key");
                if(host==null||key==null||!key.matches("[a-fA-F0-9]{64}"))throw new IllegalArgumentException("Invalid server or key");
                InetAddress address=null;
                for(InetAddress a:network.getAllByName(host))if(a instanceof Inet4Address){address=a;break;}
                if(address==null)throw new IllegalArgumentException("Server needs an IPv4 address");
                final String numeric=address.getHostAddress();
                handler.post(()->{
                    if(attempt!=generation||config==null)return;
                    resolving=false;
                    try{
                        if(tun==null)tun=KankiTunConfig.establish(this,options.getStringExtra("ip"),options.getStringExtra("dns"),options.getIntExtra("mtu",1280),
                            "gaming".equals(options.getStringExtra("mode")),options.getStringArrayListExtra("packages"));
                        int fd=tun.getFd();
                        setUnderlyingNetworks(new Network[]{network});
                        int result=KankiNative.nativeStart(this,numeric,options.getIntExtra("serverPort",4000),key,
                            options.getIntExtra("repeat",4),options.getIntExtra("fecK",8),options.getBooleanExtra("fec",true),
                            options.getBooleanExtra("autotune",true),options.getIntExtra("jitter",0),fd);
                        if(result!=0)throw new IllegalStateException("Native start failed: "+result);
                        prevHops=0;prevLost=0;
                        notification("Waiting for authenticated server response…");
                    }catch(Exception e){error(e.getMessage());shutdown();}
                });
            }catch(Exception e){handler.post(()->{if(attempt==generation&&config!=null){resolving=false;notification("Server resolution failed; retrying…");}});}
        });
    }
    private void error(String text){getSharedPreferences("kanki",MODE_PRIVATE).edit().putString("error",text==null?"Connection failed":text).apply();}
    private static String pct(long pm){return String.format(java.util.Locale.US,"%.1f%%",pm/10.0);}
    /** Turns native counters into a readable timeline: drops, recoveries, port moves, loss. */
    private void watch(long[] s,long now){
        long st=s[0];
        if(st==2&&prevState!=2){
            if(silentSince>0)KankiEvents.add(KankiEvents.OK,"اتصال برگشت پس از "+((now-silentSince+500)/1000)+" ثانیه قطعی");
            else KankiEvents.add(KankiEvents.OK,"متصل شد · پینگ سرور "+s[1]+" ms");
            silentSince=0;
            if(sessionStart==0)sessionStart=System.currentTimeMillis();
        }else if(st!=2&&prevState==2){
            silentSince=now-s[12];
            KankiEvents.add(KankiEvents.BAD,"سرور جواب نمی‌دهد (قطعی مسیر)");
        }
        prevState=st;
        if(s[10]>prevHops){KankiEvents.add(KankiEvents.WARN,"مسیر جدید: پورت گوشی عوض شد تا اتصال برگردد (#"+s[10]+")");prevHops=s[10];}
        long lost=s[5]+s[8];
        if(lost>prevLost&&now-lostNoticeAt>10000){
            KankiEvents.add(KankiEvents.BAD,(lost-prevLost)+" بسته از دست رفت · دریافت "+s[5]+" · ارسال "+s[8]+" (کل)");
            prevLost=lost;lostNoticeAt=now;
        }
        if(st==2&&(s[4]>=150||(s[13]==1&&s[7]>=150))&&now-lossNoticeAt>30000){
            KankiEvents.add(KankiEvents.WARN,"Loss بالا در مسیر · دریافت "+pct(s[4])+" · ارسال "+pct(s[7])+" · Repeat "+s[11]+"× (FEC جبران می‌کند)");
            lossNoticeAt=now;
        }
        if(st==2&&s[1]>=180&&now-pingNoticeAt>30000){KankiEvents.add(KankiEvents.WARN,"پینگ سرور بالا رفت: "+s[1]+" ms");pingNoticeAt=now;}
        KankiEvents.sample(st==2?s[1]:-1,Math.max(s[4],s[13]==1?s[7]:0));
    }
    private final Runnable tick=new Runnable(){public void run(){
        if(config==null||destroyed)return;
        long[] s=KankiNative.nativeStats();long now=SystemClock.elapsedRealtime();
        if(s!=null&&s.length>=14&&KankiNative.nativeRunning())watch(s,now);
        if(s!=null&&s[0]==2)lastGood=now;
        // The native worker already moves to a fresh port after 2.5 s of silence;
        // a full restart (new DNS lookup, new session) is only the last resort.
        if(!resolving&&(!KankiNative.nativeRunning()||(s!=null&&s[0]!=2&&now-Math.max(lastGood,attemptAt)>20000))){
            KankiEvents.add(KankiEvents.WARN,"راه‌اندازی دوبارهٔ کامل اتصال");sessionStart=0;connect();
        }
        else if(s!=null&&s[0]==2)notification("متصل · "+s[1]+" ms · loss ↓"+pct(s[4])+" ↑"+pct(s[13]==1?s[7]:0));
        else notification("در حال اتصال دوباره…");
        handler.postDelayed(this,1000);
    }};
    private void shutdown(){if(config!=null)KankiEvents.add(KankiEvents.INFO,"اتصال توسط کاربر قطع شد");sessionStart=0;active=false;config=null;handler.removeCallbacks(tick);release(true);stopForeground(true);stopSelf();}
    @Override public void onRevoke(){shutdown();super.onRevoke();}
    @Override public void onDestroy(){destroyed=true;active=false;config=null;handler.removeCallbacksAndMessages(null);release(true);cm.unregisterNetworkCallback(callback);resolver.shutdownNow();stopForeground(true);super.onDestroy();}
}
