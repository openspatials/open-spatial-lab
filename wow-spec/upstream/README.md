# Vendored upstream sources

Files in this folder are copies of public specifications. They are kept so that tests and patches can
work from the exact text and not from a description of it.

## wowapi-d39a1a0

The Web of Worlds API descriptions from https://github.com/WebOfWorlds/WoWAPI at commit
`d39a1a009aa4ef8fb6d14aa66d588cffb74c33de` ("fixed node children type"), Apache-2.0. The upstream
`LICENSE` is in the folder. The copies are byte for byte what the commit holds. `SOURCE.json` lists the
SHA-256 of each file, and check U1 of `npm run arch-i1-proof` fails if a file changes.

The iteration 1 edits to these files are proposed upstream. They are patches in
`wow-spec/overlays/iteration-1/`, and they never change the copies here.

## geopose

The OGC GeoPose Basic-YPR schema. See `geopose/README.md`.
