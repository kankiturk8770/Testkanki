'use strict';
let token='',users=[],servers=[],nodes=[],cluster=false,selected=null,busy=false,live={sessions:[],system:{}},range=1,logOldest=null,detail=null;
const $=id=>document.getElementById(id);
const FA=new Intl.NumberFormat('fa-IR');
const fmt=n=>{n=Number(n)||0;let i=0;while(n>=1024&&i<4){n/=1024;i++}return `${n.toFixed(i?1:0)} ${['B','KB','MB','GB','TB'][i]}`};
const bps=n=>{n=Number(n)||0;const u=['bps','Kbps','Mbps','Gbps'];let i=0;while(n>=1000&&i<3){n/=1000;i++}return `${n.toFixed(i?1:0)} ${u[i]}`};
const pct=pm=>(Number(pm||0)/10).toFixed(1)+'%';
const dur=s=>{s=Math.max(0,Math.floor(s));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?`${d}روز ${h}س`:h?`${h}س ${m}د`:m?`${m}د ${s%60}ث`:`${s}ث`};
const ago=t=>dur(Date.now()/1000-t)+' پیش';
const when=t=>new Date(t*1000).toLocaleString('fa-IR',{hour:'2-digit',minute:'2-digit',second:'2-digit',month:'short',day:'numeric'});
const flag=cc=>cc&&cc.length===2?String.fromCodePoint(...[...cc.toUpperCase()].map(c=>127397+c.charCodeAt())):'🌐';
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined&&text!==null)n.textContent=text;if(cls)n.className=cls;return n}
function message(s){$('message').textContent=s||''}
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok){if(r.status===401)logout();throw Error(d.error||'خطای درخواست')}return d}

/* ---------- auth & navigation ---------- */
function logout(){token='';$('admin-token').value='';$('dashboard').hidden=true;$('login').hidden=false;document.body.classList.add('locked');users=[];servers=[];nodes=[];cluster=false;
  for(const id of ['user-rows','traffic-bars','server-cards','audit-list','live-rows','log-rows','recent-events','quality-list','detail-events'])$(id).replaceChildren();
  for(const id of ['edit-dialog','node-credential','device-dialog','detail-dialog'])if($(id).open)$(id).close();$('node-token').value=''}
$('logout').onclick=logout;
$('login-form').onsubmit=async e=>{e.preventDefault();token=$('admin-token').value.trim();try{await load();$('admin-token').value='';$('login').hidden=true;$('dashboard').hidden=false;document.body.classList.remove('locked');message('');refreshLive();loadLogs(true)}catch(x){token='';message(x.message)}};
const TITLES={overview:['داشبورد','OVERVIEW'],live:['اتصال‌های زنده','LIVE SESSIONS'],users:['کاربران و اشتراک‌ها','USERS'],logs:['لاگ اتصال‌ها','CONNECTION LOG'],servers:['پورت‌ها و پروفایل‌ها','PORTS & PROFILES'],audit:['تاریخچهٔ مدیریت','AUDIT']};
function showTab(name){for(const t of document.querySelectorAll('.tab'))t.hidden=t.id!==name;for(const n of document.querySelectorAll('[data-tab]'))n.classList.toggle('selected',n.dataset.tab===name);
  $('page-title').textContent=TITLES[name][0];$('page-eyebrow').textContent='KANKI / '+TITLES[name][1];if(name==='logs')loadLogs(true);if(name==='live'||name==='overview')refreshLive()}
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>showTab(b.dataset.tab);
for(const b of document.querySelectorAll('[data-goto]'))b.onclick=()=>showTab(b.dataset.goto);
const currentTab=()=>{const t=[...document.querySelectorAll('.tab')].find(x=>!x.hidden);return t?t.id:'overview'};

/* ---------- charts ---------- */
function drawChart(canvas,series,opts={}){
  const wrap=canvas.parentElement,dpr=window.devicePixelRatio||1,w=wrap.clientWidth,h=wrap.clientHeight;if(!w||!h)return;
  canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);
  const pad={l:44,r:opts.right?44:12,t:12,b:24},xs=series[0]?series[0].points.map(p=>p[0]):[];
  if(xs.length<2){c.fillStyle='#6b7299';c.font='13px sans-serif';c.textAlign='center';c.fillText('هنوز داده‌ای برای نمایش نیست',w/2,h/2);canvas.onmousemove=null;return}
  const x0=xs[0],x1=xs[xs.length-1],X=t=>pad.l+(t-x0)/(x1-x0||1)*(w-pad.l-pad.r);
  const axis=s=>{const m=Math.max(1e-9,...s.points.map(p=>p[1]||0));return m*1.15};
  const left=series.filter(s=>!s.right),right=series.filter(s=>s.right);
  const maxL=Math.max(...left.map(axis),opts.minLeft||0),maxR=right.length?Math.max(...right.map(axis),opts.minRight||0):1;
  const Y=(v,r)=>h-pad.b-(v/(r?maxR:maxL))*(h-pad.t-pad.b);
  c.strokeStyle='rgba(255,255,255,.07)';c.fillStyle='#6b7299';c.font='11px sans-serif';c.lineWidth=1;
  for(let i=0;i<=3;i++){const y=pad.t+(h-pad.t-pad.b)*i/3;c.beginPath();c.moveTo(pad.l,y);c.lineTo(w-pad.r,y);c.stroke();c.textAlign='left';c.fillText((opts.fmtL||String)(maxL*(1-i/3)),4,y+4);if(right.length){c.textAlign='right';c.fillText((opts.fmtR||String)(maxR*(1-i/3)),w-4,y+4)}}
  c.textAlign='center';for(let i=0;i<=4;i++){const t=x0+(x1-x0)*i/4;c.fillText(new Date(t*1000).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}),X(t),h-6)}
  for(const s of series){
    if(s.bars){c.fillStyle=s.color;const bw=Math.max(2,(w-pad.l-pad.r)/s.points.length*.6);for(const [t,v] of s.points)if(v>0){const y=Y(v,s.right);c.fillRect(X(t)-bw/2,y,bw,h-pad.b-y)}continue}
    const g=c.createLinearGradient(pad.l,0,w-pad.r,0);g.addColorStop(0,s.color);g.addColorStop(1,s.color2||s.color);
    c.beginPath();let started=false;for(const [t,v] of s.points){if(v===null||v===undefined||v<0){started=false;continue}const x=X(t),y=Y(v,s.right);if(!started){c.moveTo(x,y);started=true}else c.lineTo(x,y)}
    c.strokeStyle=g;c.lineWidth=2.2;c.lineJoin='round';c.stroke();
    if(s.fill){c.lineTo(X(s.points[s.points.length-1][0]),h-pad.b);c.lineTo(X(s.points[0][0]),h-pad.b);c.closePath();const f=c.createLinearGradient(0,pad.t,0,h-pad.b);f.addColorStop(0,s.fill);f.addColorStop(1,'rgba(0,0,0,0)');c.fillStyle=f;c.fill()}
  }
  const tip=wrap.querySelector('.chart-tip');
  canvas.onmousemove=e=>{const r=canvas.getBoundingClientRect(),mx=e.clientX-r.left;let best=0;for(let i=0;i<xs.length;i++)if(Math.abs(X(xs[i])-mx)<Math.abs(X(xs[best])-mx))best=i;
    tip.style.display='block';tip.textContent=new Date(xs[best]*1000).toLocaleTimeString('fa-IR')+'  ·  '+series.map(s=>`${s.label}: ${(s.fmt||String)(s.points[best]?s.points[best][1]:0)}`).join('  ·  ');
    tip.style.left=Math.min(w-tip.offsetWidth-4,Math.max(4,mx-tip.offsetWidth/2))+'px';tip.style.top='4px'};
  canvas.onmouseleave=()=>{tip.style.display='none'};
}
async function drawTraffic(){
  if(!token||cluster)return;const rows=await api('/api/history?hours='+range);
  drawChart($('traffic-chart'),[
    {label:'↓',points:rows.map(r=>[r.ts,(r.down_bps||0)/1e6]),color:'#8b6cff',color2:'#22d3ee',fill:'rgba(139,108,255,.35)',fmt:v=>v.toFixed(2)+' Mbps'},
    {label:'↑',points:rows.map(r=>[r.ts,(r.up_bps||0)/1e6]),color:'#f472b6',fmt:v=>v.toFixed(2)+' Mbps'},
    {label:'دستگاه',points:rows.map(r=>[r.ts,r.sessions||0]),color:'#34d399',right:true,fmt:v=>String(Math.round(v))}],
    {right:true,fmtL:v=>v.toFixed(1),fmtR:v=>String(Math.round(v)),minRight:3,minLeft:.1});
}
for(const b of $('range-seg').querySelectorAll('button'))b.onclick=()=>{for(const x of $('range-seg').querySelectorAll('button'))x.classList.toggle('on',x===b);range=Number(b.dataset.h);drawTraffic().catch(()=>{})};

/* ---------- events ---------- */
const EV={connect:['اتصال','#34d399'],roam:['تغییر پورت / مسیر','#22d3ee'],disconnect:['قطع توسط کاربر','#9aa1c7'],idle:['بی‌فعالیت','#6b7299'],quality:['افت کیفیت','#fbbf24'],quota:['اتمام حجم','#f87171'],expired:['منقضی / غیرفعال','#f87171'],allowed:['مجاز شد','#34d399']};
const place=g=>g&&(g.cc||g.org)?`${flag(g.cc)} ${g.cc||''} ${g.org?'· '+g.org.replace(/^AS\d+ /,''):''}`:'';
function eventText(e){const f=e.fields||{};
  switch(e.type){
    case 'connect':return [`اتصال از ${f.from||''}`,`${place(f.from_geo)}${f.port?' · پورت سرور '+f.port:''}`];
    case 'roam':return [`پورت گوشی عوض شد: ${f.from||''} ← ${f.to||''}`,`${place(f.to_geo)} · اپراتور یا شبکهٔ کاربر مسیر را عوض کرد و هسته فوراً به مسیر جدید رفت${f.silent?' · '+f.silent.replace('s',' ثانیه')+' بدون بسته':''}`];
    case 'quality':return [`Loss مسیر: ارسال ${f.up_loss||'-'} · دریافت ${f.down_loss||'-'} — از دست رفته: ارسال ${f.up_lost||0} · دریافت ${f.down_lost||0}`,`نجات با FEC: ارسال ${f.up_fec||0} · دریافت ${f.down_fec||0} · پینگ ${f.rtt||'-'} ms · Repeat ${f.repeat||'-'}`];
    case 'disconnect':return ['کاربر اتصال را قطع کرد',''];
    case 'idle':return ['۵ دقیقه بدون ترافیک؛ جلسه بسته شد',''];
    case 'quota':return ['حجم اشتراک تمام شد؛ ترافیک متوقف شد',''];
    case 'expired':return [f.reason==='disabled'?'اشتراک غیرفعال شد':'اشتراک منقضی شد',''];
    case 'allowed':return ['ترافیک دوباره مجاز شد',''];
    default:return [e.type+' '+e.detail,''];}}
function eventRow(e,withUser=true){const [label,color]=EV[e.type]||[e.type,'#8b6cff'];const [main,sub]=eventText(e);
  const row=node('div',undefined,'event'),dot=node('span',undefined,'ev-dot');dot.style.background=color;dot.style.color=color;
  const body=node('div',undefined,'ev-body'),title=node('b');const tag=node('span',label,'badge idle');tag.style.color=color;
  title.append(tag);if(withUser)title.append(node('span',e.device,'badge violet ltr dev'));body.append(title,node('p',main,'ev-main'));if(sub)body.append(node('div',sub));
  row.append(dot,body,node('time',when(e.at)));return row}
async function loadLogs(reset){
  if(!token)return;if(reset){logOldest=null;$('log-rows').replaceChildren()}
  const q=new URLSearchParams({limit:'150'});if($('log-type').value)q.set('type',$('log-type').value);if($('log-account').value)q.set('account',$('log-account').value);
  if($('log-search').value.trim())q.set('q',$('log-search').value.trim());if(logOldest)q.set('before',logOldest);
  const rows=await api('/api/events?'+q);
  for(const e of rows)$('log-rows').append(eventRow(e));
  if(rows.length)logOldest=rows[rows.length-1].at;
  if(!$('log-rows').children.length)$('log-rows').append(node('p','رویدادی پیدا نشد.','empty'));
  $('log-more').hidden=rows.length<150}
$('log-refresh').onclick=()=>loadLogs(true).catch(e=>message(e.message));$('log-more').onclick=()=>loadLogs(false).catch(e=>message(e.message));
for(const id of ['log-type','log-account'])$(id).onchange=()=>loadLogs(true).catch(e=>message(e.message));
let searchTimer;$('log-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadLogs(true).catch(e=>message(e.message)),350)};

/* ---------- live sessions ---------- */
const sev=(v,warn,bad)=>v>=bad?'bad':v>=warn?'warn':'good';
async function refreshLive(){
  if(!token)return;
  live=await api('/api/live');
  const on=live.sessions.filter(s=>s.connected);$('live-count').textContent=FA.format(on.length);
  $('online-users').textContent=on.length;$('online-sub').textContent=cluster?'در حالت چندسرور، آمار هر نود جداست':`${live.sessions.length-on.length} دستگاه اخیراً قطع شده`;
  $('rate-now').textContent=`${bps(on.reduce((a,s)=>a+(s.down_bps||0),0))} / ${bps(on.reduce((a,s)=>a+(s.up_bps||0),0))}`;
  renderHost(live.system);renderQuality(on);renderLive();
  if(detail&&detail.device&&$('detail-dialog').open)renderDetailKv();
}
function renderLive(){
  const q=$('live-search').value.trim().toLowerCase();$('live-rows').replaceChildren();
  const rows=live.sessions.filter(s=>!q||[s.name,s.account,s.endpoint,s.geo&&s.geo.org,s.geo&&s.geo.cc].join(' ').toLowerCase().includes(q));
  for(const s of rows){
    const tr=node('tr',undefined,'clickable');tr.onclick=()=>openDevice(s.name);
    const who=node('td',undefined,'who');who.append(node('b',s.account),node('small',s.name+' · '+s.ip));
    const geo=node('td');const g=node('div',undefined,'geo');const gi=node('div');gi.append(node('span',s.geo&&s.geo.cc?s.geo.cc:'—'),node('small',s.geo&&s.geo.org?s.geo.org.replace(/^AS\d+ /,''):(live.geo_ready?'':'در حال آماده‌سازی')));g.append(node('span',flag(s.geo&&s.geo.cc),'flag'),gi);geo.append(g);
    const st=node('td');st.append(node('span',s.connected?'● متصل':'قطع',s.connected?'badge':'badge idle'));
    const ep=node('td',s.endpoint||'—','ltr mono');
    const since=node('td',s.connected&&s.since?dur(Date.now()/1000-s.since):(s.last_rx?ago(s.last_rx):'—'));
    const rate=node('td',s.connected?`${bps(s.down_bps)} / ${bps(s.up_bps)}`:'—','ltr');
    const rtt=node('td',s.rtt>=0?s.rtt+' ms':'—','ltr '+(s.rtt>=0?sev(s.rtt,120,200):'dim'));
    const loss=node('td',`${pct(s.down_loss_pm)} / ${pct(s.up_loss_pm)}`,'ltr '+sev(Math.max(s.down_loss_pm||0,s.up_loss_pm||0),50,150));
    const lostN=(s.up_lost_total||0)+(s.down_lost_total||0),fl=node('td');
    fl.append(node('span',FA.format((s.up_fec_total||0)+(s.down_fec_total||0)),'good'),node('span',' / ','dim'),node('span',FA.format(lostN),sev(lostN,1,50)));
    const roams=node('td',FA.format((s.roams||0)),(s.roams||0)>5?'warn':'');
    who.prepend(st.firstChild);tr.append(who,geo,ep,since,rate,rtt,loss,fl,roams);$('live-rows').append(tr)}
  if(!rows.length){const tr=node('tr'),td=node('td',live.engine_online?'هیچ دستگاهی متصل نیست.':'هسته پاسخ نمی‌دهد یا در حالت چندسرور هستید.','empty');td.colSpan=9;tr.append(td);$('live-rows').append(tr)}
  $('geo-note').textContent=live.geo_ready?'':'پایگاه موقعیت IP در حال دانلود است (اولین اجرا).';
}
$('live-search').oninput=renderLive;
function renderQuality(on){
  const box=$('quality-list');box.replaceChildren();
  if(!on.length){box.append(node('p','هیچ دستگاهی متصل نیست.','empty'));return}
  for(const s of on.slice().sort((a,b)=>Math.max(b.down_loss_pm||0,b.up_loss_pm||0)-Math.max(a.down_loss_pm||0,a.up_loss_pm||0)).slice(0,6)){
    const row=node('div',undefined,'bar-row');const worst=Math.max(s.down_loss_pm||0,s.up_loss_pm||0);
    const m=node('div',undefined,'meter'+(worst>=150?' warn':'')),fill=node('span');fill.style.width=Math.min(100,worst/3)+'%';m.append(fill);
    row.append(node('span',s.name,'ltr'),m,node('span',`${pct(worst)} · ${s.rtt>=0?s.rtt+'ms':'—'}`,'ltr '+sev(worst,50,150)));box.append(row)}
  box.parentElement.querySelector('.sub').textContent='بدترین Loss هر دستگاه (↓ یا ↑) و پینگ؛ FEC و Repeat بخش زیادی از Loss را جبران می‌کنند';
}
function renderHost(s){
  if(!s)return;const bars=$('host-bars');bars.replaceChildren();
  const add=(label,value,total,text)=>{const row=node('div',undefined,'bar-row'),m=node('div',undefined,'meter'+(value/total>.85?' warn':'')),f=node('span');f.style.width=Math.min(100,value/total*100)+'%';m.append(f);row.append(node('span',label),m,node('span',text,'ltr'));bars.append(row)};
  if(s.cpu!==undefined)add('پردازنده',s.cpu,100,s.cpu+'%');
  if(s.mem_total)add('حافظه',s.mem_used,s.mem_total,fmt(s.mem_used));
  if(s.disk_total)add('دیسک',s.disk_used,s.disk_total,fmt(s.disk_used));
  const kv=$('host-kv');kv.replaceChildren();
  const item=(k,v)=>{const d=node('div');d.append(node('small',k),node('b',v));kv.append(d)};
  item('شبکهٔ سرور ↓',bps(s.net_rx_bps));item('شبکهٔ سرور ↑',bps(s.net_tx_bps));item('بار (۱ دقیقه)',s.load?s.load[0].toFixed(2)+' / '+s.cores:'—');item('روشن از',s.uptime?dur(s.uptime):'—');
  $('host-sub').textContent=s.wan?`کارت شبکه ${s.wan} · ${s.cores||1} هسته`:'—';$('side-uptime').textContent=s.uptime?'سرور روشن: '+dur(s.uptime):'';
}

/* ---------- detail dialog ---------- */
function renderDetailKv(){
  const s=live.sessions.find(x=>x.name===detail.device);const kv=$('detail-kv');kv.replaceChildren();
  const item=(k,v,cls)=>{const d=node('div',undefined,cls&&cls.includes('wide')?'wide':'');d.append(node('small',k),node('b',v,cls||''));kv.append(d)};
  if(!s){item('وضعیت','اطلاعات زنده‌ای نیست');return}
  item('وضعیت',s.connected?'متصل':'قطع',s.connected?'good':'muted');item('موقعیت و اپراتور',place(s.geo)||'—','wide small-text');item('IP:پورت گوشی',s.endpoint||'—');
  item('مدت اتصال',s.connected&&s.since?dur(Date.now()/1000-s.since):'—');item('پینگ تا سرور',s.rtt>=0?s.rtt+' ms':'—');
  item('Loss مسیر ↓ / ↑',`${pct(s.down_loss_pm)} / ${pct(s.up_loss_pm)}`);item('از دست رفته ↓ / ↑',`${s.down_lost_total||0} / ${s.up_lost_total||0}`);
  item('نجات با FEC ↓ / ↑',`${s.down_fec_total||0} / ${s.up_fec_total||0}`);item('تغییر پورت توسط شبکه',String(s.roams||0));item('تعویض مسیر توسط اپ',String(s.hops||0));
  item('مصرف ↓ / ↑',`${fmt(s.rx_bytes)} / ${fmt(s.tx_bytes)}`);item('Repeat',(s.repeat||'—')+'×');
}
async function drawDetail(hours){
  if(!detail||!detail.device)return;const rows=await api(`/api/quality?device=${encodeURIComponent(detail.device)}&hours=${hours}`);
  drawChart($('detail-chart'),[
    {label:'پینگ',points:rows.map(r=>[r.ts,r.rtt>=0?r.rtt:null]),color:'#8b6cff',color2:'#22d3ee',fill:'rgba(139,108,255,.3)',fmt:v=>v===null?'—':Math.round(v)+' ms'},
    {label:'Loss',points:rows.map(r=>[r.ts,Math.max(r.up_loss_pm||0,r.down_loss_pm||0)/10]),color:'rgba(248,113,113,.75)',bars:true,right:true,fmt:v=>v.toFixed(1)+'%'}],
    {right:true,fmtL:v=>Math.round(v)+'ms',fmtR:v=>v.toFixed(0)+'%',minLeft:50,minRight:5});
}
async function openDevice(name){
  detail={device:name};$('detail-title').textContent=name;renderDetailKv();$('detail-dialog').showModal();
  for(const x of $('detail-seg').querySelectorAll('button'))x.classList.toggle('on',x.dataset.h==='1');
  await drawDetail(1).catch(()=>{});
  const ev=await api('/api/events?limit=60&device='+encodeURIComponent(name));$('detail-events').replaceChildren(...(ev.length?ev.map(e=>eventRow(e,false)):[node('p','رویدادی ثبت نشده است.','empty')]));
}
async function openAccount(u){
  detail={account:u.name};$('detail-title').textContent=u.name;const kv=$('detail-kv');kv.replaceChildren();
  const item=(k,v)=>{const d=node('div');d.append(node('small',k),node('b',v));kv.append(d)};
  item('وضعیت',u.active?'فعال':'غیرفعال');item('مصرف',fmt(u.usage.rx+u.usage.tx));item('حجم',u.quota_bytes?fmt(u.quota_bytes):'نامحدود');item('انقضا',u.expires||'بدون انقضا');item('دستگاه متصل',`${u.connected} / ${u.connections}`);
  const devs=live.sessions.filter(s=>s.account===u.name);for(const s of devs)item(s.name,s.connected?`متصل · ${place(s.geo)||s.endpoint}`:'قطع');
  $('detail-chart').getContext('2d').clearRect(0,0,9999,9999);$('detail-dialog').showModal();
  const first=devs[0];if(first){detail.device=first.name;await drawDetail(1).catch(()=>{})}
  const ev=await api('/api/events?limit=80&account='+encodeURIComponent(u.name));$('detail-events').replaceChildren(...(ev.length?ev.map(e=>eventRow(e)):[node('p','رویدادی ثبت نشده است.','empty')]));
}
$('close-detail').onclick=()=>$('detail-dialog').close();
for(const b of $('detail-seg').querySelectorAll('button'))b.onclick=()=>{for(const x of $('detail-seg').querySelectorAll('button'))x.classList.toggle('on',x===b);drawDetail(Number(b.dataset.h)).catch(()=>{})};

/* ---------- main load ---------- */
async function load(){if(busy||!token)return;busy=true;try{
  const [u,s,status,events]=await Promise.all([api('/api/users'),api('/api/servers'),api('/api/status'),api('/api/audit')]);if(!token)return;
  users=u;servers=s;cluster=status.mode==='cluster';nodes=cluster?await api('/api/nodes'):[];
  renderUsers();renderServers();
  $('server-heading').textContent=cluster?'نود جدید':'پروفایل اتصال جدید';
  $('server-help').textContent=cluster?'نود را بسازید، توکن یک‌بار نمایش داده می‌شود؛ سپس نصب‌کننده را روی سرور مقصد اجرا و دستگاه‌ها را تخصیص دهید.':'هر پروفایل یک پورت UDP روی هستهٔ همین سرور است و حدود دو ثانیه بعد فعال می‌شود. همان پورت در لینک اشتراک قرار می‌گیرد؛ آن را در فایروال سرور/دیتاسنتر باز کنید.';
  const onlineNow=cluster?nodes.some(x=>x.online):status.online;
  $('core-state').textContent=cluster?`${nodes.filter(x=>x.online).length} / ${nodes.length} نود آنلاین`:status.online?'هسته آنلاین':'هسته خارج از دسترس';
  $('engine-pill').className='pill '+(onlineNow?'on':'off');
  $('active-users').textContent=u.filter(x=>x.active).length;$('all-users').textContent=`از ${FA.format(u.length)} کاربر`;
  $('online-users').textContent=u.reduce((a,x)=>a+x.connected,0);
  $('total-traffic').textContent=fmt(u.reduce((a,x)=>a+x.usage.rx+x.usage.tx,0));
  $('updated').textContent='به‌روزرسانی '+new Date().toLocaleTimeString('fa-IR');
  const max=Math.max(1,...u.map(x=>x.usage.rx+x.usage.tx));$('traffic-bars').replaceChildren();
  for(const x of [...u].sort((a,b)=>(b.usage.rx+b.usage.tx)-(a.usage.rx+a.usage.tx)).slice(0,6)){const row=node('div',undefined,'bar-row'),m=node('div',undefined,'meter'),f=node('span');f.style.width=((x.usage.rx+x.usage.tx)/max*100)+'%';m.append(f);row.append(node('span',x.name,'ltr'),m,node('span',fmt(x.usage.rx+x.usage.tx),'ltr'));$('traffic-bars').append(row)}
  if(!u.length)$('traffic-bars').append(node('p','هنوز کاربری ایجاد نشده است.','empty'));
  $('audit-list').replaceChildren(...events.map(x=>{const n=node('div',undefined,'event');const d=node('span',undefined,'ev-dot');const b=node('div',undefined,'ev-body');b.append(node('b',x.action),node('div',x.target,'ltr'));n.append(d,b,node('time',when(x.at)));return n}));
  const sel=$('log-account'),cur=sel.value;sel.replaceChildren(new Option('همهٔ کاربران',''),...u.map(x=>new Option(x.name,x.name)));sel.value=cur;
  const recent=await api('/api/events?limit=8');$('recent-events').replaceChildren(...(recent.length?recent.map(e=>eventRow(e)):[node('p','هنوز رویدادی ثبت نشده است.','empty')]));
  drawTraffic().catch(()=>{});
}finally{busy=false}}
function action(label,handler,cls='btn secondary small'){const b=node('button',label,cls);b.onclick=async e=>{e.stopPropagation();b.disabled=true;try{await handler();await load();message(cluster?'عملیات ثبت شد؛ همگام‌سازی نود تا ۴۵ ثانیه طول می‌کشد.':'عملیات انجام شد؛ هسته حداکثر دو ثانیه بعد اعمال می‌کند.')}catch(x){message(x.message)}finally{b.disabled=false}};return b}
function renderUsers(){$('user-rows').replaceChildren();for(const u of users.filter(x=>x.name.toLowerCase().includes($('search').value.toLowerCase()))){
  const tr=node('tr'),name=node('td',undefined,'who'),nm=node('b',u.name,'ltr');nm.style.cursor='pointer';nm.onclick=()=>openAccount(u).catch(e=>message(e.message));name.append(nm,node('small',u.connected?`${u.connected} دستگاه متصل`:''));
  const state=node('td');state.append(node('span',u.active?'فعال':'غیرفعال','badge'+(u.active?'':' off')));
  const used=u.usage.rx+u.usage.tx,usage=node('td',undefined,'usage');usage.append(node('span',fmt(used)+' / '+(u.quota_bytes?fmt(u.quota_bytes):'نامحدود')+(cluster?` · رزرو ${fmt(u.usage.allocated)}`:''),'ltr'));
  if(u.quota_bytes){const m=node('div',undefined,'meter'+(used/u.quota_bytes>.85?' warn':'')),f=node('span');f.style.width=Math.min(100,used/u.quota_bytes*100)+'%';m.append(f);usage.append(m)}
  const ops=node('td'),buttons=node('div',undefined,'actions');
  buttons.append(action('لینک',async()=>{await navigator.clipboard.writeText(new URL(u.subscription,location.href).href)}),
    action('ویرایش',async()=>{selected=u;$('edit-name').textContent=u.name;$('edit-quota').value=u.quota_bytes/1073741824;$('edit-expires').value=u.expires||'';$('edit-connections').value=u.connections;$('edit-dialog').showModal()}),
    action(u.enabled?'توقف':'فعال',()=>api('/api/users/'+u.name,'PATCH',{enabled:!u.enabled})),
    action('کلید جدید',async()=>{if(confirm('لینک قبلی و کلید تمام دستگاه‌های این کاربر باطل شود؟'))await api('/api/users/'+u.name+'/rotate','POST',{})}),
    action('حذف',async()=>{if(confirm('کاربر '+u.name+' حذف شود؟'))await api('/api/users/'+u.name,'DELETE')},'btn danger small'));
  if(cluster)buttons.append(action('دستگاه‌ها',async()=>showDevices(u)));
  ops.append(buttons);tr.append(name,state,usage,node('td',`${u.connected} / ${u.connections}`),node('td',u.expires||'بدون انقضا'),ops);$('user-rows').append(tr)}}
$('search').oninput=renderUsers;
$('user-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));try{await api('/api/users','POST',{name:d.name,quota_bytes:Math.round(Number(d.quota)*1073741824),expires:d.expires||null,connections:Number(d.connections)});e.target.reset();await load();message('اشتراک ایجاد شد. برای هر دستگاه پروفایل جدا انتخاب کنید.')}catch(x){message(x.message)}};
$('cancel-edit').onclick=()=>$('edit-dialog').close();
$('edit-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/users/'+selected.name,'PATCH',{quota_bytes:Math.round(Number($('edit-quota').value)*1073741824),expires:$('edit-expires').value||null,connections:Number($('edit-connections').value)});$('edit-dialog').close();await load()}catch(x){message(x.message)}};
function renderServers(){$('server-cards').replaceChildren(...(cluster?nodes:servers).map(item=>{const s=cluster?servers.find(x=>x.id===item.profile_id):item;if(!s)return node('p','پروفایل نود در دسترس نیست');
  const n=node('article',undefined,'glass server-card');n.append(node('div',cluster?(item.online?'NODE / ONLINE':'NODE / OFFLINE'):'UDP / IPv4','eyebrow'),node('h2',s.name),node('p',`${s.host}:${s.port}`,'ltr mono'));
  const tags=node('div',undefined,'tags');for(const t of [`Repeat ${s.repeat}×`,`FEC k=${s.fec_k}`,`Jitter ${s.jitter}µs`,`MTU ${s.mtu}`,`DNS ${s.dns}`])tags.append(node('span',t));n.append(tags);
  if(cluster)n.append(node('p',`${item.devices} دستگاه · رزرو ${fmt(item.allocated)} · تنظیمات تأییدشده ${item.applied_seq}`,'muted'),node('p',item.error||'','warn'),action(item.enabled?'توقف نود':'فعال‌سازی نود',()=>api('/api/nodes/'+item.id,'PATCH',{enabled:!item.enabled})));
  else n.append(action('حذف پروفایل',()=>api('/api/servers/'+s.id,'DELETE'),'btn danger small'));return n}))}
function showDevices(u){$('device-heading').textContent='دستگاه‌های '+u.name;$('device-rows').replaceChildren();for(const d of u.devices){const row=node('div',undefined,'glass card'),select=node('select');select.append(new Option('انتخاب نود…',''));for(const n of nodes.filter(x=>x.enabled))select.append(new Option(n.name,n.id));select.value=d.node_id||'';const ready=d.ready?'آماده':d.pending_until*1000>Date.now()?'در انتظار پایان مجوز قبلی':'منتظر همگام‌سازی';row.append(node('p',`دستگاه ${d.slot} · ${d.ip} · ${ready}`),select,action('تخصیص / انتقال',async()=>{if(!select.value)throw Error('یک نود انتخاب کنید');const r=await api('/api/devices/'+d.id+'/move','POST',{node_id:select.value});row.append(node('p','زمان مجاز انتقال: '+new Date(r.ready_at*1000).toLocaleString('fa-IR')))}));$('device-rows').append(row)}$('device-dialog').showModal()}
$('close-devices').onclick=()=>$('device-dialog').close();
$('close-credential').onclick=()=>{$('node-token').value='';$('node-credential').close()};
$('node-credential').addEventListener('close',()=>{$('node-token').value=''});
$('server-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));for(const k of ['port','repeat','fec_k','jitter','mtu'])d[k]=Number(d[k]);d.fec=true;d.autotune=true;try{const result=await api(cluster?'/api/nodes':'/api/servers','POST',d);if(cluster){$('node-token').value=result.token;$('node-credential').showModal()}await load();message(cluster?'نود ساخته شد؛ توکن را ذخیره و نصب‌کننده را اجرا کنید.':'پروفایل اضافه شد و هسته پورت جدید را باز کرد؛ کاربران با به‌روزرسانی اشتراک به آن وصل می‌شوند.')}catch(x){message(x.message)}};
window.addEventListener('resize',()=>{if(token&&currentTab()==='overview')drawTraffic().catch(()=>{})});
setInterval(()=>{if(token)load().catch(e=>message(e.message))},10000);
setInterval(()=>{if(token&&['live','overview'].includes(currentTab())||(token&&$('detail-dialog').open))refreshLive().catch(()=>{})},2000);
