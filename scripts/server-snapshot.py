#!/usr/bin/env python3
"""Read-only Linux inventory. No logs, processes, users, serials or secrets leave the host."""
import json, os, platform, time
from pathlib import Path


def read(path):
    try:
        return Path(path).read_text().strip()
    except (OSError, UnicodeError):
        return None


def number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def snapshot():
    memory = {}
    for line in (read('/proc/meminfo') or '').splitlines():
        key, value = line.split(':', 1)
        n = number(value.split()[0])
        if n is not None:
            memory[key] = n * 1024
    cpus = []
    for block in (read('/proc/cpuinfo') or '').split('\n\n'):
        fields = dict(line.split(':', 1) for line in block.splitlines() if ':' in line)
        fields = {k.strip(): v.strip() for k, v in fields.items()}
        if 'processor' in fields:
            cpus.append(fields)
    def cpu_ticks():
        lines = (read('/proc/stat') or '').splitlines()
        if not lines or not lines[0].startswith('cpu '): return None
        ticks = list(map(int, lines[0].split()[1:9]))
        return sum(ticks), ticks[3] + ticks[4]
    before = cpu_ticks()
    time.sleep(0.2)
    after = cpu_ticks()
    usage = None
    if before and after and after[0] > before[0]:
        usage = round(100 * (1 - (after[1]-before[1])/(after[0]-before[0])), 1)
    disks, devices = [], set()
    # Mount allowlist: physical/block-backed filesystems plus the container root.
    for line in (read('/proc/self/mountinfo') or '').splitlines():
        left, right = line.split(' - ', 1)
        fields, fs = left.split(), right.split()
        mount = fields[4].replace('\\040', ' ').replace('\\134', '\\')
        if mount != '/' and (not fs[1].startswith('/dev/') or mount.startswith(('/etc/', '/proc/', '/sys/', '/dev/'))): continue
        try:
            dev, stat = os.stat(mount).st_dev, os.statvfs(mount)
            if not os.path.isdir(mount) or dev in devices or stat.f_blocks == 0: continue
            devices.add(dev)
            disks.append({'mount': mount, 'filesystem': fs[0], 'totalBytes': stat.f_blocks*stat.f_frsize,
                          'availableBytes': stat.f_bavail*stat.f_frsize, 'usedBytes': (stat.f_blocks-stat.f_bfree)*stat.f_frsize})
        except OSError:
            continue
        if len(disks) >= 32: break
    mem_limit = number(read('/sys/fs/cgroup/memory.max'))
    mem_used = number(read('/sys/fs/cgroup/memory.current'))
    cpu_max = (read('/sys/fs/cgroup/cpu.max') or '').split()
    quota = None
    if len(cpu_max) == 2 and cpu_max[0] != 'max' and number(cpu_max[1]):
        quota = int(cpu_max[0])/int(cpu_max[1])
    container = Path('/.dockerenv').exists() or Path('/run/.containerenv').exists()
    uptime = (read('/proc/uptime') or '').split()
    return {'version': 1, 'reportedAt': int(time.time()*1000), 'hostname': platform.node(),
            'os': platform.system(), 'kernel': platform.release(), 'architecture': platform.machine(),
            'model': read('/sys/class/dmi/id/product_name'), 'scope': 'container' if container else 'host',
            'bootId': read('/proc/sys/kernel/random/boot_id'), 'uptimeSeconds': float(uptime[0]) if uptime else None,
            'cpu': {'model': next((c['model name'] for c in cpus if c.get('model name')), None),
                    'logicalCores': len(cpus) or None, 'physicalCores': len({(c['physical id'], c['core id']) for c in cpus if 'physical id' in c and 'core id' in c}) or None,
                    'sockets': len({c['physical id'] for c in cpus if 'physical id' in c}) or None,
                    'usagePercent': usage, 'load1': os.getloadavg()[0], 'allowedCores': len(os.sched_getaffinity(0)), 'quotaCores': quota},
            'memory': {'totalBytes': memory.get('MemTotal'), 'availableBytes': memory.get('MemAvailable'),
                       'swapTotalBytes': memory.get('SwapTotal'), 'swapFreeBytes': memory.get('SwapFree'),
                       'limitBytes': mem_limit, 'cgroupUsedBytes': mem_used}, 'disks': disks}

if __name__ == '__main__':
    print(json.dumps(snapshot(), ensure_ascii=False))
