"""Verify final ZIP bytes, architecture, Mac links/modes, and embedded application sources.
Run from the project root after all three packaging commands have succeeded.
"""
import hashlib, json, pathlib, plistlib, stat, struct, subprocess, tempfile, zipfile
root=pathlib.Path.cwd()
version=json.loads((root/'desktop/package.json').read_text())['version']
report={'version':version,'nativeExecutionVerified':False,'files':[]}
def sha256(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()
sources=['main.cjs','preload.cjs','policy.cjs','notifications.cjs','updates.cjs','release-config.json','offline.html','offline.js']
for platform,arch in [('win','x64'),('mac','x64'),('mac','arm64')]:
    path=root/f'desktop/release/DAMI-Chat-{version}-{platform}-{arch}.zip'
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None, f'Corrupt ZIP: {path}'
        names=z.namelist()
        assert not any(n.startswith('/') or '..' in pathlib.PurePosixPath(n).parts for n in names)
        if platform=='mac':
            prefix='DAMI Chat.app/Contents/'
            info=plistlib.loads(z.read(prefix+'Info.plist'))
            assert info['CFBundleIdentifier']=='cc.damilab.chat'
            assert info['CFBundleShortVersionString']==version
            executable=prefix+'MacOS/'+info['CFBundleExecutable']
            binary=z.read(executable)
            magic,cpu=struct.unpack('<II',binary[:8])
            assert magic==0xfeedfacf and cpu==({'x64':0x1000007,'arm64':0x100000c}[arch])
            assert (z.getinfo(executable).external_attr>>16)&0o111, 'Mac executable mode missing'
            links=[x for x in z.infolist() if stat.S_ISLNK(x.external_attr>>16)]
            assert links, 'Mac framework symlinks missing'
            assert any('/Versions/Current' in x.filename for x in links)
            for x in links:
                target=z.read(x).decode()
                assert not target.startswith('/'), f'Absolute symlink: {x.filename}'
            asar_name=prefix+'Resources/app.asar'
        else:
            binary=z.read('DAMI Chat.exe');assert binary[:2]==b'MZ'
            offset=struct.unpack_from('<I',binary,0x3c)[0]
            assert binary[offset:offset+4]==b'PE\0\0'
            assert struct.unpack_from('<H',binary,offset+4)[0]==0x8664
            links=[];asar_name='resources/app.asar'
        with tempfile.TemporaryDirectory(prefix='dami-package-') as temp:
            asar=pathlib.Path(temp)/'app.asar';asar.write_bytes(z.read(asar_name))
            program="""
const fs=require('node:fs');const assert=require('node:assert/strict');
const asar=require('./desktop/node_modules/@electron/asar');const p=process.argv[1];
const sources=JSON.parse(process.argv[2]);
for(const name of sources)assert.deepEqual(asar.extractFile(p,name),fs.readFileSync('desktop/'+name),name+' differs');
const names=asar.listPackage(p);assert(!names.some(n=>/\/(\.data|\.env|server)(\/|$)/.test(n)));
const config=JSON.parse(asar.extractFile(p,'release-config.json'));
assert.equal(config.workspaceUrl,'https://chat.damilab.cc');assert.equal(config.signedRelease,false);
"""
            subprocess.run(['node','-e',program,str(asar),json.dumps(sources)],cwd=root,check=True)
        report['files'].append({'name':path.name,'bytes':path.stat().st_size,'sha256':sha256(path),'arch':arch,'macSymlinks':len(links),'embeddedSourcesMatch':True})
output=root/'.data/deploy/evidence/desktop-packages.json'
output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
