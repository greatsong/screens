#!/usr/bin/env python3
"""Read public event exports from registered projects and publish only changed feeds."""
import argparse
import base64
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import fcntl

from event_feed import KST, normalize
from project_paths import project_dir

ROOT = Path(__file__).resolve().parents[1]


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def read_source(source):
    project = project_dir(source["project"])
    if source["adapter"] == "danggok-program-v3":
        db = (project / source.get("database", "data/demo.sqlite3")).resolve()
        if not db.is_relative_to(project.resolve()):
            raise ValueError("database must be inside its project")
        raw = subprocess.run([sys.executable, str(project / "scripts/export_screens.py"), "--db", str(db)],
                             capture_output=True, check=True, timeout=30).stdout
    elif source["adapter"] == "json-file":
        path = (project / source["file"]).resolve()
        if not path.is_relative_to(project.resolve()):
            raise ValueError("feed must be inside its project")
        raw = path.read_bytes()
    else:
        raise ValueError("unknown event adapter")
    return normalize(json.loads(raw), source["id"])


def gh_api(endpoint, method="GET", payload=None):
    gh = shutil.which("gh")
    if not gh:
        raise RuntimeError("gh CLI is unavailable")
    command = [gh, "api", endpoint, "--method", method]
    if payload is not None:
        command += ["--input", "-"]
    result = subprocess.run(command, input=json_bytes(payload) if payload is not None else None,
                            capture_output=True, timeout=60)
    if result.returncode:
        # Do not log request bodies, tokens or remote response contents.
        if method == "GET" and b"HTTP 404" in result.stderr:
            return None
        raise RuntimeError(f"GitHub {method} failed ({result.returncode})")
    return json.loads(result.stdout) if result.stdout.strip() else None


def upload(repo, source, feed):
    endpoint = f"repos/{repo}/contents/projects/integrations/{source}.json"
    data = json_bytes(feed)
    for attempt in range(3):
        existing = gh_api(endpoint + "?ref=main")
        if existing and base64.b64decode(existing["content"]) == data:
            return False
        payload = {"branch": "main", "message": "행사 안내 자동 동기화: " + source,
                   "content": base64.b64encode(data).decode("ascii")}
        if existing:
            payload["sha"] = existing["sha"]
        try:
            gh_api(endpoint, "PUT", payload)
            return True  # user-token push triggers the normal Pages workflow
        except RuntimeError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def sync(config, state_file, publish=False, output=None):
    at = datetime.now(KST)
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    failed = False
    for source in config["sources"]:
        if not source.get("enabled", True):
            continue
        sid = source["id"]
        try:
            feed = read_source(source)
            digest = hashlib.sha256(json_bytes(feed)).hexdigest()
            previous = state.get(sid, {})
            # Refresh the 24-hour lease every 6 hours; unchanged content needs no API request.
            recent = at.timestamp() - previous.get("syncedAt", 0) < 6 * 3600
            if publish and previous.get("digest") == digest and recent:
                continue
            feed["validUntil"] = (at + timedelta(hours=24)).isoformat(timespec="seconds")
            if output:
                output.mkdir(parents=True, exist_ok=True)
                (output / (sid + ".json")).write_bytes(json_bytes(feed))
            if publish:
                upload(config["repository"], sid, feed)
                state[sid] = {"digest": digest, "syncedAt": at.timestamp()}
                state_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = state_file.with_suffix(".tmp")
                temporary.write_bytes(json_bytes(state))
                temporary.replace(state_file)
                print(sid + ": 동기화 완료")
            else:
                print(sid + ": " + str(len(feed["events"])) + "개 행사 (공개 쓰기 없음)")
        except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as exc:
            # A missing source leaves the last good snapshot to expire; it never publishes an empty replacement.
            print(sid + ": 동기화 실패 · " + type(exc).__name__, file=sys.stderr)
            failed = True
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "integrations/sources.json")
    parser.add_argument("--state", type=Path, default=ROOT / ".local/integration-state.json")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    args.state.parent.mkdir(parents=True, exist_ok=True)
    with args.state.with_suffix(".lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        return sync(json.loads(args.config.read_text()), args.state, args.publish, args.output)


if __name__ == "__main__":
    sys.exit(main())
