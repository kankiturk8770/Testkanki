"""Watch a physical veth: selected DNS/game test traffic must only appear encrypted."""
import json, pathlib, select, socket, struct, sys
interface,stem=sys.argv[1:]
stop=pathlib.Path(stem+'.stop');ready=pathlib.Path(stem+'.ready')
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(0x0800));s.bind((interface,0));s.setblocking(False)
ready.touch();frames=0;leaks=0
while not stop.exists():
    r,_,_=select.select([s],[],[],.1)
    if not r:continue
    data=s.recv(65535);frames+=1
    if len(data)<34 or data[12:14]!=b'\x08\x00':continue
    p=data[14:];ihl=(p[0]&15)*4
    if len(p)<ihl+4 or p[9] not in (6,17):continue
    src,dst=struct.unpack('!HH',p[ihl:ihl+4])
    if src in (53,18080,18081) or dst in (53,18080,18081):leaks+=1
s.close()
result={'underlay_frames_captured':frames,'plaintext_dns_or_test_payload_frames':leaks}
pathlib.Path(stem+'.json').write_text(json.dumps(result,indent=2))
assert frames>0,'No underlay frames captured';assert leaks==0,'Plaintext DNS/test traffic escaped tunnel'
print(json.dumps(result,indent=2))
