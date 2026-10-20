"""Live monitoring for the panel: engine sessions and quality, the events log,
host health, history for charts and IP location (country / operator).

Standard library only. IP location uses the free DB-IP Lite databases
(CC BY 4.0, "IP Geolocation by DB-IP"), downloaded into the state directory.
"""
import array
import bisect
import csv
import datetime as dt
import gzip
import io
import ipaddress
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import time
import urllib.request

SESSION_FIELDS = ('endpoint', 'since', 'roams', 'up_loss_pm', 'up_lost', 'up_fec', 'down_loss_pm', 'down_lost',
                  'down_fec', 'rtt', 'repeat', 'rx_bytes', 'tx_bytes', 'hops', 'up_lost_total', 'up_fec_total',
                  'down_lost_total', 'down_fec_total')
EVENT_TYPES = ('connect', 'roam', 'disconnect', 'idle', 'quality', 'expired', 'quota', 'allowed')


def read_status(path):
    """Parse the engine status file (fields after the first six are optional)."""
    result = {'online': False, 'updated': 0, 'accounts': {}, 'sessions': []}
    try:
        lines = Path(path).read_text().splitlines()
        head = lines[0].split()
        if head[0] != 'KANKI_STATUS_V1':
            return result
        result['updated'] = int(head[1])
        result['online'] = 0 <= time.time() - int(head[1]) < 5
        for line in lines[1:]:
            p = line.split()
            if not p:
                continue
            if p[0] == 'account' and len(p) >= 5:
                result['accounts'][p[1]] = {'rx': int(p[2]), 'tx': int(p[3]), 'quota': int(p[4])}
            elif p[0] == 'session' and len(p) >= 6:
                s = {'name': p[1], 'account': p[2], 'connected': p[3] == '1', 'ip': p[4], 'last_rx': int(p[5])}
                for key, value in zip(SESSION_FIELDS, p[7:]):
                    s[key] = value if key == 'endpoint' else int(value)
                result['sessions'].append(s)
    except (OSError, ValueError, IndexError):
        pass
    return result


def read_events(path, limit=300, device=None, account=None, kind=None, text=None, before=None):
    """Newest first, from the log and its rotated copy."""
    rows = []
    for file in (Path(str(path) + '.1'), Path(path)):
        try:
            with open(file, 'r', errors='replace') as f:
                for line in f:
                    p = line.rstrip('\n').split(' ', 4)
                    if len(p) < 4 or not p[0].isdigit():
                        continue
                    at, dev, acct, typ = int(p[0]), p[1], p[2], p[3]
                    detail = p[4] if len(p) > 4 else ''
                    if device and dev != device: continue
                    if account and acct != account: continue
                    if kind and typ != kind: continue
                    if before and at >= before: continue
                    if text and text.lower() not in line.lower(): continue
                    fields = dict(x.split('=', 1) for x in detail.split() if '=' in x)
                    rows.append({'at': at, 'device': dev, 'account': acct, 'type': typ, 'detail': detail, 'fields': fields})
        except OSError:
            continue
    rows.reverse()
    return rows[:limit]


class GeoDB:
    """IPv4 -> country code and operator (ASN organisation)."""
    SOURCES = {'country': 'https://download.db-ip.com/free/dbip-country-lite-{}.csv.gz',
               'asn': 'https://download.db-ip.com/free/dbip-asn-lite-{}.csv.gz'}

    def __init__(self, directory):
        self.dir = Path(directory)
        self.lock = threading.Lock()
        self.country = self.asn = None
        self.cache = {}

    @staticmethod
    def _months():
        today = dt.date.today().replace(day=1)
        previous = (today - dt.timedelta(days=1)).replace(day=1)
        return [today.strftime('%Y-%m'), previous.strftime('%Y-%m')]

    def refresh(self, max_age_days=35):
        """Download missing or old databases; failures leave the old files in place."""
        self.dir.mkdir(parents=True, exist_ok=True)
        for kind, url in self.SOURCES.items():
            target = self.dir / f'{kind}.csv.gz'
            if target.exists() and time.time() - target.stat().st_mtime < max_age_days * 86400:
                continue
            for month in self._months():
                try:
                    tmp = target.with_suffix('.tmp')
                    with urllib.request.urlopen(url.format(month), timeout=60) as r, open(tmp, 'wb') as out:
                        shutil.copyfileobj(r, out, 1 << 20)
                    with gzip.open(tmp, 'rt') as check:
                        if not check.readline():
                            raise ValueError('empty database')
                    os.replace(tmp, target)
                    break
                except (OSError, ValueError):
                    try: os.unlink(tmp)
                    except OSError: pass
        self.load()

    def _read(self, name, value_column):
        path = self.dir / f'{name}.csv.gz'
        if not path.exists():
            return None
        starts, ends, values, names = array.array('L'), array.array('L'), array.array('L'), {}
        table = []
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
            for row in csv.reader(f):
                if len(row) <= value_column or ':' in row[0]:
                    continue
                try:
                    a, b = int(ipaddress.IPv4Address(row[0])), int(ipaddress.IPv4Address(row[1]))
                except ValueError:
                    continue
                v = row[value_column] if value_column == 2 and name == 'country' else f'AS{row[2]} {row[3]}'
                if v not in names:
                    names[v] = len(table); table.append(v)
                starts.append(a); ends.append(b); values.append(names[v])
        return starts, ends, values, table

    def load(self):
        country, asn = self._read('country', 2), self._read('asn', 3)
        with self.lock:
            self.country, self.asn, self.cache = country, asn, {}

    @staticmethod
    def _find(db, ip):
        if not db:
            return None
        starts, ends, values, table = db
        i = bisect.bisect_right(starts, ip) - 1
        return table[values[i]] if i >= 0 and starts[i] <= ip <= ends[i] else None

    def lookup(self, address):
        try:
            ip = ipaddress.IPv4Address(address)
        except ValueError:
            return {}
        if ip.is_private or ip.is_loopback:
            return {'cc': '', 'org': 'شبکهٔ خصوصی'}
        with self.lock:
            if address in self.cache:
                return self.cache[address]
            cc, org = self._find(self.country, int(ip)), self._find(self.asn, int(ip))
            info = {'cc': cc if cc and cc != 'ZZ' else '', 'org': org or ''}
            if len(self.cache) > 4096:
                self.cache.clear()
            self.cache[address] = info
            return info


class HostStats:
    """CPU, memory, disk, load and WAN throughput from /proc."""

    def __init__(self):
        self.prev_cpu = self.prev_net = None

    @staticmethod
    def _wan():
        try:
            for line in open('/proc/net/route').read().splitlines()[1:]:
                p = line.split()
                if len(p) > 2 and p[1] == '00000000':
                    return p[0]
        except OSError:
            pass
        return None

    def sample(self):
        now = time.time()
        out = {'time': int(now)}
        try:
            cpu = [int(x) for x in open('/proc/stat').readline().split()[1:]]
            idle, total = cpu[3] + (cpu[4] if len(cpu) > 4 else 0), sum(cpu)
            if self.prev_cpu and total > self.prev_cpu[1]:
                out['cpu'] = round(100 * (1 - (idle - self.prev_cpu[0]) / (total - self.prev_cpu[1])), 1)
            self.prev_cpu = (idle, total)
        except (OSError, ValueError, IndexError):
            pass
        try:
            mem = {l.split(':')[0]: int(l.split()[1]) * 1024 for l in open('/proc/meminfo') if ':' in l}
            out['mem_total'], out['mem_used'] = mem['MemTotal'], mem['MemTotal'] - mem.get('MemAvailable', mem.get('MemFree', 0))
        except (OSError, ValueError, KeyError):
            pass
        try:
            out['load'] = [float(x) for x in open('/proc/loadavg').read().split()[:3]]
            out['uptime'] = int(float(open('/proc/uptime').read().split()[0]))
            out['cores'] = os.cpu_count() or 1
        except (OSError, ValueError):
            pass
        try:
            d = shutil.disk_usage('/')
            out['disk_total'], out['disk_used'] = d.total, d.used
        except OSError:
            pass
        wan = self._wan()
        if wan:
            try:
                for line in open('/proc/net/dev'):
                    if line.strip().startswith(wan + ':'):
                        p = line.split(':', 1)[1].split()
                        rx, tx = int(p[0]), int(p[8])
                        if self.prev_net and now > self.prev_net[0]:
                            span = now - self.prev_net[0]
                            out['net_rx_bps'] = max(0, int((rx - self.prev_net[1]) * 8 / span))
                            out['net_tx_bps'] = max(0, int((tx - self.prev_net[2]) * 8 / span))
                        self.prev_net = (now, rx, tx)
                        out['wan'] = wan
            except (OSError, ValueError, IndexError):
                pass
        return out


class Monitor:
    """Samples the engine every few seconds: live rates, host health and history."""

    def __init__(self, db, status_path, events_path, geo_dir, interval=5):
        self.db, self.status_path, self.events_path, self.interval = db, Path(status_path), Path(events_path), interval
        self.geo = GeoDB(geo_dir)
        self.host = HostStats()
        self.lock = threading.Lock()
        self.prev = {}          # device -> (time, rx_bytes, tx_bytes)
        self.rates = {}         # device -> (down_bps, up_bps)
        self.system = {}
        self.last_store = 0
        with sqlite3.connect(self.db) as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS metrics (ts INTEGER PRIMARY KEY, down_bps INTEGER, up_bps INTEGER,
              sessions INTEGER, cpu REAL, mem_used INTEGER, net_rx_bps INTEGER, net_tx_bps INTEGER);
            CREATE TABLE IF NOT EXISTS quality (ts INTEGER NOT NULL, device TEXT NOT NULL, rtt INTEGER,
              up_loss_pm INTEGER, down_loss_pm INTEGER, lost INTEGER, fec INTEGER, PRIMARY KEY(device, ts));
            ''')

    def start(self):
        threading.Thread(target=self._geo_loop, daemon=True).start()
        threading.Thread(target=self._loop, daemon=True).start()

    def _geo_loop(self):
        while True:
            try:
                self.geo.refresh()
            except Exception as e:  # never stop the panel because of the optional database
                print('IP location database unavailable:', type(e).__name__, flush=True)
            time.sleep(86400)

    def _loop(self):
        while True:
            try:
                self.tick()
            except (OSError, sqlite3.Error, ValueError) as e:
                print('Monitor sampling failed:', type(e).__name__, flush=True)
            time.sleep(self.interval)

    def tick(self):
        now = time.time()
        status = read_status(self.status_path)
        system = self.host.sample()
        rates = {}
        for s in status['sessions']:
            if 'rx_bytes' not in s:
                continue
            old = self.prev.get(s['name'])
            if old and now > old[0] and s['rx_bytes'] >= old[1] and s['tx_bytes'] >= old[2]:
                rates[s['name']] = (int((s['rx_bytes'] - old[1]) * 8 / (now - old[0])), int((s['tx_bytes'] - old[2]) * 8 / (now - old[0])))
            self.prev[s['name']] = (now, s['rx_bytes'], s['tx_bytes'])
        with self.lock:
            self.rates, self.system = rates, system
        if now - self.last_store >= 30:
            self.last_store = now
            live = [s for s in status['sessions'] if s['connected']]
            ts = int(now)
            with sqlite3.connect(self.db) as c:
                c.execute('INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?,?)', (ts, sum(r[0] for r in rates.values()),
                    sum(r[1] for r in rates.values()), len(live), system.get('cpu'), system.get('mem_used'),
                    system.get('net_rx_bps'), system.get('net_tx_bps')))
                for s in live:
                    if 'rtt' in s:
                        c.execute('INSERT OR REPLACE INTO quality VALUES(?,?,?,?,?,?,?)', (ts, s['name'], s['rtt'], s['up_loss_pm'],
                            s['down_loss_pm'], s['up_lost'] + s['down_lost'], s['up_fec'] + s['down_fec']))
                c.execute('DELETE FROM metrics WHERE ts<?', (ts - 7 * 86400,))
                c.execute('DELETE FROM quality WHERE ts<?', (ts - 2 * 86400,))

    def live(self):
        status = read_status(self.status_path)
        with self.lock:
            rates, system = dict(self.rates), dict(self.system)
        sessions = []
        for s in status['sessions']:
            if not s['connected'] and s.get('endpoint', '-') == '-':
                continue
            s = dict(s)
            s['down_bps'], s['up_bps'] = rates.get(s['name'], (0, 0))
            ip = s.get('endpoint', '-').rsplit(':', 1)[0]
            s['geo'] = self.geo.lookup(ip) if ip != '-' else {}
            sessions.append(s)
        sessions.sort(key=lambda x: (not x['connected'], x['account'], x['name']))
        return {'engine_online': status['online'], 'engine_updated': status['updated'], 'system': system,
                'sessions': sessions, 'geo_ready': self.geo.country is not None}

    def events(self, **filters):
        rows = read_events(self.events_path, **filters)
        for r in rows:
            for key in ('from', 'to'):
                if key in r['fields']:
                    r['fields'][key + '_geo'] = self.geo.lookup(r['fields'][key].rsplit(':', 1)[0])
        return rows

    def history(self, hours):
        since = int(time.time()) - int(hours * 3600)
        with sqlite3.connect(self.db) as c:
            c.row_factory = sqlite3.Row
            return [dict(r) for r in c.execute('SELECT * FROM metrics WHERE ts>=? ORDER BY ts', (since,))]

    def quality(self, device, hours):
        since = int(time.time()) - int(hours * 3600)
        with sqlite3.connect(self.db) as c:
            c.row_factory = sqlite3.Row
            return [dict(r) for r in c.execute('SELECT * FROM quality WHERE device=? AND ts>=? ORDER BY ts', (device, since))]
