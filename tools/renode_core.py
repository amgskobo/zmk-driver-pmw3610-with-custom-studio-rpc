#!/usr/bin/env python3
"""Prepare the pinned Renode CPU backport, then run West without downloading.

The original Renode installation stays intact. The loader replaces only each
process's extracted arm-m library, before NativeBinder opens that temporary file.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import platform
import re
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION = "1.16.1"
WEST_COMMANDS = "536260056f362edb2092905f2a75317bc8cb9bc2"
SOURCES = {
    "tlib": (
        "antmicro/tlib",
        "d50c868f33fb42954d85b8d06ce6f7d5bac23dd4",
        "0761b9f762e5d4e780a6dc3b5f38c0f9536a70512bd8449b27b94edce186fb44",
    ),
    "infrastructure": (
        "renode/renode-infrastructure",
        "add012af003a0f620d3da52828262676f374d121",
        "935a03b7fdd26e7c1fd7525400503bbd488de18c8b398b0fca5de2fb070289ba",
    ),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def profile_path(cache: Path) -> Path:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("The pinned container profile requires Linux x86_64")
    inputs = [
        sha256(HERE / name)
        for name in (
            "renode_core.py",
            "renode_core_loader.c",
            "renode_spurious_irq.patch",
        )
    ]
    inputs.append(subprocess.check_output(["cc", "--version"], text=True))
    return cache / hashlib.sha256(json.dumps(inputs).encode()).hexdigest()[:20]


def validate(profile: Path) -> dict:
    manifest = profile / "manifest.json"
    if not manifest.is_file():
        raise RuntimeError("Renode CPU inputs are not prepared; run prepare first")
    record = json.loads(manifest.read_text())
    library = profile / "build/tlib/translate-arm-m-le.so"
    loader = profile / "loader"
    expected_files = {str(library), str(loader / "libdl.so.2"), record["binary"]}
    if (
        record["version"] != VERSION
        or record["library"] != str(library)
        or record["loader"] != str(loader)
        or set(record["files"]) != expected_files
    ):
        raise RuntimeError("Prepared Renode manifest does not match this profile")
    for path, expected in record["files"].items():
        if sha256(Path(path)) != expected:
            raise RuntimeError("Prepared Renode input changed; use a fresh cache")
    return record


def prepare(args, profile: Path):
    if (profile / "manifest.json").is_file():
        record = validate(profile)
        if record["renode_root"] != str(args.renode_root):
            raise RuntimeError(
                "This cache uses another Renode root; select a fresh cache"
            )
        print("Pinned Renode CPU backport is already prepared")
        return
    if profile.exists():
        raise RuntimeError("Incomplete preparation retained; select a fresh cache")
    archives = args.cache / "archives"
    archives.mkdir(parents=True, exist_ok=True)
    for name, (repo, revision, expected) in SOURCES.items():
        archive = archives / f"{name}-{revision}.tar.gz"
        if not archive.is_file():
            if args.offline:
                raise RuntimeError(f"Missing prepared {name} archive")
            url = f"https://codeload.github.com/{repo}/tar.gz/{revision}"
            with urllib.request.urlopen(url, timeout=60) as response:
                archive.write_bytes(response.read())
        if sha256(archive) != expected:
            raise RuntimeError(f"{name} source archive checksum mismatch")
    selected = Path(
        subprocess.check_output(
            ["west", "list", "-f", "{abspath}", "zmk-west-commands"], text=True
        ).strip()
    )
    head = subprocess.check_output(
        ["git", "-C", str(selected), "rev-parse", "HEAD"], text=True
    ).strip()
    dirty = subprocess.check_output(
        ["git", "-C", str(selected), "status", "--porcelain", "--untracked-files=no"],
        text=True,
    )
    if head != WEST_COMMANDS or dirty:
        raise RuntimeError("Prepare with the selected pinned West commands")
    sys.path.insert(0, str(selected / "scripts/lib/renode"))
    harness = importlib.import_module("renode_harness")
    os.environ["RENODE_ROOT"] = str(args.renode_root)
    binary = args.renode_root / VERSION / "renode"
    if not binary.is_file():
        if args.offline:
            raise RuntimeError("Renode is not prepared; run prepare online first")
        installed = harness.find_or_install_renode(version=VERSION)
        if not installed:
            raise RuntimeError("Pinned Renode installation failed")
        binary = Path(installed)
    reported_version = subprocess.check_output([str(binary), "--version"], text=True)
    if not re.search(r"^Renode v?1\.16\.1(?:[.\s(]|$)", reported_version):
        raise RuntimeError("The selected emulator is not Renode 1.16.1")
    profile.mkdir(parents=True)
    for name, (_, revision, _) in SOURCES.items():
        destination = profile / name
        destination.mkdir()
        with tarfile.open(archives / f"{name}-{revision}.tar.gz") as archive:
            for member in archive.getmembers():
                parts = member.name.split("/", 1)
                if len(parts) == 2 and parts[1]:
                    member.name = parts[1]
                    archive.extract(member, destination, filter="data")
    with (profile / "prepare.log").open("w") as log:

        def run(command, **kwargs):
            subprocess.run(
                command, check=True, stdout=log, stderr=subprocess.STDOUT, **kwargs
            )

        run(
            ["git", "apply", "--check", str(HERE / "renode_spurious_irq.patch")],
            cwd=profile / "tlib",
        )
        run(
            ["git", "apply", str(HERE / "renode_spurious_irq.patch")],
            cwd=profile / "tlib",
        )
        cores = profile / "infrastructure/src/Emulator/Cores"
        if (cores / "tlib").exists():
            (cores / "tlib").rmdir()
        (cores / "tlib").symlink_to(profile / "tlib", target_is_directory=True)
        run(
            [
                "cmake",
                "-S",
                str(cores),
                "-B",
                str(profile / "build"),
                "-G",
                "Ninja",
                "-DTARGET_ARCH=arm-m",
                "-DTARGET_WORD_SIZE=32",
                "-DHOST_ARCH=i386",
                "-DHOST_WORD_SIZE=64",
                "-DCMAKE_BUILD_TYPE=Release",
                f"-DTLIB_COMMIT_SHA={SOURCES['tlib'][1]}",
            ]
        )
        run(["cmake", "--build", str(profile / "build"), "-j", str(args.jobs)])
        loader = profile / "loader"
        loader.mkdir()
        version_map = loader / "symbols.map"
        version_map.write_text(
            "GLIBC_2.2.5 { global: dlopen; dlsym; dlclose; dlerror; local: *; };\n"
        )
        run(
            [
                "cc",
                "-shared",
                "-fPIC",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-Wl,-soname,libdl.so.2",
                f"-Wl,--version-script={version_map}",
                "-o",
                str(loader / "libdl.so.2"),
                str(HERE / "renode_core_loader.c"),
                "-ldl",
            ]
        )
    library = profile / "build/tlib/translate-arm-m-le.so"
    files = [library, loader / "libdl.so.2", binary.resolve()]
    record = {
        "version": VERSION,
        "reported_version": reported_version.strip(),
        "sources": SOURCES,
        "library": str(library),
        "loader": str(loader),
        "renode_root": str(args.renode_root),
        "binary": str(binary.resolve()),
        "files": {str(p): sha256(p) for p in files},
    }
    (profile / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    print("Prepared the pinned Renode CPU backport")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "run"))
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument(
        "--renode-root",
        type=Path,
        default=Path(os.environ.get("RENODE_ROOT", Path.home() / ".renode")),
    )
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--offline", action="store_true")
    args, command = parser.parse_known_args()
    args.cache = args.cache.resolve()
    args.renode_root = args.renode_root.resolve()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    profile = profile_path(args.cache)
    if args.action == "prepare":
        if command:
            parser.error("prepare does not accept a test command")
        prepare(args, profile)
        return
    if command[:1] == ["--"]:
        command = command[1:]
    if command[:2] != ["west", "zmk-renode-test"]:
        parser.error("run requires -- west zmk-renode-test ...")
    for index, argument in enumerate(command):
        if argument == "--renode-version" and command[index + 1 : index + 2] != [
            VERSION
        ]:
            parser.error(f"The prepared CPU backport requires Renode {VERSION}")
        if (
            argument.startswith("--renode-version=")
            and argument.split("=", 1)[1] != VERSION
        ):
            parser.error(f"The prepared CPU backport requires Renode {VERSION}")
    record = validate(profile)
    env = dict(
        os.environ,
        RENODE_ROOT=record["renode_root"],
        ZMK_RENODE_BINARY=record["binary"],
        ZMK_RENODE_TLIB=record["library"],
        ZMK_RENODE_LOADER_DIR=record["loader"],
        LD_LIBRARY_PATH=record["loader"] + ":" + os.environ.get("LD_LIBRARY_PATH", ""),
    )
    raise SystemExit(subprocess.run(command, env=env).returncode)


if __name__ == "__main__":
    main()
