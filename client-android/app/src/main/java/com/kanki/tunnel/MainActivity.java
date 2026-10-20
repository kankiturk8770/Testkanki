package com.kanki.tunnel;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.LinearGradient;
import android.graphics.Shader;
import android.net.VpnService;
import android.os.*;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import org.json.*;
import java.net.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends AppCompatActivity {
    private EditText server,port,key,fecK,jitter,ip,dns,mtu,subscription;
    private TextView status,profileText,timer,badge,ping,loss,saved,lost,hopsText,down,upText,repeatNow,repeatText,gamesLabel,chipFull,chipGaming;
    private SeekBar repeat;
    private CheckBox fec,autotune;
    private Button importButton;
    private ConnectButton toggle;
    private SparkChart chart;
    private LinearLayout eventList;
    private int mode;                      // 0 full, 1 gaming
    private String profileName="";
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private ArrayList<String> packages=new ArrayList<>();
    private boolean visible;
    private int shownEvents=-1;
    private static final int VPN_REQUEST=73;

    private SharedPreferences prefs(){return getSharedPreferences("kanki",MODE_PRIVATE);}

    @Override public void onCreate(Bundle b){
        super.onCreate(b);setContentView(R.layout.activity_main);
        server=findViewById(R.id.etServer);port=findViewById(R.id.etPort);key=findViewById(R.id.etKey);
        fecK=findViewById(R.id.etFecK);jitter=findViewById(R.id.etJitter);ip=findViewById(R.id.etIp);dns=findViewById(R.id.etDns);mtu=findViewById(R.id.etMtu);
        subscription=findViewById(R.id.etSubscription);status=findViewById(R.id.tvStatus);profileText=findViewById(R.id.tvProfile);timer=findViewById(R.id.tvTimer);
        badge=findViewById(R.id.tvBadge);ping=findViewById(R.id.tvPing);loss=findViewById(R.id.tvLoss);saved=findViewById(R.id.tvSaved);lost=findViewById(R.id.tvLost);
        hopsText=findViewById(R.id.tvHops);down=findViewById(R.id.tvDown);upText=findViewById(R.id.tvUp);repeatNow=findViewById(R.id.tvRepeat2);
        repeatText=findViewById(R.id.tvRepeat);gamesLabel=findViewById(R.id.tvGames);repeat=findViewById(R.id.sbRepeat);fec=findViewById(R.id.cbFec);autotune=findViewById(R.id.cbAutotune);
        toggle=findViewById(R.id.btnToggle);importButton=findViewById(R.id.btnImport);chart=findViewById(R.id.chart);eventList=findViewById(R.id.eventList);
        chipFull=findViewById(R.id.chipFull);chipGaming=findViewById(R.id.chipGaming);
        TextView brand=findViewById(R.id.tvBrand);
        brand.post(()->brand.getPaint().setShader(new LinearGradient(0,0,brand.getWidth(),0,0xFFB9ADFF,0xFF22D3EE,Shader.TileMode.CLAMP)));
        repeat.setMax(7);repeat.setProgress(1);repeatText.setText("Repeat · 4×");
        repeat.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar s,int n,boolean user){repeatText.setText("Repeat · "+(n+3)+"×");}public void onStartTrackingTouch(SeekBar s){}public void onStopTrackingTouch(SeekBar s){}});
        toggle.setOnClickListener(v->toggle());importButton.setOnClickListener(v->importSubscription(false));findViewById(R.id.btnGames).setOnClickListener(v->chooseGames());
        findViewById(R.id.btnAdvanced).setOnClickListener(v->{View a=findViewById(R.id.advanced);a.setVisibility(a.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE);});
        findViewById(R.id.btnClearLog).setOnClickListener(v->{KankiEvents.clear();shownEvents=-1;});
        chipFull.setOnClickListener(v->setMode(0));chipGaming.setOnClickListener(v->setMode(1));
        packages=new ArrayList<>(prefs().getStringSet("packages",new HashSet<>()));updateGames();
        setMode(prefs().getInt("mode",0));
        // The subscription link is kept in app-private storage (no backup) so the
        // profile is ready again after the app restarts.
        String link=prefs().getString("subscription","");
        if(!link.isEmpty()){subscription.setText(link);importSubscription(true);}
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},1);
    }
    private void setMode(int m){
        mode=m==1?1:0;prefs().edit().putInt("mode",mode).apply();
        chipFull.setBackgroundResource(mode==0?R.drawable.chip_on:R.drawable.chip_off);chipFull.setTextColor(mode==0?0xFFFFFFFF:0xFFC9CEEA);
        chipGaming.setBackgroundResource(mode==1?R.drawable.chip_on:R.drawable.chip_off);chipGaming.setTextColor(mode==1?0xFFFFFFFF:0xFFC9CEEA);
    }
    private String text(EditText f){return f.getText().toString().trim();}
    private int number(EditText f,int min,int max){
        try{int n=Integer.parseInt(text(f));if(n>=min&&n<=max)return n;}catch(NumberFormatException ignored){}
        f.setError(min+" … "+max);throw new IllegalArgumentException("مقدار عددی نامعتبر است");
    }
    private String modeName(){return mode==1?"gaming":"full";}
    private Intent options(){
        if(text(server).isEmpty()||text(key).isEmpty())throw new IllegalArgumentException("ابتدا لینک اشتراک را وارد و «دریافت اشتراک» را بزنید");
        if(!text(key).matches("[A-Fa-f0-9]{64}")){key.setError("کلید ۶۴ کاراکتری هگز");throw new IllegalArgumentException("کلید نامعتبر است");}
        Intent i=new Intent(this,KankiService.class).putExtra("server",text(server)).putExtra("key",text(key))
            .putExtra("serverPort",number(port,1,65535))
            .putExtra("repeat",repeat.getProgress()+3).putExtra("fecK",number(fecK,2,16)).putExtra("jitter",number(jitter,0,100000))
            .putExtra("fec",fec.isChecked()).putExtra("autotune",autotune.isChecked()).putExtra("mode",modeName());
        if(!KankiTunConfig.clientIp(text(ip))){ip.setError("آدرس اختصاص‌یافته توسط پنل");throw new IllegalArgumentException("IP تونل نامعتبر است");}
        if(!ipv4(text(dns)))throw new IllegalArgumentException("DNS باید IPv4 باشد");
        i.putExtra("ip",text(ip)).putExtra("dns",text(dns)).putExtra("mtu",number(mtu,576,1400));
        if(mode==1&&packages.isEmpty())throw new IllegalArgumentException("حداقل یک بازی انتخاب کنید");
        i.putStringArrayListExtra("packages",packages);
        return i;
    }
    private boolean ipv4(String s){String[] p=s.split("\\.",-1);if(p.length!=4)return false;for(String n:p)try{if(!n.matches("[0-9]{1,3}")||Integer.parseInt(n)>255)return false;}catch(Exception e){return false;}return true;}
    private void toggle(){
        if(KankiNative.nativeRunning()||KankiService.isActive()) {startService(new Intent(this,KankiService.class).setAction("STOP"));return;}
        try{options();Intent consent=VpnService.prepare(this);if(consent!=null)startActivityForResult(consent,VPN_REQUEST);else start();}
        catch(Exception e){status.setText(e.getMessage());}
    }
    private void start(){try{prefs().edit().remove("error").apply();startForegroundService(options());status.setText("در حال برقراری اتصال…");}catch(Exception e){status.setText(e.getMessage());}}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==VPN_REQUEST){if(result==RESULT_OK)start();else status.setText("مجوز VPN داده نشد");}}
    private void updateGames(){gamesLabel.setText(packages.size()+" برنامه انتخاب شده · Google Play به‌صورت خودکار اضافه می‌شود");}
    private void chooseGames(){
        Intent launch=new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps=getPackageManager().queryIntentActivities(launch,0);
        TreeMap<String,String> unique=new TreeMap<>();
        for(ResolveInfo a:apps)if(!a.activityInfo.packageName.equals(getPackageName()))unique.put(a.activityInfo.packageName,a.loadLabel(getPackageManager()).toString());
        List<String> ids=new ArrayList<>(unique.keySet());ids.sort(Comparator.comparing(unique::get));
        String[] labels=new String[ids.size()];boolean[] checked=new boolean[ids.size()];
        for(int n=0;n<ids.size();n++){labels[n]=unique.get(ids.get(n));checked[n]=packages.contains(ids.get(n));}
        new AlertDialog.Builder(this).setTitle("بازی‌ها و برنامه‌های ورود حساب")
            .setMultiChoiceItems(labels,checked,(dialog,index,value)->checked[index]=value)
            .setPositiveButton("ذخیره",(dialog,which)->{packages.clear();for(int n=0;n<ids.size();n++)if(checked[n])packages.add(ids.get(n));
                prefs().edit().putStringSet("packages",new HashSet<>(packages)).apply();updateGames();})
            .setNegativeButton("انصراف",null).show();
    }
    /** quiet: refresh at startup and re-apply the last chosen profile without asking. */
    private void importSubscription(boolean quiet){
        final String value=text(subscription);importButton.setEnabled(false);if(!quiet)status.setText("دریافت امن اشتراک…");
        io.execute(()->{
            try{
                URL url=new URL(value);if(!url.getProtocol().equals("https")||url.getUserInfo()!=null)throw new IOException("لینک اشتراک باید HTTPS باشد");
                HttpURLConnection c=(HttpURLConnection)url.openConnection();c.setConnectTimeout(10000);c.setReadTimeout(10000);c.setInstanceFollowRedirects(false);
                String body;
                try{
                    if(c.getResponseCode()!=200)throw new IOException("اشتراک در دسترس نیست: "+c.getResponseCode());
                    try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                        byte[] buf=new byte[4096];int n;while((n=in.read(buf))!=-1){if(out.size()+n>262144)throw new IOException("اشتراک بیش از حد بزرگ است");out.write(buf,0,n);}body=out.toString("UTF-8");
                    }
                }finally{c.disconnect();}
                JSONObject root=new JSONObject(body);
                if(root.getInt("version")!=1||!root.getString("protocol").equals("kanki"))throw new IOException("فرمت اشتراک KANKI نامعتبر است");
                JSONArray profiles=root.has("profiles")?root.getJSONArray("profiles"):new JSONArray().put(root);
                if(profiles.length()<1||profiles.length()>128)throw new IOException("تعداد پروفایل‌ها نامعتبر است");
                String[] names=new String[profiles.length()];for(int n=0;n<names.length;n++)names[n]=profiles.getJSONObject(n).getString("name");
                handler.post(()->{if(isFinishing()||isDestroyed())return;importButton.setEnabled(true);
                    int last=prefs().getInt("profile",-1);
                    if(quiet&&last>=0&&last<names.length){choose(profiles,names,last,value);return;}
                    if(names.length==1){choose(profiles,names,0,value);return;}
                    new AlertDialog.Builder(this).setTitle("پروفایل اختصاصی این دستگاه را انتخاب کنید")
                        .setItems(names,(dialog,index)->choose(profiles,names,index,value)).show();});
            }catch(Exception e){handler.post(()->{if(!isDestroyed()){importButton.setEnabled(true);if(!quiet)status.setText(e.getMessage());}});}
        });
    }
    private void choose(JSONArray profiles,String[] names,int index,String link){
        try{applyProfile(profiles.getJSONObject(index));profileName=names[index];
            prefs().edit().putString("subscription",link).putInt("profile",index).apply();
            if(!KankiService.isActive())status.setText("آماده اتصال");}
        catch(Exception e){status.setText("پروفایل نامعتبر: "+e.getMessage());}
    }
    private int profileInt(JSONObject p,String name,int fallback,int lo,int hi)throws JSONException{
        Object value=p.opt(name);if(value!=null&&!(value instanceof Integer)&&!(value instanceof Long))throw new JSONException(name+" must be integer");
        int n=p.optInt(name,fallback);if(n<lo||n>hi)throw new JSONException("Invalid "+name);return n;
    }
    private void applyProfile(JSONObject p)throws Exception{
        String host=p.getString("server"),secret=p.getString("key"),address=p.getString("ip"),resolver=p.optString("dns","1.1.1.1");
        if(!host.matches("[A-Za-z0-9.-]{1,253}")||!secret.matches("[a-fA-F0-9]{64}")||!KankiTunConfig.clientIp(address)||!ipv4(resolver))throw new JSONException("Invalid address/key");
        int sp=profileInt(p,"port",4000,1,65535),rp=profileInt(p,"repeat",4,3,10),fk=profileInt(p,"fec_k",8,2,16),jt=profileInt(p,"jitter",0,0,100000),m=profileInt(p,"mtu",1280,576,1400);
        server.setText(host);port.setText(""+sp);key.setText(secret);ip.setText(address);dns.setText(resolver);mtu.setText(""+m);repeat.setProgress(rp-3);fecK.setText(""+fk);jitter.setText(""+jt);fec.setChecked(p.optBoolean("fec",true));autotune.setChecked(p.optBoolean("autotune",true));
    }

    private static String bytes(long n){String[] u={"B","KB","MB","GB","TB"};double v=n;int i=0;while(v>=1024&&i<4){v/=1024;i++;}return String.format(Locale.US,i==0?"%.0f %s":"%.1f %s",v,u[i]);}
    private static String pct(long pm){return String.format(Locale.US,"%.1f",pm/10.0);}
    private void color(TextView t,long value,long warn,long bad){t.setTextColor(value>=bad?0xFFF87171:value>=warn?0xFFFBBF24:0xFFFFFFFF);}

    private void renderEvents(){
        List<KankiEvents.Event> list=KankiEvents.list();
        int signature=list.isEmpty()?0:list.size()*31+list.get(0).text.hashCode()+list.get(0).time.hashCode();
        if(signature==shownEvents)return;shownEvents=signature;
        eventList.removeAllViews();
        if(list.isEmpty()){TextView t=new TextView(this);t.setText("هنوز رویدادی ثبت نشده است.");t.setTextColor(0xFF8C93B8);t.setTextSize(13);eventList.addView(t);return;}
        int max=Math.min(list.size(),25);
        for(int n=0;n<max;n++){
            KankiEvents.Event e=list.get(n);
            LinearLayout row=new LinearLayout(this);row.setOrientation(LinearLayout.HORIZONTAL);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(0,dp(7),0,dp(7));
            View dot=new View(this);dot.setBackgroundResource(R.drawable.dot);
            int c=e.level==KankiEvents.OK?0xFF34D399:e.level==KankiEvents.WARN?0xFFFBBF24:e.level==KankiEvents.BAD?0xFFF87171:0xFF9F8CFF;
            dot.getBackground().mutate().setTint(c);
            LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(dp(8),dp(8));lp.setMarginEnd(dp(10));row.addView(dot,lp);
            TextView msg=new TextView(this);msg.setText(e.text);msg.setTextColor(0xFFE6E9FF);msg.setTextSize(13);
            row.addView(msg,new LinearLayout.LayoutParams(0,LinearLayout.LayoutParams.WRAP_CONTENT,1));
            TextView time=new TextView(this);time.setText(e.time);time.setTextColor(0xFF6B7299);time.setTextSize(11);time.setTypeface(android.graphics.Typeface.MONOSPACE);
            row.addView(time);
            eventList.addView(row);
        }
    }
    private int dp(int v){return (int)TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,v,getResources().getDisplayMetrics());}

    private final Runnable refresh=new Runnable(){public void run(){if(!visible)return;
        long[] s=KankiNative.nativeStats();boolean active=KankiService.isActive();
        profileText.setText(profileName.isEmpty()?"ابتدا لینک اشتراک را وارد کنید":profileName);
        if(s!=null&&s.length>=14){
            boolean up=s[0]==2;
            long lossPm=Math.max(s[4],s[13]==1?s[7]:0);
            if(up){toggle.setState(lossPm>=150||s[1]>=180?ConnectButton.WARNING:ConnectButton.CONNECTED);status.setText(lossPm>=150?"متصل · مسیر پر از loss است":"متصل و پایدار");
                badge.setText("● آنلاین");badge.setBackgroundResource(R.drawable.chip_on);}
            else if(active){toggle.setState(ConnectButton.CONNECTING);status.setText(s[12]>1500?"قطعی مسیر · در حال تعویض مسیر…":"در حال اتصال…");
                badge.setText("◌ اتصال");badge.setBackgroundResource(R.drawable.chip_off);}
            else{toggle.setState(ConnectButton.IDLE);String err=prefs().getString("error","");status.setText(err.isEmpty()?"آماده اتصال":err);
                badge.setText("آفلاین");badge.setBackgroundResource(R.drawable.chip_off);}
            ping.setText(up?String.valueOf(s[1]):"—");color(ping,up?s[1]:0,120,180);
            loss.setText(active?pct(s[4])+" / "+(s[13]==1?pct(s[7]):"—"):"—");color(loss,active?lossPm:0,50,150);
            saved.setText(active?String.valueOf(s[6]+s[9]):"—");
            lost.setText(active?String.valueOf(s[5]+s[8]):"—");color(lost,active?s[5]+s[8]:0,1,50);
            hopsText.setText(active?String.valueOf(s[10]):"—");
            down.setText(bytes(s[2]));upText.setText(bytes(s[3]));repeatNow.setText(active?s[11]+"×":"—");
            long since=KankiService.connectedSince();
            if(active&&since>0){long t=(System.currentTimeMillis()-since)/1000;timer.setText(String.format(Locale.US,"%02d:%02d:%02d",t/3600,t/60%60,t%60));}
            else timer.setText("");
        }
        float[][] h=KankiEvents.history();chart.setData(h[0],h[1]);
        renderEvents();
        handler.postDelayed(this,1000);
    }};
    @Override protected void onResume(){super.onResume();visible=true;shownEvents=-1;handler.post(refresh);}
    @Override protected void onPause(){visible=false;handler.removeCallbacks(refresh);super.onPause();}
    @Override protected void onDestroy(){io.shutdownNow();handler.removeCallbacksAndMessages(null);super.onDestroy();}
}
