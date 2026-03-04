---
name: cocos-general
description: General Cocos workflow skill. V1 focuses on stable prefab creation from an internal template, then validation before opening in Cocos Creator.
---

# Cocos General

General entry for Cocos development workflows.

V1 implementation scope is intentionally narrow: **Prefab Creation** first, with validation utilities attached.

## Core Usage
1. Create prefab from the built-in stable template.
2. Validate `__id__` graph before opening in Cocos.
3. Open in Cocos Creator and continue Inspector binding.

Use this trigger:
- `$cocos-general`

## Module A: Prefab Creation (V1 Implemented)

Primary command:

```bash
node skills/cocos-general/scripts/create-prefab-from-template.mjs --output <path/to/new.prefab>
```

CLI contract:
- `--output <path>` required output prefab path.
- `--name <nodeName>` optional root node name (default: output file name).
- `--template <path>` optional custom template path (default: internal template).
- `--with-meta` optional emit `<prefab>.meta` (default: no meta).
- `--backup-suffix <fmt>` optional suffix format for backup when overwriting. Use `{timestamp}` token.

Behavior:
- Uses `assets/templates/node.prefab` as the default source.
- If output exists, script creates backup first, then overwrites.
- Keeps structure minimal and openable (`cc.Prefab`, root `cc.Node`, `cc.PrefabInfo`).

## Validation & UUID Utilities

Validate prefab ids:

```bash
node skills/cocos-general/scripts/validate-prefab-ids.mjs <path-to-prefab>
```

Compress script component uuid:

```bash
node skills/cocos-general/scripts/compress-uuid.mjs <uuid>
```

## Stability Notes
- Avoid hand-writing prefab object arrays unless absolutely needed.
- Keep all `__id__` references in range, especially after manual insert/remove.
- Strip BOM before JSON parse in automation scripts.
- Script component `__type__` must use compressed UUID from `.meta`, not raw UUID.

## References
- Quick start (Chinese): [references/quickstart.zh-CN.md](./references/quickstart.zh-CN.md)
- Module index: [references/module-index.md](./references/module-index.md)
- Deep prefab repair checklist: [references/prefab-rebuild-checklist.md](./references/prefab-rebuild-checklist.md)
