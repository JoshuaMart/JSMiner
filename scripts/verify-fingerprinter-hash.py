"""Replay fixtures against committed Fingerprinter code in a disposable checkout."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/verify-fingerprinter-hash.py /path/to/Fingerprinter")
upstream = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(["git", "-C", str(upstream), *args])
if git("status", "--porcelain").strip():
    raise SystemExit("Fingerprinter must be clean: validation uses its committed HEAD.")
commit = git("rev-parse", "HEAD").decode().strip()
expected = json.loads((root / "packages/contracts/examples/hash-vectors.json").read_text())["upstream"]["commit"]
if commit != expected:
    raise SystemExit(f"Expected documented commit {expected}, found {commit}; review provenance before updating fixtures.")
print("Fingerprinter commit:", commit, flush=True)
with tempfile.TemporaryDirectory(prefix="jsminer-fingerprinter-") as directory:
    checkout = Path(directory)
    with tarfile.open(fileobj=io.BytesIO(git("archive", "HEAD"))) as archive:
        archive.extractall(checkout, filter="data")
    shutil.copyfile(root / "packages/contracts/compat/fingerprinter_hash_test.go",
                    checkout / "internal/browser/jsminer_hash_compat_test.go")
    env = {**os.environ, "JSMINER_HASH_VECTORS": str(root / "packages/contracts/examples/hash-vectors.json"),
           "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOSUMDB": "off", "GOWORK": "off"}
    # Dependencies must already be in the Go module cache; no browser or external requests.
    result = subprocess.run(["go", "test", "-run", "^(TestJSMinerHashCompatibility|TestScriptHash.*|TestBuildScriptsRequiresFinishedLoad|TestDetectorLimitsUnchanged)$", "-count=1", "-v", "./internal/browser"],
                            cwd=checkout, env=env)
    if result.returncode:
        raise SystemExit(result.returncode)
print("Verified committed upstream code; original checkout unchanged.")
