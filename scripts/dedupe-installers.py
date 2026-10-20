"""Linux archive-only block deduplication. Dry-run unless --apply is supplied.

FIDEDUPERANGE compares bytes atomically and shares equal blocks with copy-on-write.
Paths, inodes and file contents stay independent. No unlink, rename or hardlink.
https://man7.org/linux/man-pages/man2/ioctl_fideduperange.2.html
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import struct

ROOT = Path(__file__).resolve().parents[1] / ".data" / "installer-builds"
FIDEDUPERANGE = 0xC0189436
CHUNK = 16 * 1024 * 1024


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def share(source, destination):
    """Kernel refuses differing bytes; unsupported filesystems fail without fallback."""
    flags = os.O_NOFOLLOW | os.O_CLOEXEC
    src = os.open(source, os.O_RDONLY | flags)
    try:
        dst = os.open(destination, os.O_RDWR | flags)
        try:
            left, right = os.fstat(src), os.fstat(dst)
            if not stat.S_ISREG(left.st_mode) or not stat.S_ISREG(right.st_mode):
                raise ValueError("Only regular files are accepted")
            if left.st_dev != right.st_dev or left.st_size != right.st_size:
                raise ValueError("Files must have the same size and filesystem")
            if left.st_ino == right.st_ino:
                return 0
            offset = 0
            while offset < left.st_size:
                length = min(CHUNK, left.st_size - offset)
                data = bytearray(struct.pack("=QQHHIqQQiI", offset, length, 1, 0, 0, dst, offset, 0, 0, 0))
                fcntl.ioctl(src, FIDEDUPERANGE, data, True)
                _, _, shared, status, _ = struct.unpack_from("=qQQiI", data, 24)
                if status != 0 or shared <= 0 or shared > length:
                    raise RuntimeError(f"Deduplication stopped at {offset}: status={status}, bytes={shared}")
                offset += shared
            return offset
        finally:
            os.close(dst)
    finally:
        os.close(src)


def run(apply=False):
    if ROOT.is_symlink():
        raise ValueError("Archive root must not be a symlink")
    groups = {}
    if ROOT.exists():
        for directory, dirs, names in os.walk(ROOT, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
            for name in sorted(names):
                path = Path(directory) / name
                if path.suffix.lower() not in (".exe", ".dmg") or path.is_symlink():
                    continue
                info = path.stat()
                if not stat.S_ISREG(info.st_mode):
                    continue
                key = (info.st_dev, info.st_size, digest(path))
                groups.setdefault(key, []).append(path)
    operations = []
    for (_, size, sha), paths in groups.items():
        source = paths[0]
        for destination in paths[1:]:
            before = destination.stat()
            shared = share(source, destination) if apply else 0
            after = destination.stat()
            if apply:
                assert (before.st_ino, before.st_size, before.st_mode, before.st_mtime_ns) == (
                    after.st_ino, after.st_size, after.st_mode, after.st_mtime_ns
                )
                assert digest(source) == sha and digest(destination) == sha
            operations.append({"source": str(source.relative_to(ROOT)), "destination": str(destination.relative_to(ROOT)),
                               "bytes": size, "kernelComparedSharedBytes": shared, "sha256": sha})
    return {"applied": apply, "scope": str(ROOT), "operations": operations,
            "comparedSharedBytes": sum(op["kernelComparedSharedBytes"] for op in operations),
            "note": "Kernel-confirmed shared ranges; repeat runs include already shared bytes. Not a free-space delta. Live installers, backups and databases are excluded."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    print(json.dumps(run(parser.parse_args().apply), indent=2))
