package com.kanki.tunnel;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import android.content.pm.PackageManager;
import java.util.ArrayList;
import java.util.LinkedHashSet;

public final class KankiTunConfig {
    private KankiTunConfig() {}
    static boolean clientIp(String ip) {
        if(ip==null)return false;
        String[] p=ip.split("\\.",-1);if(p.length!=4)return false;
        try {int a=Integer.parseInt(p[2]),b=Integer.parseInt(p[3]);
            return p[0].equals("10")&&p[1].equals("66")&&a>=0&&a<=255&&b>=0&&b<=255&&
                !(a==0&&b<=1)&&!(a==255&&b==255);
        }catch(NumberFormatException e){return false;}
    }
    public static ParcelFileDescriptor establish(VpnService service,String ip,String dns,int mtu,
                                                   boolean gaming,ArrayList<String> packages) throws PackageManager.NameNotFoundException {
        if(!clientIp(ip)||dns==null||!dns.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")||mtu<576||mtu>1400)
            throw new IllegalArgumentException("Invalid IPv4 / MTU configuration");
        VpnService.Builder b=service.new Builder().setSession(gaming?"KANKI Gaming Smart":"KANKI Full VPN")
            .setMtu(mtu).addAddress(ip,32).addDnsServer(dns).addRoute("0.0.0.0",0);
        // Capture IPv6 and drop it in the IPv4 core: no bypass through the physical network.
        b.addAddress("fd66:6b61:6e6b::2",128).addRoute("::",0);
        if(gaming) {
            if(packages==null||packages.isEmpty())throw new IllegalArgumentException("Select at least one game");
            LinkedHashSet<String> allowed=new LinkedHashSet<>(packages);
            allowed.add("com.google.android.gms");allowed.add("com.android.vending");allowed.add("com.google.android.gsf");
            for(String pkg:allowed)try {b.addAllowedApplication(pkg);}catch(PackageManager.NameNotFoundException e){
                if(packages.contains(pkg))throw e;
            }
        }
        ParcelFileDescriptor tun=b.establish();if(tun==null)throw new IllegalStateException("VPN permission unavailable");return tun;
    }
}
