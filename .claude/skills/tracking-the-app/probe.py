#!/usr/bin/env python3
"""Pull a Mirasim release apart and search it.

The app's server bundle is the only honest source for what the client sends and
what the relay answers. It is ~20 MB on six lines, one of them 15 MB, so the
usual line-oriented tools are useless on it: `grep -C` prints the whole file and
an editor will not open it. Everything here exists to work around that.

  python probe.py fetch                    # latest release -> .scratch/mirasim-<ver>/
  python probe.py fetch 0.0.208            # a named version
  python probe.py grep <dir> <pattern>     # windows of text around each hit
  python probe.py codes <dir>              # the snake_case error taxonomy
  python probe.py const '-0x5*0x4f5+-0x1f07+0x37dc'   # -> 12

Stdlib only, so it runs from the repo with no install step.
"""

import ast
import hashlib
import io
import json
import operator
import re
import sys
import tarfile
import urllib.request
from pathlib import Path

MANIFEST = "https://cdn-assets.mirofish.ai/mirasim/releases/latest.json"
RELEASES = "https://cdn-assets.mirasim.ai/mirasim/releases"
# Downloads land here: gitignored, and this repo is public.
SCRATCH = Path(".scratch")


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url) as r:
        return r.read()


def fetch(version: str | None) -> None:
    """Download and verify a payload, then unpack it.

    Always the payload tarball, never a platform installer: the installers are
    the Electron shell around this same bundle, five times the size for nothing
    extra. The manifest needs no credentials, which is what makes this runnable
    unattended.
    """
    manifest = json.loads(_get(MANIFEST))
    if version and version != manifest["version"]:
        # Older releases stay addressable, but only the latest is described by
        # the manifest — so a named version buys the URL and forfeits the hash.
        url = f"{RELEASES}/v{version}/payload-{version}.tgz"
        expect = None
    else:
        version = manifest["version"]
        url = manifest["payload"]["url"]
        expect = manifest["payload"]["sha256"]
        print(f"manifest: {version}  abi {manifest['payload']['minShellAbi']}"
              f"-{manifest['payload']['maxShellAbi']}  built {manifest['payload'].get('builtAt', '?')}")

    out = SCRATCH / f"mirasim-{version}"
    out.mkdir(parents=True, exist_ok=True)
    tgz = out / f"payload-{version}.tgz"

    if not tgz.exists():
        print(f"downloading {url}")
        tgz.write_bytes(_get(url))

    got = hashlib.sha256(tgz.read_bytes()).hexdigest()
    if expect and got != expect:
        sys.exit(f"sha256 mismatch\n  got      {got}\n  expected {expect}")
    print(f"sha256 {got}{' (verified)' if expect else ' (unverified: no manifest entry)'}")

    with tarfile.open(tgz) as t:
        t.extractall(out)
    server = out / "server.cjs"
    print(f"unpacked -> {out}")
    print(f"server.cjs {server.stat().st_size:,} bytes" if server.exists() else "server.cjs MISSING")


def _read(d: str) -> str:
    p = Path(d)
    if p.is_dir():
        p = p / "server.cjs"
    # errors=replace: the bundle carries UTF-8 message catalogues, and one bad
    # byte should not take the whole search down.
    return io.open(p, encoding="utf8", errors="replace").read()


def grep(d: str, pattern: str, before: int, after: int, limit: int, out: str | None) -> None:
    """Print a fixed-width window around each hit, by byte offset.

    Offsets rather than lines because the file has no useful lines. Write to a
    file (`--out`) when the hit is a message catalogue: the app's strings are
    Chinese, and a Windows console will render them as noise while the file is
    perfectly fine.
    """
    src = _read(d)
    sink = io.open(out, "w", encoding="utf8") if out else sys.stdout
    i = n = 0
    while n < limit:
        i = src.find(pattern, i)
        if i < 0:
            break
        sink.write(f"=== {pattern} @{i} ===\n")
        # \x20 and \n arrive escaped inside the bundle's own string literals.
        sink.write(src[max(0, i - before): i + after].replace("\\x20", " ").replace("\\n", "\n"))
        sink.write("\n\n")
        i += 1
        n += 1
    if out:
        sink.close()
        print(f"{n} hit(s) -> {out}")
    elif n == 0:
        print(f"no hit for {pattern!r}")


def codes(d: str) -> None:
    """The relay/app error taxonomy, which is what classification has to track.

    Every snake_case string literal, filtered to the ones that could plausibly
    describe a refusal. Reading this list is how you find out that the client
    branches on eight reasons where the gateway knows two.
    """
    src = _read(d)
    found = set(re.findall(r"'([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})'", src))
    kw = re.compile(r"quota|credit|limit|plan|entitle|model|account|device|shared|"
                    r"throttl|refus|deny|forbid|exhaust|tier|subscri|upgrade|relay|route|region|skew|outdated")
    hits = sorted(c for c in found if kw.search(c))
    print(f"{len(found)} snake_case literals, {len(hits)} refusal-shaped:\n")
    for c in hits:
        print(f"  {c}")


_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.USub: operator.neg, ast.UAdd: operator.pos}


def const(expr: str) -> None:
    """Evaluate one of the bundle's obfuscated numeric literals.

    Every number in the bundle is spelled as hex arithmetic — `randomBytes(12)`
    ships as `randomBytes(-0x5*0x4f5+0x1*-0x1f07+0x37dc)`. Guessing these wrong
    is how you get a signature that verifies in a test and 400s on the relay.
    """
    def ev(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.BinOp):
            return _OPS[type(node.op)](ev(node.left), ev(node.right))
        if isinstance(node, ast.UnaryOp):
            return _OPS[type(node.op)](ev(node.operand))
        raise ValueError(f"unsupported: {ast.dump(node)}")

    print(ev(ast.parse(expr, mode="eval").body))


def main() -> None:
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a[0]
    if cmd == "fetch":
        fetch(a[1] if len(a) > 1 else None)
    elif cmd == "grep":
        if len(a) < 3:
            sys.exit("usage: probe.py grep <dir> <pattern> [before] [after] [limit] [--out FILE]")
        out = None
        rest = a[3:]
        if "--out" in rest:
            k = rest.index("--out")
            out = rest[k + 1]
            rest = rest[:k] + rest[k + 2:]
        nums = [int(x) for x in rest]
        grep(a[1], a[2], *(nums + [600, 600, 3][len(nums):]), out=out)
    elif cmd == "codes":
        codes(a[1])
    elif cmd == "const":
        const(a[1])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
