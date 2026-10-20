"""Deterministic UDP impairment fixture: 10% wire loss, 20±5ms delay each way."""
import heapq, random, select, socket, time
rng=random.Random(42)
listen=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);listen.bind(('0.0.0.0',4001))
upstream=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);upstream.connect(('127.0.0.1',4000))
for s in (listen,upstream):
    s.setblocking(False);s.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4<<20)
queue=[];peer=None;sequence=0
while True:
    now=time.monotonic()
    while queue and queue[0][0]<=now:
        _,_,kind,data,dest=heapq.heappop(queue)
        try:
            if kind=='up':upstream.send(data)
            elif dest:listen.sendto(data,dest)
        except (BlockingIOError,ConnectionRefusedError):pass
    timeout=max(0,queue[0][0]-time.monotonic()) if queue else .1
    readable,_,_=select.select([listen,upstream],[],[],timeout)
    for s in readable:
        for _ in range(256):
            try:data,source=s.recvfrom(65535)
            except BlockingIOError:break
            except ConnectionRefusedError:break
            if s is listen:peer=source;kind='up';dest=None
            else:kind='down';dest=peer
            if rng.random()<.10:continue
            sequence+=1;heapq.heappush(queue,(time.monotonic()+.020+rng.uniform(-.005,.005),sequence,kind,data,dest))
