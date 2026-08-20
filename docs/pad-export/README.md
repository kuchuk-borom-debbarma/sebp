# Pad workspace export

Backups of the `sebp` Pad workspace, committed so its content survives
independently of Pad's local store.

Pad runs in **local mode** here: all workspace data lives in `~/.pad/pad.db` on a
single machine and syncs nowhere. `../../.pad.toml` records only *which* workspace
this directory links to — it holds no content. Cloning this repo elsewhere gives
you that pointer and nothing behind it. **These files are the actual backup.**

## Contents

| File | Purpose |
|---|---|
| `workspace-bundle.tar.gz` | **Complete backup.** Collections, items, comments, versions, links, and attachment blobs. One-command restore. |
| `collections.json` | Collection definitions and field schemas (6) — human-readable |
| `docs.json` | Documentation items with full bodies (2) — human-readable |
| `conventions.json` | Project rules agents load before working (4) — human-readable |
| `playbooks.json` | Invokable multi-step workflows (3) — human-readable |
| `restore.py` | Replays the JSON files into an already-linked workspace |

Two formats on purpose. The bundle is complete but opaque — a binary blob whose
changes are invisible in a diff. The JSON files are readable and reviewable, so a
pull request that changes a document shows what changed. Keep both.

## Restoring

### The bundle — use this by default

```sh
pad workspace import docs/pad-export/workspace-bundle.tar.gz --name sebp
```

Creates a **new** workspace with all content intact. Verified byte-exact on a
round-trip test.

Two caveats:

- **All IDs are regenerated.** Issue refs are reassigned on import, so `CONVE-1`
  may come back as `CONVE-4`. Content and titles are preserved; anything that
  cites a ref by number will point at the wrong item.
- **It always creates a new workspace.** There is no merge-into-existing mode.

### The script — for merging into an existing workspace

```sh
./docs/pad-export/restore.py --dry-run     # preview
./docs/pad-export/restore.py               # apply
```

Use when a workspace already exists and you want this content added to it.
Idempotent — skips anything whose title is already present, so re-running is safe.
Restoring into an *empty* workspace reproduces the original issue IDs, because
items are replayed in `seq` order and refs are assigned workspace-sequentially.

Flags: `--dry-run`, `--yes`, `--skip-template`, `--export-dir`.

Requires the `pad` CLI on PATH and a linked workspace — run `pad init` (first time
on a machine) or `pad workspace init sebp` first.

## Regenerating

Both formats are snapshots, not syncs. They do not update when Pad items change.
Re-run after meaningful workspace changes:

```sh
pad workspace export -o docs/pad-export/workspace-bundle.tar.gz

pad collection list --format json > docs/pad-export/collections.json
for c in docs conventions playbooks; do
  pad item list "$c" --all --format json --full > "docs/pad-export/$c.json"
done
```

## What the JSON snapshot does not capture

The bundle covers these; the JSON files do not. Relevant only if you restore via
`restore.py`:

- **Parent/child relationships** — `pad item list` omits parent references
- **Dependencies** — `block` / `blocked-by` links
- **Comments** and item version history
- **Attachments**
- **Roles** — none defined in this workspace yet, so nothing is lost today

## Do not commit `pad.db`

`~/.pad/pad.db` holds **every** workspace on the machine, not just `sebp`. This
repository is public. Use the per-workspace exports here, which carry only this
workspace's data.
