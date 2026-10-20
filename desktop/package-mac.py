"""Archive macOS bundles without following framework symlinks, also on Linux.
Run after electron-builder --mac --dir --arm64 --x64.
"""
import json, os, pathlib, stat, zipfile
root=pathlib.Path(__file__).resolve().parent
version=json.loads((root/'package.json').read_text())['version']
for arch,directory in [('x64','mac'),('arm64','mac-arm64')]:
    base=root/'release'/directory
    bundle=base/'DAMI Chat.app'
    if not (bundle/'Contents/Info.plist').is_file():
        raise RuntimeError(f'Missing completed bundle: {bundle}')
    output=root/'release'/f'DAMI-Chat-{version}-mac-{arch}.zip'
    temporary=output.with_suffix('.zip.next')
    with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
        def add(path):
            relative=path.relative_to(base).as_posix()
            if path.is_symlink():
                info=zipfile.ZipInfo(relative)
                info.create_system=3
                info.external_attr=(stat.S_IFLNK|0o777)<<16
                z.writestr(info,os.readlink(path).encode())
            else:
                z.write(path,relative)
        add(bundle)
        for directory,dirs,files in os.walk(bundle,followlinks=False):
            for name in sorted(dirs+files):add(pathlib.Path(directory)/name)
    temporary.replace(output)
    print(f'Created {output.name}: {output.stat().st_size} bytes',flush=True)
