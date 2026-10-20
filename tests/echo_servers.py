"""Private-namespace test fixture, never deployed as part of KANKI."""
import socket, struct, threading

def udp():
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('0.0.0.0',18081))
    while True:
        data,peer=s.recvfrom(65535);s.sendto(data,peer)
def tcp():
    s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',18080));s.listen()
    def echo(c):
        with c:
            while data:=c.recv(65535):c.sendall(data)
    while True:
        c,_=s.accept();threading.Thread(target=echo,args=(c,),daemon=True).start()
def dns():
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('0.0.0.0',53))
    while True:
        data,peer=s.recvfrom(4096)
        if len(data)<12:continue
        answer=data[:2]+b'\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00'+data[12:]+b'\xc0\x0c\x00\x01\x00\x01'+struct.pack('!IH',30,4)+socket.inet_aton('203.0.113.2')
        s.sendto(answer,peer)
for task in (udp,dns):threading.Thread(target=task,daemon=True).start()
tcp()
