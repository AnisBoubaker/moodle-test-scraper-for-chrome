#!/usr/bin/env python3
"""Replace Moodle student names with section-specific labels."""

import argparse
import csv
import io
import json
import os
import re
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile


SECTION = re.compile(r"S[0-9]+-INF155-[0-9]+")
STUDENT_ID = re.compile(r"student ([1-9][0-9]*)")
KEY_HEADER = ["section", "student_id", "student_name"]


@contextmanager
def lock_key(path):
    lock = path.with_name(f".{path.name}.lock")
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ValueError(f"Key is locked by another run: {lock}") from error
    try:
        os.close(descriptor)
        yield
    finally:
        lock.unlink()


def read_key(path):
    key = {}
    if not path.exists():
        return key
    with path.open(encoding="utf-8-sig", newline="") as file:
        rows = csv.reader(file, strict=True)
        if next(rows, None) != KEY_HEADER:
            raise ValueError(f"Invalid anonymization key header: {path}")
        for row in rows:
            if len(row) != 3:
                raise ValueError(f"Invalid anonymization key row {rows.line_num}: {path}")
            section, student_id, name = row
            if (
                not SECTION.fullmatch(section)
                or not STUDENT_ID.fullmatch(student_id)
                or not name.strip()
                or STUDENT_ID.fullmatch(name)
            ):
                raise ValueError(f"Invalid anonymization key row {rows.line_num}: {path}")
            mapping = key.setdefault(section, {})
            if name in mapping or student_id in mapping.values():
                raise ValueError(f"Duplicate name or student ID in section {section}: {path}")
            mapping[name] = student_id
    return key


def read_exports(root):
    if SECTION.fullmatch(root.name):
        sections = [root]
    else:
        sections = sorted(
            folder for folder in root.iterdir()
            if SECTION.fullmatch(folder.name) and folder.is_dir() and not folder.is_symlink()
        )
    exports = []
    for section in sections:
        for path in sorted(section.glob("*.json")):
            if not path.is_file() or path.is_symlink():
                continue
            original = path.read_bytes()
            try:
                data = json.loads(original)
            except (UnicodeError, json.JSONDecodeError) as error:
                raise ValueError(f"Invalid JSON in {path}: {error}") from error
            if not isinstance(data, dict) or "attempts" not in data:
                continue
            if not isinstance(data["attempts"], list):
                raise ValueError(f"Expected an attempts array in {path}")
            for index, attempt in enumerate(data["attempts"], start=1):
                name = attempt.get("student") if isinstance(attempt, dict) else None
                if not isinstance(name, str) or not name.strip():
                    raise ValueError(f"Missing student name in attempt {index} of {path}")
            exports.append((path, original, data))
    if not exports:
        raise ValueError(f"No Moodle exam exports found under {root}")
    return exports


def extend_key(key, exports):
    names_by_section = {}
    for path, _, data in exports:
        names_by_section.setdefault(path.parent.name, set()).update(
            attempt["student"] for attempt in data["attempts"]
        )
    added = 0
    for section, names in names_by_section.items():
        mapping = key.setdefault(section, {})
        used_ids = set(mapping.values())
        existing_ids = {name for name in names if STUDENT_ID.fullmatch(name)}
        if existing_ids - used_ids:
            raise ValueError(f"Section {section} has student IDs missing from the selected key CSV")
        next_id = max((int(label.split()[1]) for label in used_ids), default=0) + 1
        new_names = sorted(names - existing_ids - mapping.keys(), key=lambda name: (name.casefold(), name))
        for name in new_names:
            mapping[name] = f"student {next_id}"
            next_id += 1
        added += len(new_names)
    return added


def key_csv(key):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(KEY_HEADER)
    for section, mapping in sorted(key.items()):
        for name, label in sorted(mapping.items(), key=lambda entry: int(entry[1].split()[1])):
            writer.writerow((section, label, name))
    return stream.getvalue().encode("utf-8")


def write_atomic(path, content, mode):
    temporary = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix=".anonymize-", delete=False) as file:
            temporary = Path(file.name)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def anonymize(root, key_path):
    with lock_key(key_path):
        if key_path.is_symlink():
            raise ValueError(f"Use a regular CSV file as the key: {key_path}")
        key = read_key(key_path)
        exports = read_exports(root)
        added = extend_key(key, exports)
        updates = []
        replaced = 0
        for path, original, data in exports:
            mapping = key[path.parent.name]
            names_changed = 0
            for attempt in data["attempts"]:
                name = attempt["student"]
                if name in mapping:
                    attempt["student"] = mapping[name]
                    names_changed += 1
            if names_changed:
                text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
                updates.append((path, original, text.encode("utf-8")))
                replaced += names_changed

        for path, original, _ in updates:
            if path.is_symlink() or path.read_bytes() != original:
                raise ValueError(f"The export changed while preparing the update: {path}")

        if added or not key_path.exists():
            write_atomic(key_path, key_csv(key), 0o600)
        for path, original, content in updates:
            if path.is_symlink() or path.read_bytes() != original:
                raise ValueError(f"The export changed while preparing the update: {path}")
            write_atomic(path, content, stat.S_IMODE(path.stat().st_mode))
    return len(exports), len(updates), replaced


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "directory", nargs="?", type=Path, default=Path(__file__).resolve().parent,
        help="folder containing the section folders, or a single section folder",
    )
    parser.add_argument("--key", type=Path, help="key CSV path (default: anonymization_key.csv alongside the section folders)")
    args = parser.parse_args()
    root = args.directory.expanduser().resolve()
    key_directory = root.parent if SECTION.fullmatch(root.name) else root
    key_path = args.key.expanduser().absolute() if args.key else key_directory / "anonymization_key.csv"
    if not root.is_dir():
        parser.error(f"Directory does not exist: {root}")
    if key_path.suffix.lower() != ".csv":
        parser.error("The key filename must end in .csv")
    try:
        scanned, updated, replaced = anonymize(root, key_path)
    except (OSError, ValueError, csv.Error) as error:
        print(f"Anonymization stopped: {error}", file=sys.stderr)
        return 1
    print(f"Checked {scanned} exports. Replaced {replaced} student names in {updated} files.")
    print(f"Key CSV: {key_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
