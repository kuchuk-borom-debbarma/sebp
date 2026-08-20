#!/usr/bin/env python3
"""Rebuild the sebp Pad workspace from the JSON snapshot in this directory.

Reads collections.json plus the per-collection item files and replays them
through the `pad` CLI. Safe to re-run: anything already present is skipped.

Usage:
    ./restore.py [--dry-run] [--yes] [--skip-template] [--export-dir DIR]

See README.md in this directory for what the snapshot does and does not cover.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

ITEM_FILES = ["docs", "conventions", "playbooks"]


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def run(args, stdin=None):
    """Run a pad command, returning (ok, output)."""
    proc = subprocess.run(
        args, input=stdin, capture_output=True, text=True
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, out.strip()


def load(export_dir, name):
    path = export_dir / f"{name}.json"
    if not path.exists():
        die(f"missing {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        die(f"{path} is not valid JSON: {e}")


def bootstrap():
    ok, out = run(["pad", "bootstrap", "--format", "json"])
    if not ok:
        die(
            "`pad bootstrap` failed. A workspace must exist and be linked before\n"
            "       restoring. Run `pad init` (first time on this machine) or\n"
            "       `pad workspace init sebp`, then re-run this script.\n\n"
            f"       pad said: {out}"
        )
    return json.loads(out)


def field_args(item):
    """Turn the item's stored `fields` blob into repeatable --field flags."""
    raw = item.get("fields") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = {}
    args = []
    for key, value in sorted(raw.items()):
        if value is None or value == "":
            continue
        # JSON-typed fields (e.g. a playbook's `arguments`) round-trip as JSON.
        if not isinstance(value, str):
            value = json.dumps(value, separators=(",", ":"))
        args += ["--field", f"{key}={value}"]
    return args


def restore_collections(export_dir, existing_slugs, dry_run):
    created = skipped = 0
    for col in sorted(load(export_dir, "collections"), key=lambda c: c.get("sort_order", 0)):
        slug = col["slug"]
        if slug in existing_slugs:
            print(f"  = collection {slug} (exists)")
            skipped += 1
            continue

        args = ["pad", "collection", "create", col["name"]]
        if col.get("icon"):
            args += ["--icon", col["icon"]]
        if col.get("description"):
            args += ["--description", col["description"]]
        if col.get("schema"):
            args += ["--schema", json.dumps(col["schema"], separators=(",", ":"))]

        if dry_run:
            print(f"  + collection {slug} (dry-run)")
            created += 1
            continue

        ok, out = run(args)
        if not ok:
            print(f"  ! collection {slug} FAILED: {out}", file=sys.stderr)
            continue

        # Prefix is derived from the name on create; restore the original.
        if col.get("prefix"):
            run(["pad", "collection", "update", slug, "--prefix", col["prefix"]])
        print(f"  + collection {slug}")
        created += 1
    return created, skipped


def existing_titles(slug):
    ok, out = run(["pad", "item", "list", slug, "--all", "--format", "json"])
    if not ok:
        return set()
    try:
        return {i.get("title") for i in json.loads(out)}
    except json.JSONDecodeError:
        return set()


def restore_items(export_dir, skip_template, dry_run):
    items = []
    for name in ITEM_FILES:
        items += load(export_dir, name)

    if skip_template:
        items = [i for i in items if i.get("source") != "template"]

    # seq is workspace-global and drives issue-ID assignment. Restoring in this
    # order into an empty workspace reproduces the original refs (DOC-8, ...).
    items.sort(key=lambda i: i.get("seq") or 0)

    seen = {}
    created = skipped = failed = 0
    for item in items:
        slug = item["collection_slug"]
        if slug not in seen:
            seen[slug] = existing_titles(slug)

        title = item["title"]
        ref = item.get("ref", "?")
        if title in seen[slug]:
            print(f"  = {ref:<10} {title[:58]} (exists)")
            skipped += 1
            continue

        args = ["pad", "item", "create", slug, title] + field_args(item)
        content = item.get("content") or ""
        if content:
            args.append("--stdin")

        if dry_run:
            print(f"  + {ref:<10} {title[:58]} (dry-run)")
            created += 1
            continue

        ok, out = run(args, stdin=content if content else None)
        if not ok:
            print(f"  ! {ref:<10} {title[:58]} FAILED: {out}", file=sys.stderr)
            failed += 1
            continue

        seen[slug].add(title)
        print(f"  + {ref:<10} {title[:58]}")
        created += 1
    return created, skipped, failed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be created without touching the workspace")
    ap.add_argument("--yes", "-y", action="store_true",
                    help="skip the confirmation prompt")
    ap.add_argument("--skip-template", action="store_true",
                    help="restore only user/agent-created items, not template seeds "
                         "(note: this shifts issue IDs)")
    ap.add_argument("--export-dir", type=pathlib.Path,
                    default=pathlib.Path(__file__).resolve().parent,
                    help="directory holding the snapshot JSON (default: alongside this script)")
    args = ap.parse_args()

    if not shutil.which("pad"):
        die("`pad` not found on PATH. Install the Pad CLI first.")

    boot = bootstrap()
    ws = boot.get("workspace", {})
    collections = boot.get("collections", [])
    item_total = sum(c.get("item_count", 0) for c in collections)

    print(f"\nTarget workspace : {ws.get('name')} ({ws.get('slug')})")
    print(f"Existing items   : {item_total}")
    print(f"Snapshot dir     : {args.export_dir}")
    if args.dry_run:
        print("Mode             : DRY RUN — nothing will be written")
    print()

    if item_total > 0 and not args.dry_run:
        print("This workspace already contains items. Matching titles will be skipped,")
        print("but restored items will NOT get their original issue IDs.\n")

    if not args.yes and not args.dry_run:
        if input("Proceed? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return 1

    print("\nCollections")
    existing = {c["slug"] for c in collections}
    c_created, c_skipped = restore_collections(args.export_dir, existing, args.dry_run)

    print("\nItems")
    i_created, i_skipped, i_failed = restore_items(
        args.export_dir, args.skip_template, args.dry_run)

    print(f"\nCollections : {c_created} created, {c_skipped} already present")
    print(f"Items       : {i_created} created, {i_skipped} already present, {i_failed} failed")
    if i_failed:
        print("\nSome items failed — see errors above.")
        return 1
    print("\nDone. Run `pad project dashboard` to inspect the workspace.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
