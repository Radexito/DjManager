#!/usr/bin/env python3
"""Locate the tools and firmware these scripts need, without assuming anybody's
home directory.

Both lookups are environment-first, so nothing here is machine-specific:

  CDJ_OBJDUMP   Directory holding the cross objdump binaries, or the binary
                itself. Falls back to searching PATH.
  CDJ_FW_DIR    Directory holding the .UPD firmware files. Falls back to
                reverse-engineering/firmware/ next to the repository root.

The firmware is Pioneer's and is not redistributed here. See README.md.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIRMWARE_SUBDIR = "firmware"


def objdump(target: str = "bfin-elf-objdump") -> str:
    """Path to a cross objdump binary, or exit explaining what to build."""
    root = os.environ.get("CDJ_OBJDUMP")
    if root:
        candidate = Path(root).expanduser()
        if candidate.is_dir():
            candidate = candidate / target
        if candidate.exists():
            return str(candidate)
    found = shutil.which(target)
    if found:
        return found
    raise SystemExit(
        f"{target} not found. Build binutils for the target and either put the "
        f"binaries on PATH or point CDJ_OBJDUMP at the directory holding them. "
        f"See README.md."
    )


def firmware_dir() -> Path:
    """Directory holding the .UPD files."""
    env = os.environ.get("CDJ_FW_DIR")
    if env:
        return Path(env).expanduser()
    local = REPO_ROOT / "reverse-engineering" / FIRMWARE_SUBDIR
    if local.is_dir():
        return local
    raise SystemExit(
        "Firmware directory not found. Download the .UPD files yourself, then "
        "either set CDJ_FW_DIR or place them in reverse-engineering/firmware/. "
        "See README.md."
    )


def locate(default_name: str, *candidates: str) -> Path:
    """Find an input file: explicit arguments win, then the firmware directory."""
    for candidate in candidates:
        if candidate:
            path = Path(candidate).expanduser()
            if path.exists():
                return path
    path = firmware_dir() / default_name
    if path.exists():
        return path
    raise SystemExit(
        f"{default_name} not found. Pass it as an argument, or put it in "
        f"{firmware_dir()}. See README.md."
    )


def scratch(name: str = "window.bin") -> Path:
    """A temporary file used to hand a byte window to objdump."""
    return Path(tempfile.gettempdir()) / name
