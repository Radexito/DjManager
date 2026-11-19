"""Copy the ONNX and SavedModel files out of a rekordbox installation.

The models are Pioneer's property and are not distributed with DjManager. This
tool reads them from a licensed, installed copy of rekordbox, verifies them
against the known hashes and writes a manifest that DjManager reads at runtime.

Usage:

    extract-models.py                          # auto-detect the installation
    extract-models.py --source "C:/Program Files/rekordbox/rekordbox 7.2.19"
    extract-models.py --dest ~/.local/share/djmanager/models
    extract-models.py --check --dest ...       # verify an existing copy only

Exit codes: 0 all files present and verified, 1 files missing or different.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sys
from pathlib import Path

MANIFEST_NAME = "models.manifest.json"

KNOWN_SHA256 = {
    "detect_beat/model7/keras_metadata.pb":
        "41B7D1C17876465B4BBE240E999D9D1E3E0687FF467A42488654F1E87BCC6B55",
    "detect_beat/model7/saved_model.pb":
        "EA7B5E7C3567525BB9B0EFF1238C13B9D4AB8336399E0F2DD3301528A9DC936A",
    "detect_beat/model7/variables/variables.data-00000-of-00001":
        "7DDBBFAF22FEAB99687D8FDC6E1F72B46E3937B7A4E006E320BE8888D85B2E4C",
    "detect_beat/model7/variables/variables.index":
        "8C5864C2E5AE076117AC7FBBE2FE090D0983801238B837525425A5233A9804AF",
    "detect_beat/model8/keras_metadata.pb":
        "89D63710656F1858BD78266E6449E14EF740F03046186F8926A0BB8ACC4528CF",
    "detect_beat/model8/saved_model.pb":
        "09BAF025FB561D27264A6F26522E12037FD2F37BF1DB378C7EDF9366116C49DD",
    "detect_beat/model8/variables/variables.data-00000-of-00001":
        "EC2CEF99D55076B46EC54DD4F51C0BD2D8E8344AEAF96A85166E9062B014604E",
    "detect_beat/model8/variables/variables.index":
        "F3041D936E049D5CB4C206C58F9298BA131E247DCAC4F2E696255A706DF34FA1",
    "detect_cue_model/cue_prediction_model_no_abs_position.onnx":
        "288305D581E941E5DBDE32BACE4F3F71BC651C03621D422C6B4BF17EB04E8BD7",
    "detect_cue_model/samplecnn.onnx":
        "3EB5D897A615D84727D48EE94DDEC48370D674548FADCF8A93FAFD1FF0A02BFC",
    "embed_model/cnn_embedding.onnx":
        "27D9AD6E13C077F0C0A20CD786B0C746312AEBFC1063F56011DEFDC10E574C4E",
    "embed_model/model_energy.onnx":
        "C6818A83050BEECBB4E701E5092A9670AC74CA787F505BF79797B2EBA6F5B69B",
    "embed_model/model_genre.onnx":
        "485FD89FEE2047C09B7BB2D70F19D0A870F8DAB7F5B3B75E8A71CE1ECAD2E52A",
    "embed_model/norm_after_umap.onnx":
        "4FE1A26467CE24EB144AD6ACB4307ABFD6F64143F40D781B03A8496236E25AA2",
    "embed_model/norm_before_umap.onnx":
        "9C5B7C9866E77DA5D68725D6244CB5C41004F9E7849C5EDD404128AABD237BB2",
    "embed_model/umap_embedder.onnx":
        "BA50CC71849FFEF6C1EB6D7FB4E46B56094C4E7E3F092B74C831741ACC583323",
}

FAMILIES = {
    "detect_beat": ("tensorflow-savedmodel", "tensorflow",
                    "beat grid detection, model7 and model8"),
    "detect_cue_model": ("onnx", "onnxruntime", "cue point prediction"),
    "embed_model": ("onnx", "onnxruntime",
                    "track embeddings: cnn, energy, genre, umap normalisation"),
}

ONNX_TENSOR_TYPES = {
    1: "float32", 2: "uint8", 3: "int8", 4: "uint16", 5: "int16", 6: "int32",
    7: "int64", 8: "string", 9: "bool", 10: "float16", 11: "double",
    12: "uint32", 13: "uint64", 14: "complex64", 15: "complex128",
}

def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = 0
    value = 0
    while True:
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")

def _fields(buf: bytes):
    """Yield (field_number, wire_type, value) for a protobuf message."""
    i = 0
    n = len(buf)
    while i < n:
        key, i = _varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 2:
            length, i = _varint(buf, i)
            value = buf[i:i + length]
            i += length
        elif wire == 5:
            value = buf[i:i + 4]
            i += 4
        elif wire == 1:
            value = buf[i:i + 8]
            i += 8
        else:
            raise ValueError(f"unsupported wire type {wire}")
        yield field, wire, value

def _text(value: bytes) -> str:
    return value.decode("utf-8", "replace")

def _shape(type_proto: bytes) -> list:
    """Read the dims out of a TypeProto, returning [] when it is not a tensor."""
    dims = []
    for field, wire, value in _fields(type_proto):
        if field != 1 or wire != 2:
            continue
        for f2, w2, v2 in _fields(value):
            if f2 != 2 or w2 != 2:
                continue
            for f3, w3, v3 in _fields(v2):
                if f3 != 1 or w3 != 2:
                    continue
                size = None
                for f4, w4, v4 in _fields(v3):
                    if f4 == 1:
                        size = v4
                    elif f4 == 2:
                        size = _text(v4)
                dims.append(size if size is not None else "?")
    return dims

def _value_infos(graph: bytes, wanted: int) -> list:
    """GraphProto.input (11) or .output (12), as name/type/shape."""
    out = []
    for field, wire, value in _fields(graph):
        if field != wanted or wire != 2:
            continue
        name, dtype, dims = "", None, []
        for f2, w2, v2 in _fields(value):
            if f2 == 1 and w2 == 2:
                name = _text(v2)
            elif f2 == 2 and w2 == 2:
                for f3, w3, v3 in _fields(v2):
                    if f3 == 1 and w3 == 2:
                        for f4, w4, v4 in _fields(v3):
                            if f4 == 1:
                                dtype = ONNX_TENSOR_TYPES.get(v4, v4)
                            elif f4 == 2:
                                dims = _shape(v2)
        out.append({"name": name, "type": dtype, "shape": dims})
    return out

def read_onnx(path: Path) -> dict:
    """Return the parts of an ONNX ModelProto that matter for feeding it."""
    data = path.read_bytes()
    info = {"ir_version": None, "producer": None, "opset": [], "graph": None,
            "inputs": [], "outputs": [], "nodes": 0}
    for field, wire, value in _fields(data):
        if field == 1:
            info["ir_version"] = value
        elif field == 2 and wire == 2:
            info["producer"] = _text(value)
        elif field == 7 and wire == 2:
            nodes = 0
            for f2, w2, v2 in _fields(value):
                if f2 == 1 and w2 == 2:
                    nodes += 1
                elif f2 == 2 and w2 == 2:
                    info["graph"] = _text(v2)
            info["nodes"] = nodes
            info["inputs"] = _value_infos(value, 11)
            info["outputs"] = _value_infos(value, 12)
        elif field == 8 and wire == 2:
            domain, version = "", None
            for f2, w2, v2 in _fields(value):
                if f2 == 1 and w2 == 2:
                    domain = _text(v2)
                elif f2 == 2:
                    version = v2
            info["opset"].append({"domain": domain or "ai.onnx", "version": version})
    return info

def default_dest() -> Path:
    override = os.environ.get("DJMANAGER_MODELS_DIR")
    if override:
        return Path(override).expanduser()
    system = platform.system()
    if system == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        return base / "DjManager" / "models"
    if system == "Darwin":
        return Path.home() / "Library/Application Support/DjManager/models"
    return Path.home() / ".local/share/djmanager/models"

def default_sources() -> list:
    system = platform.system()
    if system == "Windows":
        roots = [Path(r"C:/Program Files/rekordbox"),
                 Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "rekordbox"]
    elif system == "Darwin":
        roots = list(Path("/Applications").glob("rekordbox*.app/Contents"))
    else:
        roots = [Path.home() / ".wine/drive_c/Program Files/rekordbox",
                 Path("/opt/rekordbox")]
    return [r for r in roots if r.exists()]

def _version_key(path: Path) -> tuple:
    """Sort candidate installs newest first, by the numbers in their path."""
    numbers = []
    for part in path.parts:
        for token in part.replace("-", " ").replace("_", " ").split():
            try:
                numbers.append(int(token.replace(".", "")))
            except ValueError:
                continue
    return tuple(numbers) or (0,)

def find_model_dirs(source: Path | None) -> list:
    """Every directory that looks like a rekordbox models directory."""
    candidates = []
    if source is not None:
        source = source.expanduser().resolve()
        if not source.exists():
            raise SystemExit(f"source does not exist: {source}")
        pool = [source] + [p for p in source.rglob("models") if p.is_dir()]
    else:
        pool = []
        for root in default_sources():
            pool.append(root)
            pool += [p for p in root.rglob("models") if p.is_dir()]
    for path in pool:
        names = {p.name for p in path.iterdir() if p.is_dir()} if path.is_dir() else set()
        if names & set(FAMILIES):
            candidates.append(path)
    return sorted(set(candidates), key=_version_key, reverse=True)

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()

def classify(rel: str) -> tuple:
    family = rel.split("/", 1)[0]
    return FAMILIES.get(family, ("unknown", "unknown", ""))

def build_manifest(root: Path, dest: Path) -> dict:
    files = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        kind, runtime, purpose = classify(rel)
        entry = {
            "path": rel,
            "size": path.stat().st_size,
            "sha256": sha256(path),
            "kind": kind,
            "runtime": runtime,
            "purpose": purpose,
        }
        if kind == "onnx":
            try:
                entry["onnx"] = read_onnx(path)
            except Exception as error:
                entry["onnx_error"] = f"{type(error).__name__}: {error}"
        files.append(entry)
    return {
        "format": 1,
        "generated_by": "scripts/extract-models.py",
        "source": {"root": str(root), "files": len(files)},
        "dest": str(dest),
        "files": files,
    }

def copy_tree(root: Path, dest: Path) -> int:
    copied = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        target = dest / path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied += 1
    return copied

def verify(dest: Path, manifest: dict, strict: bool) -> list:
    problems = []
    for entry in manifest["files"]:
        target = dest / entry["path"]
        if not target.exists():
            problems.append(f"missing: {entry['path']}")
            continue
        actual = sha256(target)
        if actual != entry["sha256"]:
            problems.append(f"changed: {entry['path']} {actual[:16]}")
        known = KNOWN_SHA256.get(entry["path"])
        if strict and known and actual != known:
            problems.append(f"not the known build: {entry['path']}")
    return problems

def describe(manifest: dict) -> str:
    lines = [f"{len(manifest['files'])} files, "
             f"{sum(f['size'] for f in manifest['files']) / 1e6:.1f} MB"]
    for entry in manifest["files"]:
        extra = ""
        onnx = entry.get("onnx")
        if onnx:
            ins = ", ".join(
                f"{i['name']}[{', '.join(str(d) for d in i['shape']) or '?'}]"
                for i in onnx["inputs"])
            extra = f"  in: {ins}"
            if onnx["opset"]:
                extra += f"  opset {onnx['opset'][0]['version']}"
        lines.append(f"  {entry['size']:>11,}  {entry['path']}{extra}")
    return "\n".join(lines)

def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=None,
                        help="rekordbox installation, or a models directory")
    parser.add_argument("--dest", type=Path, default=None,
                        help="where to put the models (default: %s)" % default_dest())
    parser.add_argument("--check", action="store_true",
                        help="do not copy, only verify what is in --dest")
    parser.add_argument("--strict", action="store_true",
                        help="fail when a file is not the known rekordbox build")
    parser.add_argument("--json", action="store_true", help="print the manifest")
    args = parser.parse_args(argv)

    dest = (args.dest or default_dest()).expanduser()

    if args.check:
        manifest_path = dest / MANIFEST_NAME
        if not manifest_path.exists():
            print(f"no manifest in {dest}; run this tool without --check first")
            return 1
        manifest = json.loads(manifest_path.read_text())
        problems = verify(dest, manifest, args.strict)
        print(describe(manifest))
        if problems:
            print("\n".join(problems))
            return 1
        print("all files verified")
        return 0

    dirs = find_model_dirs(args.source)
    if not dirs:
        where = args.source or "the default locations for " + platform.system()
        print(f"no rekordbox models found under {where}")
        print("pass --source with the rekordbox installation directory")
        return 1
    root = dirs[0]
    copied = copy_tree(root, dest)
    manifest = build_manifest(dest, dest)
    manifest["source"] = {"root": str(root), "files": copied}
    (dest / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n")

    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(describe(manifest))
        print(f"\nfrom {root}\nto   {dest}")

    problems = verify(dest, manifest, args.strict)
    if problems:
        print("\n".join(problems))
        return 1
    print("all files verified")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
