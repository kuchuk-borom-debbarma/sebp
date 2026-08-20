# Pad workspace export

A point-in-time snapshot of the `sebp` Pad workspace, committed so the workspace's
content survives independently of Pad's local store.

`../../.pad.toml` only records *which* workspace this directory is linked to. It
contains no items. These files are the actual backup.

## Contents

| File | Contents |
|---|---|
| `collections.json` | Collection definitions and field schemas (6) |
| `docs.json` | Documentation items with full bodies (2) |
| `conventions.json` | Project rules agents load before working (4) |
| `playbooks.json` | Invokable multi-step workflows (3) |

## Regenerating

```sh
mkdir -p docs/pad-export
pad collection list --format json > docs/pad-export/collections.json
for c in docs conventions playbooks; do
  pad item list "$c" --all --format json --full > "docs/pad-export/$c.json"
done
```

## Restoring

There is no single-command import. To rebuild a workspace from this snapshot:

1. `pad workspace init sebp` to create and link the workspace.
2. Recreate collections from `collections.json` using `pad collection create --schema`.
3. Recreate items with `pad item create <collection> "<title>" --field ... --stdin`,
   feeding each item's `content` on stdin.

Issue IDs (`DOC-8`, `CONVE-1`, …) are assigned sequentially on creation and will
**not** be preserved unless items are recreated in their original `seq` order.

## Staleness

This is a snapshot, not a sync. It reflects the workspace at export time and does
not update when Pad items change. Re-run the regeneration commands before relying
on it.

The two documentation items here also exist as markdown at `docs/technical-design.md`
and `docs/platform-overview.md`. Those files are the source of truth; this export
is a backup of the Pad copy.
