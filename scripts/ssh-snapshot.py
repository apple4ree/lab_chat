"""Appended to server-snapshot.py; no installation, sudo, daemon or package changes."""
import csv, io, shutil, subprocess, sys

def gpu_snapshot():
    executable = shutil.which('nvidia-smi')
    if not executable:
        return {'state': 'absent', 'items': []}
    try:
        result = subprocess.run([executable, '--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, check=True)
        rows = list(csv.reader(io.StringIO(result.stdout)))
        if len(rows) > 64 or len(result.stdout) > 32768:
            raise ValueError('GPU output exceeds limit')
        def numeric(s):
            try: return float(s.strip())
            except ValueError: return None
        processes = None
        try:
            proc_result = subprocess.run([executable, '--query-compute-apps=gpu_uuid,pid,used_gpu_memory', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, check=True)
            if len(proc_result.stdout) <= 65536:
                processes = {}
                for uuid, pid, used_mem in csv.reader(io.StringIO(proc_result.stdout)):
                    processes.setdefault(uuid.strip(), []).append({'pid': int(pid), 'used_mem': numeric(used_mem)})
        except (OSError, ValueError, subprocess.SubprocessError):
            processes = None
        items = []
        for row in rows:
            if len(row) != 7: raise ValueError('Invalid GPU output')
            index, uuid, name, total, used, util, temp = row
            item = {'index': int(index), 'name': name.strip(), 'mem_total': numeric(total), 'mem_used': numeric(used), 'util': numeric(util), 'temp': numeric(temp)}
            if processes is not None: item['procs'] = processes.get(uuid.strip(), [])
            items.append(item)
        return {'state': 'ok', 'items': items}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {'state': 'error', 'items': []}

if __name__ == '__main__':
    if platform.system() != 'Linux':
        print(json.dumps({'unsupported': True}))
    else:
        sample = snapshot()
        gpu = gpu_snapshot() if COLLECT_GPU else {'state': 'disabled', 'items': []}
        print(json.dumps({'sample': sample, 'gpu': gpu, 'python': list(sys.version_info[:3]), 'platform': platform.system()}))
