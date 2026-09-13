# Schematic build library

Drop building files into this folder and the bot can browse them, quote
material lists, and build them block by block.

## Supported formats

| Extension | Format | Notes |
|---|---|---|
| `.litematic` | [Litematica](https://github.com/maruohon/litematica) mod | full block-state palettes, packed data; multi-region builds supported |
| `.schem` | Sponge / WorldEdit v2+ | also the format [Baritone](https://github.com/cabaletta/baritone) builds natively |
| `.nbt` | Vanilla structure block templates | "Save" in a structure block, find the file in `saves/<world>/generated/` |
| `.json` | mindcraft blueprints | the simple `{name, offset, blocks:[y][z][x]}` format from `src/agent/npc/construction` |

The classic MCEdit/Schematica `.schematic` format (numeric pre-1.13 block ids)
is **not** supported — re-save it as `.schem` (WorldEdit `//schematic save`)
or `.litematic` first.

## Commands

- `!listBuilds` — browse the library: name, format, dimensions, block count, main materials
- `!buildMaterials <name>` — full material list and dimensions before gathering
- `!buildSchematic <name>` — build next to the bot on flat ground
- `!buildSchematic <name> <x> <y> <z> <rotation>` — build at explicit world
  coordinates (corner = ground level), `rotation` is 0–3 (90° steps)

If materials run out, the build pauses, remembers its position, and continues
where it left off when you run `!buildSchematic <name>` again after gathering.

## Tips

- Blocks from newer Minecraft versions than the server are skipped and reported
  (check the `!buildMaterials` output).
- Blocks without an inventory item (farmland, portals, technical blocks) are
  skipped — prepare those by hand.
- Properties like stair direction or rotation variants aren't placed
  perfectly yet; the right block material is placed, orientation may differ.
- Large builds should use explicit coordinates.
