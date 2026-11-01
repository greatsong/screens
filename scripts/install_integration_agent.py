#!/usr/bin/env python3
"""Install the per-user event bridge; all machine-specific paths live in its plist."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LABEL = "kr.greatsong.screens-integrations"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="write and activate the LaunchAgent")
    args = parser.parse_args()
    from project_paths import project_dir
    registry_root = project_dir("screens").parents[1]
    gh = shutil.which("gh")
    if not gh:
        parser.error("gh CLI가 필요합니다.")
    local = ROOT / ".local"
    local.mkdir(exist_ok=True)
    agent = {"Label": LABEL, "ProgramArguments": [sys.executable, str(ROOT / "scripts/sync_integrations.py"), "--publish"],
             "WorkingDirectory": str(ROOT), "StartInterval": 60, "RunAtLoad": True,
             "StandardOutPath": str(local / "integrations.log"), "StandardErrorPath": str(local / "integrations-error.log"),
             "EnvironmentVariables": {"PATH": str(Path(gh).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                                      "GREATSONG_ROOT": str(registry_root)}}
    path = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    if not args.install:
        print(plistlib.dumps(agent).decode())
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(agent))
    domain = "gui/" + str(os.getuid())
    subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(path)], check=True)
    print("행사 자동 연동 등록 완료: 60초 간격")


if __name__ == "__main__":
    main()
