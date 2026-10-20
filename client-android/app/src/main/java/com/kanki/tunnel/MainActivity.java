package com.kanki.tunnel;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.VpnService;
import android.os.*;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends AppCompatActivity {
    private EditText server,port,key,fecK,jitter,ip,dns,mtu,subscription;
    private TextView status,repeatText,traffic,gamesLabel;
    private SeekBar repeat;
    private CheckBox fec,autotune;
    private Button toggle,importButton;
    private Spinner mode;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private ArrayList<String> packages=new ArrayList<>();
    private boolean visible;
    private static final int VPN_REQUEST=73;
    @Override public void onCreate(Bundle b){
        super.onCreate(b);setContentView(R.layout.activity_main);
        server=findViewById(R.id.etServer);port=findViewById(R.id.etPort);key=findViewById(R.id.etKey);
        fecK=findViewById(R.id.etFecK);jitter=findViewById(R.id.etJitter);ip=findViewById(R.id.etIp);dns=findViewById(R.id.etDns);mtu=findViewById(R.id.etMtu);
        subscription=findViewById(R.id.etSubscription);status=findViewById(R.id.tvStatus);repeatText=findViewById(R.id.tvRepeat);traffic=findViewById(R.id.tvTraffic);
        gamesLabel=findViewById(R.id.tvGames);repeat=findViewById(R.id.sbRepeat);fec=findViewById(R.id.cbFec);autotune=findViewById(R.id.cbAutotune);
        toggle=findViewById(R.id.btnToggle);importButton=findViewById(R.id.btnImport);mode=findViewById(R.id.mode);
        ArrayAdapter<String> modes=new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"Full VPN · تمام برنامه‌ها","Gaming Smart · بازی‌های انتخابی"});mode.setAdapter(modes);
        repeat.setMax(7);repeat.setProgress(1);repeatText.setText("Repeat · 4×");
        repeat.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar s,int n,boolean user){repeatText.setText("Repeat · "+(n+3)+"×");}public void onStartTrackingTouch(SeekBar s){}public void onStopTrackingTouch(SeekBar s){}});
        toggle.setOnClickListener(v->toggle());importButton.setOnClickListener(v->importSubscription());findViewById(R.id.btnGames).setOnClickListener(v->chooseGames());
        findViewById(R.id.btnAdvanced).setOnClickListener(v->{android.view.View a=findViewById(R.id.advanced);a.setVisibility(a.getVisibility()==android.view.View.VISIBLE?android.view.View.GONE:android.view.View.VISIBLE);});
        packages=new ArrayList<>(getSharedPreferences("kanki",MODE_PRIVATE).getStringSet("packages",new HashSet<>()));updateGames();
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},1);
    }
    private String text(EditText f){return f.getText().toString().trim();}
    private int number(EditText f,int min,int max){
        try{int n=Integer.parseInt(text(f));if(n>=min&&n<=max)return n;}catch(NumberFormatException ignored){}
        f.setError(min+" … "+max);throw new IllegalArgumentException("مقدار عددی نامعتبر است");
    }
    private String modeName(){return new String[]{"full","gaming"}[mode.getSelectedItemPosition()];}
    private Intent options(){
        if(text(server).isEmpty()||text(key).isEmpty())throw new IllegalArgumentException("ابتدا لینک اشتراک را وارد و «دریافت اشتراک» را بزنید");
        if(!text(key).matches("[A-Fa-f0-9]{64}")){key.setError("کلید ۶۴ کاراکتری هگز");throw new IllegalArgumentException("کلید نامعتبر است");}
        Intent i=new Intent(this,KankiService.class).putExtra("server",text(server)).putExtra("key",text(key))
            .putExtra("serverPort",number(port,1,65535))
            .putExtra("repeat",repeat.getProgress()+3).putExtra("fecK",number(fecK,2,16)).putExtra("jitter",number(jitter,0,100000))
            .putExtra("fec",fec.isChecked()).putExtra("autotune",autotune.isChecked()).putExtra("mode",modeName());
        {
            if(!KankiTunConfig.clientIp(text(ip))){ip.setError("آدرس اختصاص‌یافته توسط پنل");throw new IllegalArgumentException("IP تونل نامعتبر است");}
            if(!ipv4(text(dns)))throw new IllegalArgumentException("DNS باید IPv4 باشد");
            i.putExtra("ip",text(ip)).putExtra("dns",text(dns)).putExtra("mtu",number(mtu,576,1400));
            if(modeName().equals("gaming")&&packages.isEmpty())throw new IllegalArgumentException("حداقل یک بازی انتخاب کنید");
            i.putStringArrayListExtra("packages",packages);
        }return i;
    }
    private boolean ipv4(String s){String[] p=s.split("\\.",-1);if(p.length!=4)return false;for(String n:p)try{if(!n.matches("[0-9]{1,3}")||Integer.parseInt(n)>255)return false;}catch(Exception e){return false;}return true;}
    private void toggle(){
        if(KankiNative.nativeRunning()||KankiService.isActive()) {startService(new Intent(this,KankiService.class).setAction("STOP"));return;}
        try{options();Intent consent=VpnService.prepare(this);if(consent!=null)startActivityForResult(consent,VPN_REQUEST);else start();}
        catch(Exception e){status.setText(e.getMessage());}
    }
    private void start(){try{getSharedPreferences("kanki",MODE_PRIVATE).edit().remove("error").apply();startForegroundService(options());status.setText("در حال برقراری اتصال…");}catch(Exception e){status.setText(e.getMessage());}}
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
                getSharedPreferences("kanki",MODE_PRIVATE).edit().putStringSet("packages",new HashSet<>(packages)).apply();updateGames();})
            .setNegativeButton("انصراف",null).show();
    }
    private void importSubscription(){
        final String value=text(subscription);importButton.setEnabled(false);status.setText("دریافت امن اشتراک…");
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
                handler.post(()->{if(isFinishing()||isDestroyed())return;importButton.setEnabled(true);new AlertDialog.Builder(this).setTitle("پروفایل اختصاصی این دستگاه را انتخاب کنید")
                    .setItems(names,(dialog,index)->{try{applyProfile(profiles.getJSONObject(index));status.setText("اشتراک وارد شد؛ آماده اتصال");}catch(Exception e){status.setText("پروفایل نامعتبر: "+e.getMessage());}}).show();});
            }catch(Exception e){handler.post(()->{if(!isDestroyed()){importButton.setEnabled(true);status.setText(e.getMessage());}});}
        });
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
    private final Runnable refresh=new Runnable(){public void run(){if(!visible)return;long[] s=KankiNative.nativeStats();boolean active=KankiService.isActive();toggle.setText(active?"قطع اتصال":"اتصال امن");
        if(s!=null){if(s[0]==2)status.setText("● متصل · RTT سرور "+s[1]+" ms");else if(active)status.setText("◌ در حال اتصال / تلاش مجدد…");else {String err=getSharedPreferences("kanki",MODE_PRIVATE).getString("error","");status.setText(err.isEmpty()?"○ آماده اتصال":err);}traffic.setText(String.format(Locale.US,"↓ %.2f MiB     ↑ %.2f MiB",s[2]/1048576.0,s[3]/1048576.0));}
        handler.postDelayed(this,1000);
    }};
    @Override protected void onResume(){super.onResume();visible=true;handler.post(refresh);}
    @Override protected void onPause(){visible=false;handler.removeCallbacks(refresh);super.onPause();}
    @Override protected void onDestroy(){io.shutdownNow();handler.removeCallbacksAndMessages(null);super.onDestroy();}
}
