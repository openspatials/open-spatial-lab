# Extension host fixtures: provenance

The three `.wasm` files and `stool-map.json` come from public RP1 repositories of Metaversal Corporation, all under
the Apache License 2.0, whose text is the `LICENSE` file at the repository root. They are copied unchanged. `test-modules.mjs` is written for this repository and builds its modules from bytes. `net-server.mjs`
(the test server of the network cases) is also written for this repository. Nothing under `src/fixtures/` goes into a
site package.

Upstream repositories and commits:

- Sneeze, https://github.com/MetaversalCorp/Sneeze, commit `986fc4cb3da8`
- SneezeSDK, https://github.com/MetaversalCorp/SneezeSDK, commit `44d0346fe22a`
- SneezeSDK_Rust, https://github.com/MetaversalCorp/SneezeSDK_Rust, commit `4e7d0800f7ae`
- SneezeDoc, https://github.com/MetaversalCorp/SneezeDoc, commit `8e26da5637e7`

Toolchain for every `.wasm` file: rustc 1.95.0 (59807616e 2026-04-14), cargo 1.95.0, target
`wasm32-unknown-unknown`, `cargo build --release`.

## quickstart.wasm

- Source: the Rust quickstart in `docs/quickstart.md` of SneezeSDK `44d0346fe22a`, built against the `sneeze` crate
  0.2.0 of SneezeSDK_Rust `4e7d0800f7ae`.
- Size: 93,840 bytes.
- SHA-256: `3dfea8fb0d2447ac2c6a2989eed9f04f34505a384543a1e00526d319aa52ddbb`
- Imports: `Sneeze.Call`.
- Behavior the checks rely on: logs `hello from wasm` and creates one Physical (class 73) root node named `Stool` with
  the reference `assets/Stool.glb`.

## map.wasm

- Source: `tools/wasm/map` of Sneeze `986fc4cb3da8`, with its dependency moved from `sneeze` 0.1.2 to `sneeze` 0.2.0
  from crates.io and its `Open`/`Close` moved to the 0.2.0 `HOST` handle.
- Size: 94,082 bytes.
- SHA-256: `d36685f9f4757e9c7255a7ee138dca5a0d8fb3475df27a038f29fd935550a763`
- Imports: `Sneeze.Call`.
- Behavior the checks rely on: in `Open` it calls FABRIC NODE_MAP_DATA with the path `Scene`. RP1's engine host,
  given `stool-map.json`, logged `[MAP] Injected 1 nodes` and loaded `assets/Stool.glb`.

## sneezedoc-map.wasm

- Source: `examples/wasm/map` of SneezeDoc `8e26da5637e7` (published as `map.wasm`).
- Size: 17,109 bytes.
- SHA-256: `8f113c60cc5fcddc2a0a46b5531b114851576f6411f430afa77c19c7523f3353`
- Imports: `Console.Log` and `Scene.Node_Map`, the legacy interface. The host must refuse it.

## stool-map.json

- Source: the one-node stool fabric that ran `map.wasm` in RP1's engine host (Sneeze `986fc4cb3da8`).
- SHA-256: `23d75dfb8d2094b0232cfd3754d232943d93f8a6b8af43b8519fd47a0bba0bf9`
- Content: a `Data.Scene` node `{ "Head": { "Self": "P-?" }, "Name": "Stool", "Resource": { "sReference": "assets/Stool.glb" } }`.

## world/

The extension test world, opened only by URL (it is not in the worlds list).

- `world/extension-world.json`: written for this repository. Five nodes carry `webofworlds_extension.universal_extensions`:
  `rp1-stool` (`../quickstart.wasm`, binding `rp1-sneeze-call`), `ue-box` (`box-maker.wasm`, binding `ue-core/0`, under
  the node `shelf`), `bad-hash` (`box-maker.wasm` with the integrity of other bytes), `wants-panel` (`box-maker.wasm`,
  also requesting `ue.ui.panel`) and `runaway` (the `ue-core/0` module whose Init loops for ever, as a `data:` URL,
  `limits.initMs` 300).
- `world/box-maker.wasm`: written once from `UE_TEST_MODULES.ueNodeMaker({ resource: "../../../assets/equip-mug.glb" })`
  in `test-modules.mjs` (the `ue-core/0` node maker: Open makes the node `Box`, kind `mesh`, resource
  `../../../assets/equip-mug.glb`, under the attachment root). The resource resolves against the world file's URL, so
  from `/fixtures/extension-host/world/` it is the Lab's own `/assets/equip-mug.glb` (`web/assets/equip-mug.glb`), and
  the Box node shows a real model. The RP1 Stool still names `assets/Stool.glb`, which is not shipped.
  - Size: 844 bytes.
  - SHA-256: `27e304b6aabc1b813011b6396baba289079415301777d4f86925fa02232c1ea9`
  - SRI: `sha256-J+MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk=` (the integrity of `ue-box` and `wants-panel`)
- The `runaway` module is `UE_TEST_MODULES.ueLoopsForever()` (633 bytes), SRI `sha256-SQcotusXLXZqhSqTGrgekxoIrd/um8iaGmncspt3J30=`.

### The Step 5a world

- `world/extension-world-5a.json`: written for this repository. Three nodes carry
  `webofworlds_extension.universal_extensions` with `interface` `ue:host@0.2.0` and a `purposes` text for each prompted
  token: `fetcher` (`fetcher.wasm`, requests `ue.network.fetch:http://127.0.0.1:18353`, data `fetch` the GET of
  `/slow`), `storage-user` (`storage-user.wasm`, requests `ue.storage.local`; its purpose holds an
  `<img src=x onerror=...>` that must show as text) and `pointer-listener` (`pointer-listener.wasm`, requests
  `ue.input.pointer`). The origin `http://127.0.0.1:18353` names the test server; `src/wow-extension-mount-browser-check.mjs`
  serves the file with its own test server origin in its place. `extension-world.json` is unchanged.
- `world/fetcher.wasm`: `UE_TEST_MODULES.ueFetcher({ every: 500 })` (Open fetches once and sets a 500 ms repeating
  timer; each timer event fetches again). 913 bytes, SHA-256
  `fe5231d9d37e8e158ae81d92ce532966a76dbe8e2bc2619862eefc63b6d7cd48`, SRI
  `sha256-/lIx2dN+jhWK6B2SzlMpZqdtvo4rwmGYYu78Y7bXzUg=`.
- `world/storage-user.wasm`: `UE_TEST_MODULES.ueStorageUser()`. 928 bytes, SHA-256
  `4d7f6e2beb622ce1280a824c3fe6f5a838caed398a060e6261ee05861250f9b2`, SRI
  `sha256-TX9uK+tiLOEoCoJMP+b1qDjK7TmKBg5iYe4FhhJQ+bI=`.
- `world/pointer-listener.wasm`: `UE_TEST_MODULES.uePointerListener({ resource: "../../../assets/equip-mug.glb" })`
  (Open makes the node `Box`; Notify logs `notified`). 865 bytes, SHA-256
  `70278d9f15eda41656c1d7fd391f64250ef7039dd24da5d757627f5d754ab091`, SRI
  `sha256-cCeNnxXtpBZWwdf9OR9kJQ73A53STaXXV2J/XXVKsJE=`.

## carrier-without-profile.json and carrier.mjs

- `carrier-without-profile.json` is a byte copy of the Universal Extensions profile fixture
  `docs/universal-extensions/fixtures/carrier-without-profile.json` of the SCRAP project (made by its `make-fixtures.mjs`),
  kept here so the discovery check reads it from inside the code folder. Size 1,629 bytes, SHA-256
  `0c2940a7fa766d700aa7c9032d490bd8b87c7fc21fbabb79571ac7bd79435061`.
- `carrier.mjs` is written for this repository. It signs carrier manifests for the checks with a key made per run.
