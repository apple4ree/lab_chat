"""Isolated loopback SSH fixture. Requires Paramiko only in the test environment."""
import json, logging, os, socket, subprocess, sys, threading
import paramiko
logging.disable(logging.CRITICAL)
directory = sys.argv[1]
host_key = paramiko.ECDSAKey.generate()
client_key = paramiko.RSAKey.generate(2048)
client_key.write_private_key_file(os.path.join(directory, 'client-key'), password='fixture-key-passphrase')
os.chmod(os.path.join(directory, 'client-key'), 0o600)
events = os.path.join(directory, 'events')

class Server(paramiko.ServerInterface):
    def get_allowed_auths(self, username): return 'password,publickey'
    def check_auth_password(self, username, password):
        with open(events, 'a') as f: f.write('password-attempt\n')
        return paramiko.AUTH_SUCCESSFUL if username == 'fixture' and password == 'fixture-only-password' else paramiko.AUTH_FAILED
    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL if username == 'fixture' and key == client_key else paramiko.AUTH_FAILED
    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
    def check_channel_exec_request(self, channel, command):
        if command != b'python3 -': return False
        threading.Thread(target=execute, args=(channel,), daemon=True).start()
        return True

def execute(channel):
    try:
        data = bytearray()
        while True:
            chunk = channel.recv(8192)
            if not chunk: break
            data.extend(chunk)
            if len(data) > 65536: return
        result = subprocess.run([sys.executable, '-'], input=bytes(data), capture_output=True, timeout=15, cwd=directory, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        if result.stdout: channel.sendall(result.stdout)
        if result.stderr: channel.sendall_stderr(result.stderr)
        channel.send_exit_status(result.returncode)
    except Exception:
        try: channel.send_exit_status(1)
        except Exception: pass
    finally: channel.close()

def serve(client):
    transport = paramiko.Transport(client)
    try:
        transport.add_server_key(host_key)
        transport.start_server(server=Server())
        channels = []
        while transport.is_active():
            channel = transport.accept(1)
            if channel is not None: channels.append(channel)
            channels = [c for c in channels if not c.closed]
    except Exception: pass
    finally: transport.close()

listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(8)
print(json.dumps({'port': listener.getsockname()[1]}), flush=True)
while True:
    client, _ = listener.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
