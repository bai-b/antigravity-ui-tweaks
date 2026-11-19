"""Build the release zip: plugin payload plus the one-click installer."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAYLOAD = ("plugin.json", "skills", "sidecars")
EXTRAS = ("install.ps1", "install.cmd", "README.md")
STAGE_NAME = "antigravity-ui-tweaks"
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def version() -> str:
    return json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))["version"]


def collect(stage: Path) -> list[Path]:
    missing = [name for name in PAYLOAD + EXTRAS if not (ROOT / name).exists()]
    if missing:
        sys.exit("missing from the checkout: " + ", ".join(missing))
    written: list[Path] = []
    for name in PAYLOAD:
        source = ROOT / name
        target = stage / name
        if source.is_dir():
            shutil.copytree(
                source,
                target,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules", ".DS_Store"),
            )
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        written.append(target)
    for name in EXTRAS:
        target = stage / name
        shutil.copy2(ROOT / name, target)
        written.append(target)
    return written


def add_tree(archive: zipfile.ZipFile, stage: Path) -> None:
    for path in sorted(stage.rglob("*")):
        if path.is_dir():
            continue
        relative = Path(STAGE_NAME) / path.relative_to(stage)
        info = zipfile.ZipInfo(relative.as_posix(), date_time=FIXED_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="build the release zip")
    parser.add_argument("--out", default=str(ROOT / "dist"), help="output directory")
    args = parser.parse_args()

    tag = version()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f"antigravity-ui-tweaks-{tag}.zip"
    stage = out_dir / f".stage-{tag}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    try:
        files = collect(stage)
        with zipfile.ZipFile(zip_path, "w") as archive:
            add_tree(archive, stage)
        digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        (out_dir / f"antigravity-ui-tweaks-{tag}.zip.sha256").write_text(
            f"{digest}  {zip_path.name}\n", encoding="utf-8"
        )
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    print(f"version {tag}")
    print(f"files   {len(files)}")
    print(f"zip     {zip_path}  {zip_path.stat().st_size} bytes")
    print(f"sha256  {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
