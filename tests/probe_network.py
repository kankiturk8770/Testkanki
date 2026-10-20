import json, os, socket, statistics, struct, time
host='203.0.113.2'
# TCP stream integrity includes multiple segments and MTU handling.
tcp_bytes=256*1024
data=os.urandom(tcp_bytes)
with socket.create_connection((host,18080),timeout=10) as s:
    s.sendall(data);result=bytearray()
    while len(result)<len(data):
        chunk=s.recv(65536)
        if not chunk:break
        result.extend(chunk)
    assert bytes(result)==data,'TCP corruption / truncation'
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
    s.settimeout(2)
    for n in (16,512,1200,2000):
        data=os.urandom(n);s.sendto(data,(host,18081));assert s.recv(4096)==data,'UDP payload / fragmentation failed'
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
    s.settimeout(3);request=b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x05kanki\x04test\x00\x00\x01\x00\x01'
    s.sendto(request,(host,53));answer=s.recv(4096);assert answer[:2]==b'\x12\x34' and answer[-4:]==socket.inet_aton(host),'DNS response failed'
samples=[]
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
    s.connect((host,18081));s.settimeout(.5)
    for i in range(100):
        payload=struct.pack('!I',i)+os.urandom(60);start=time.monotonic_ns();s.send(payload)
        deadline=time.monotonic()+.5
        while time.monotonic()<deadline:
            try:
                if s.recv(4096)==payload:samples.append((time.monotonic_ns()-start)/1e6);break
            except TimeoutError:break
        time.sleep(.01)
assert len(samples)>=95,f'Excess logical loss: {100-len(samples)}%'
print(json.dumps({'tcp_bytes':tcp_bytes,'udp_mtu_fragmentation':True,'dns':True,'samples':100,'loss_percent':100-len(samples),'rtt_median_ms':statistics.median(samples),'rtt_p95_ms':sorted(samples)[int(len(samples)*.95)-1],'jitter_mean_ms':statistics.mean(abs(a-b) for a,b in zip(samples,samples[1:]))},indent=2))
