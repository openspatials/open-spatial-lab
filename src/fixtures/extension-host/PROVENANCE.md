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
  also requesting `ue.ui.panel`, which the Lab grants by host policy, and `ue.input.pointer`, which needs consent) and `runaway` (the `ue-core/0` module whose Init loops for ever, as a `data:` URL,
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

### The place world

- `world/place-world.json`: written for this repository. At world level its `webofworlds_extension` names a place store
  (`extension_store`, `place-store/`) and a withdrawn list (`extension_status_list`, `place-withdrawn.json`), both on the
  world file's own origin. Its modules' own addresses are on the maker origin `http://maker.test`, which no check
  serves: a request there is what the checks look for. Nodes: `place-box` (`box-maker.wasm`, copy in the store),
  `listener` (`pointer-listener.wasm`, copy in the store), `maker-only` (`storage-user.wasm`, no copy in the store),
  `carried-unlisted` and `carried-withdrawn` (carrier manifests `carriers/unlisted.json` and `carriers/withdrawn.json`,
  which the checks sign per run; the second has the @id `urn:uuid:place-carrier-withdrawn`).
- `world/place-store/sha256-J-MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk.wasm`: a byte copy of `world/box-maker.wasm`
  (844 bytes, SHA-256 `27e304b6aabc1b813011b6396baba289079415301777d4f86925fa02232c1ea9`), named after its
  `module.integrity` in base64url without padding.
- `world/place-store/sha256-cCeNnxXtpBZWwdf9OR9kJQ73A53STaXXV2J_XXVKsJE.wasm`: a byte copy of
  `world/pointer-listener.wasm` (865 bytes, SHA-256 `70278d9f15eda41656c1d7fd391f64250ef7039dd24da5d757627f5d754ab091`).
- `world/place-withdrawn.json`: written for this repository. `checkedAt` and one entry: `urn:uuid:place-carrier-withdrawn`
  is `revoked`.

### The panel world

- `world/extension-world-panel.json`: written for this repository. Two nodes carry
  `webofworlds_extension.universal_extensions` with `interface` `ue:host@0.3.0`, the module `panel-maker.wasm` and the
  requests `ue.console.log`, `ue.data.read` and `ue.ui.panel`: `coffee-stand` (data `card`, a card with a button, a
  checkbox and a range; data `full`, a full panel with one text field and a progress bar) and `camera-card` (data
  `card`, the RP1 creator document `panels/rp1/camera.rml`, unchanged).
- `world/panel-maker.wasm`: `UE_TEST_MODULES.uePanelMaker()` (Open calls `ui.panel-set` with its data `card`, then
  `full`; Notify logs `notified`). 832 bytes, SHA-256
  `0959277831c279a00e90d32f427313b277395a50d5b012897400a943d735978e`, SRI
  `sha256-CVkneDHCeaAOkNMvQnMTsnc5WlDVsBKJdACpQ9c1l44=`.

## panels/

### panels/hostile/

Written for this repository: fourteen panel documents, each with one part outside the Lab's panel profile
(`web/wow-extension-panel-profile.mjs`), and `index.json`, which names the part and the reason the filter must give
when it refuses the document whole. The parts: a `script` element, an `onclick` attribute, an `iframe`, an `object`, a
`link`, a `meta` refresh, an `a` element with a `javascript:` address, `@import` in the style block, `url(` in a
property, `position: fixed`, an SVG image, an `input` of type `password`, an unknown element and a `form`. The addresses
in them use the reserved `.invalid` top-level domain, which never resolves.

### panels/rp1/

The six RP1 creator panel documents (group A of the SCRAP project's RP1 RML census,
`docs/universal-extensions/research/rp1-rml-census.md`), copied byte for byte as the census extracted them (no line
ending added). The first five come from public RP1 repositories of Metaversal Corporation under the Apache License 2.0;
the sixth from a public RP1 download with no licence text beside it, kept here as test data only. Nothing under
`src/fixtures/` goes into a site package.

- `camera.rml`: Sneeze `986fc4cb3da8`, `tools/assets/msf/camera.json`, the value of `Data.sPanel` (also identical in
  the census's copies #13 and #22). 936 bytes, SHA-256 `7b32073352ea16c73faf7cfef4caaef056cd66c6658b9f044aacacdf55e99486`.
- `panel.rml`: Sneeze `986fc4cb3da8`, `tools/assets/msf/panel.json`, the value of `Data.sPanel`. 780 bytes, SHA-256
  `21734a0689a6486ed68ffc062ff0d3eac38a5caeb3a8c584ddcf0fcfe722e753`.
- `camera2.rml`: Sneeze `19608d5`, `tools/assets/msf/camera2.json`, the value of `Data.sPanel`. 2,013 bytes, SHA-256
  `a1a9e47b63e27911fc615e82fdfd299493a97d8c7d060e2f71a1ee66eaac7279`.
- `camera3.rml`: Sneeze `19608d5`, `tools/assets/msf/camera3.json`, the value of `Data.sPanel`. 2,181 bytes, SHA-256
  `694ea254a9c2fb9cc53f77e64babd67c60236748a40ecb9e4e7b81539e362595`.
- `node-hello.rml`: SneezeSDK `44d0346fe22a`, `docs/api/NODE.md` line 184, the example document. 29 bytes, SHA-256
  `ce3b1a589fb08b1ff5d35857cd41082ab229d0fa40488ce9e790a84884ee75bc`.
- `test-panel.rml`: the document embedded in RP1's test `panel.wasm` (`https://cdn.rp1.com/test/panel.wasm`, 18,984
  bytes, SHA-256 `fbdaa24adf83cce4eaf5fab1d38a516cf4919b922c115dc56eacd7471489d40c`), read with `strings`. 651 bytes,
  SHA-256 `d639cda275286e8dbc3f31cca3f8e910a7e417a9555d3d3e7e74832a4633635a`.

## carrier-without-profile.json and carrier.mjs

- `carrier-without-profile.json` is a byte copy of the Universal Extensions profile fixture
  `docs/universal-extensions/fixtures/carrier-without-profile.json` of the SCRAP project (made by its `make-fixtures.mjs`),
  kept here so the discovery check reads it from inside the code folder. Size 1,629 bytes, SHA-256
  `0c2940a7fa766d700aa7c9032d490bd8b87c7fc21fbabb79571ac7bd79435061`.
- `carrier.mjs` is written for this repository. It signs carrier manifests for the checks with a key made per run.
