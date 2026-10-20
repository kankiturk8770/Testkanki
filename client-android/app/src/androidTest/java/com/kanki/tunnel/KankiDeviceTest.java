package com.kanki.tunnel;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.*;
import org.junit.runner.RunWith;
import java.net.*;
import java.util.Arrays;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class KankiDeviceTest {
    private Activity activity;
    @Before public void foreground(){
        Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();
        activity=InstrumentationRegistry.getInstrumentation().startActivitySync(new Intent(c,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    @After public void close(){
        Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();
        c.startService(new Intent(c,KankiService.class).setAction("STOP"));
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.finish());
    }
    @Test public void tunnelAddressValidation(){
        assertTrue(KankiTunConfig.clientIp("10.66.0.2"));assertTrue(KankiTunConfig.clientIp("10.66.255.254"));
        for(String s:new String[]{"10.66.0.1","10.66.0.0","10.66.255.255","10.66.999.2","10.67.0.2","host", "10.66.2"})assertFalse(s,KankiTunConfig.clientIp(s));
    }
    @Test public void nativeRejectsInvalidInputsWithoutStarting(){
        KankiNative.nativeStop();
        assertEquals(-2,KankiNative.nativeStart(null,"127.0.0.1",4000,"bad",4,8,true,true,0,-1));
        assertFalse(KankiNative.nativeRunning());assertEquals(14,KankiNative.nativeStats().length);
    }
    @Test public void actualTunUdpDnsAndDisconnect() throws Exception {
        Bundle args=InstrumentationRegistry.getArguments();
        Assume.assumeTrue("Provide vpnHost, vpnKey, vpnIp, echoHost to run a real-server test",args.containsKey("vpnHost")&&args.containsKey("vpnKey")&&args.containsKey("vpnIp")&&args.containsKey("echoHost"));
        Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertNull("Grant VPN consent once in the app before running the device integration test",VpnService.prepare(c));
        Intent start=new Intent(c,KankiService.class).putExtra("server",args.getString("vpnHost"))
            .putExtra("serverPort",Integer.parseInt(args.getString("vpnPort","4000"))).putExtra("key",args.getString("vpnKey"))
            .putExtra("ip",args.getString("vpnIp")).putExtra("dns",args.getString("dns","1.1.1.1"))
            .putExtra("mode","full").putExtra("repeat",4).putExtra("fecK",8).putExtra("mtu",1280).putExtra("jitter",0).putExtra("fec",true).putExtra("autotune",true);
        c.startForegroundService(start);
        long deadline=SystemClock.elapsedRealtime()+20000;
        while(SystemClock.elapsedRealtime()<deadline&&KankiNative.nativeStats()[0]!=2)SystemClock.sleep(100);
        assertEquals("No authenticated server response",2,KankiNative.nativeStats()[0]);
        ConnectivityManager cm=c.getSystemService(ConnectivityManager.class);
        deadline=SystemClock.elapsedRealtime()+30000;
        boolean routed=false;
        while(SystemClock.elapsedRealtime()<deadline){
            Network active=cm.getActiveNetwork();NetworkCapabilities caps=cm.getNetworkCapabilities(active);
            if(caps!=null&&caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)){routed=true;break;}
            SystemClock.sleep(100);
        }
        assertTrue("Android has not activated VPN routes",routed);
        // ConnectivityService can announce the VPN before netd finishes UID routes.
        // Use fresh sockets on retries: a socket opened before that point can retain
        // the physical source address. Never replace this check with a fixed sleep.
        deadline=SystemClock.elapsedRealtime()+45000;boolean dataReady=false;
        while(SystemClock.elapsedRealtime()<deadline&&!dataReady){
            try(DatagramSocket probe=new DatagramSocket()){
                probe.setSoTimeout(1000);byte[] challenge=new byte[32];new java.security.SecureRandom().nextBytes(challenge);
                probe.send(new DatagramPacket(challenge,challenge.length,InetAddress.getByName(args.getString("echoHost")),Integer.parseInt(args.getString("echoPort","18081"))));
                DatagramPacket reply=new DatagramPacket(new byte[64],64);probe.receive(reply);
                dataReady=Arrays.equals(challenge,Arrays.copyOf(reply.getData(),reply.getLength()));
            }catch(SocketTimeoutException ignored){SystemClock.sleep(100);}
        }
        assertTrue("VPN data routes did not become usable",dataReady);
        try(DatagramSocket s=new DatagramSocket()){
            s.setSoTimeout(15000);
            for(int size:new int[]{64,1200}){
                byte[] data=new byte[size];Arrays.fill(data,(byte)42);
                System.out.println("KANKI probe before size="+size+" native="+Arrays.toString(KankiNative.nativeStats())+" active="+cm.getActiveNetwork());
                s.send(new DatagramPacket(data,data.length,InetAddress.getByName(args.getString("echoHost")),Integer.parseInt(args.getString("echoPort","18081"))));
                DatagramPacket answer=new DatagramPacket(new byte[2048],2048);
                try{s.receive(answer);}catch(SocketTimeoutException e){throw new AssertionError("UDP size="+size+" local="+s.getLocalAddress()+" native="+Arrays.toString(KankiNative.nativeStats()),e);}
                assertArrayEquals(data,Arrays.copyOf(answer.getData(),answer.getLength()));
            }
        }
        assertTrue(InetAddress.getAllByName(args.getString("dnsTestName","example.com")).length>0);
        assertTrue(KankiNative.nativeStats()[2]>0);assertTrue(KankiNative.nativeStats()[3]>0);
        c.startService(new Intent(c,KankiService.class).setAction("STOP"));
        deadline=SystemClock.elapsedRealtime()+5000;while(KankiService.isActive()&&SystemClock.elapsedRealtime()<deadline)SystemClock.sleep(50);
        assertFalse(KankiService.isActive());assertFalse(KankiNative.nativeRunning());
    }
}
