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
- `!saveArea <name> <x1> <y1> <z1> <x2> <y2> <z2>` — capture a box of the
  live world and write it into this folder as a real `<name>.litematic`, so it
  can be listed, quoted, rebuilt, or opened in the Litematica mod

If materials run out, the build pauses, remembers its position, and continues
where it left off when you run `!buildSchematic <name>` again after gathering.

## Capturing builds from the world

`!saveArea` is the inverse of building: pick two opposite corners of a box
(order doesn't matter) and the bot writes every block — including block-state
properties like stair orientation — into a gzip-compressed `.litematic` with a
proper block-state palette and packed bit arrays. Captures are capped
(262144 blocks / 256 per edge by default) so a mistyped coordinate can't
produce a gigabyte file. The saved build immediately shows up in `!listBuilds`
and can be rebuilt elsewhere with `!buildSchematic`.

## Tips

- Blocks from newer Minecraft versions than the server are skipped and reported
  (check the `!buildMaterials` output).
- Blocks without an inventory item (farmland, portals, technical blocks) are
  skipped — prepare those by hand.
- Properties like stair direction or rotation variants aren't placed
  perfectly yet; the right block material is placed, orientation may differ.
- Large builds should use explicit coordinates.
