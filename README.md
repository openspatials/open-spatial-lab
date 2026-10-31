# Open Spatial Lab

Open Spatial Lab is a local Web of Worlds and spatial-computing demo. From the player lobby and launcher, an avatar can move among three authored Three.js destinations—Location A, Location B, and Denver Skyport—while preserving supported identity, equipment, pose, and portal state.

This repository is where Open Spatial Lab is developed. Issues and pull requests are welcome; see [Contributing](#contributing).

## Included

- Player lobby and mission launcher
- Three authored Three.js destinations: Location A, Location B, and Denver Skyport
- Denver Skyport access through the lobby's Portal C path
- Local world servers and a one-command launcher
- A generated player avatar with selectable equipment
- Included models, textures, motion-capture animation, and runtime assets
- Portals from each world's Web of Worlds data: each stands at the node that places it, and its see-through view draws only what its destination declares
- Portal navigation and player-state continuity
- Player presence over a same-browser channel (`BroadcastChannel`), until live presence is built: other tabs of the same browser see your avatar; other browsers and other machines do not
- Web of Worlds protocol proofs, a conformance runner, and browser verification

## Requirements

The tested setup is macOS 13 or newer with:

- Git; the public workflow has been verified with Git 2.33.0
- Node.js 22.x
- npm 10.x
- Bash, `curl`, and `lsof`
- A current Google Chrome, Chromium, Brave, or Microsoft Edge browser to use the demo
- Chrome for Testing for the browser checks (`npm run verify`, `check:browser` and the browser checks in the proofs); they use no other browser

Check the required command-line tools before cloning:

```bash
git --version
node --version
npm --version
command -v curl
command -v lsof
```

If Node.js 22.x and npm 10.x are not installed, select the 22.x release from the [official Node.js download page](https://nodejs.org/en/download).

## Repository layout

- `src/` — local frontend server and topology orchestration
- `runtime/` — local world server with its proofs (`runtime/world-server/test/`), and the Three.js scene runtime
- `web/` — browser demo, authored worlds, and included runtime assets
- `wow-spec/` — Web of Worlds schema, validation code, and conformance fixtures
- `tools/` — launcher helpers, verification scripts, and the Web of Worlds conformance runner and proofs (`tools/wow-conformance/`)
- `licenses/` — third-party asset and library license texts

## Quick start

Use the following commands as the required first-run path; there is no separate build or preflight step.

```bash
git clone https://github.com/openspatials/open-spatial-lab.git
cd open-spatial-lab
npm ci
npm start
```

No build step is required. The worlds, their ports and addresses are listed in `worlds.json`; to add a world, follow `ADD-A-WORLD-CHECKLIST.md` and run `npm run check:worlds`. Startup completes with a receipt similar to:

```text
Open Spatial Lab is ready.
Launcher:            http://127.0.0.1:8143/
Lobby player:        http://127.0.0.1:8143/index.html?role=player&intro=bypass
Location A observer: http://127.0.0.1:8143/index.html?role=source&intro=bypass
Location B observer: http://127.0.0.1:8143/index.html?role=target&intro=bypass
```

Open the launcher URL in a supported browser.

## Five-minute demo

1. On the launcher, choose **Enter as Player** to enter the lobby. Select **Start exploring** if the orientation card appears.
2. Move with `W`, `A`, `S`, and `D`. Hold `Shift` to run, press `Space` to jump, drag to look around, scroll to zoom, and press `C` to switch camera view.
3. Choose **Switch avatar**, select one worn item and one held item, then choose **Apply**. Continue moving to see the selection remain with the player.
4. Walk through a lit portal; crossing is automatic. Visit Location A and Location B and compare their scenes and local models.
5. Return to the lobby and walk through Portal C to enter Denver Skyport. Use its return portal to continue the journey.
6. Open **Views** to return to the launcher. Open the Location A and Location B observer views to show the two local world servers.

## Controls

- Walk: `W`, `A`, `S`, `D`
- Run: hold `Shift` while moving
- Jump: `Space`
- Look/orbit: drag the primary mouse button or use a one-finger drag
- Zoom: mouse wheel or trackpad scroll
- Camera: `C` or the camera button
- Portal: walk through a lit portal; no extra command is needed
- Launcher: arrow keys to move, `Home`/`End` for first/last, `Enter` or `Space` to open, and mouse selection
- Avatar selector: **Switch avatar**, choose one worn and one held item, then **Apply**; `Escape` or **Cancel** discards pending changes

## Verification

Run the complete check from the repository root:

```bash
npm run verify
```

It checks the package and its local module closure, scans the tree for private project traces (`npm run trace-check`), starts the local topology, opens the launcher and world scenes in a local browser, checks included assets, and shuts everything down. A successful run ends with `PASS: Open Spatial Lab verification complete`. Run `npm start` afterward to resume the demo.

### Proofs and conformance

Each proof starts its own world servers on isolated ports, so it never disturbs a running demo. Proofs write a JSON report to `diagnostics/`.

```bash
npm run proof:crossing        # a world-to-world crossing over the Web of Worlds API
npm run proof:portal          # portals as graph nodes with a resolvable destination
npm run proof:spatial-graph   # the spatial composition graph, end to end
npm run proof:contract        # contract-driven request and response validation
npm run proof:presence        # WebSocket events and presence
npm run proof:acceptance      # world-server exit and arrival acceptance tests
npm run arch-i1-proof        # frames, GeoPose anchors, transforms and the node tree, with a mutant for every check
npm run arch-i2-proof        # one world including another world's graph, node or whole world, with planted faults for every check
npm run arch-i3-proof        # worlds that change with nobody present, observed without users, live inclusion; about 4 minutes
npm run arch-i4-proof        # portals by node with previews the destination allows, crossing by navigation; about 4 minutes
npm run check:identity       # Universal Manifest, RP1 and trust attack-vector tests, and the signing test vectors
npm run check:client         # checks of the browser client's controllers and scene code, run in Node
npm run check:browser        # browser checks that drive Chrome
npm run conformance           # Web of Worlds conformance runner
npm run conformance:fixtures  # pinned OpenSpatialWorld schema and endpoint fixtures
npm run wow-schema-json       # rebuild wow-spec/generated/schema.json from wow-spec/schema.yaml
npm run smoke:wowapi          # Web of Worlds API smoke test over HTTP
```

The API smoke test starts and stops the local topology itself, so it stops a running demo. Set `OSL_FRONTEND_PORT` and `OSL_BACKEND_{A,B,LOBBY,AIRPORT}_PORT` to run it on other ports.

No check is skipped because the machine is busy. A check that fails with a timeout is run once more, and the second result counts.

Known issues: `runtime/world-server/test/airport-backend-proof.js` and check E11 of `runtime/world-server/test/p1-shared-edge-portal-identity-proof.js` fail on the current code. The round-trip proof (`wow-spec/proof/roundtrip.js`) stops at its spatial-fabric section, because the fabric modules are not in this repository yet.

### Worlds and portal placement

The lab has one list of worlds: `worlds.json` (or the file named by `OSL_WORLDS`). The launch script, the world servers, the frontend and the browser all read it; the browser reads it at `/worlds.json`. A world added to that file appears in the launcher and the frontend routes with no other edit. `npm run check:worlds` checks a running lab against the list, and `npm run check:world-list` proves the rule.

The servers bind to 127.0.0.1 unless `OSL_BIND_HOST` says otherwise. With `OSL_BIND_HOST=0.0.0.0` and no `OSL_PUBLIC_ORIGIN`, a browser on another machine can use the lab: `/worlds.json` and each world's resources then name the host the browser used in its request, not 127.0.0.1, so its portals read online. A live public lab sets `OSL_PUBLIC_ORIGIN` instead: every world then says it lives at `{origin}/w/{key}/`. Placement stays off whenever the servers are not bound to 127.0.0.1.

Placing portals is off by default. It works only on a lab bound to 127.0.0.1 and started with `OSL_PLACEMENT_WRITES=1`, for example `OSL_PLACEMENT_WRITES=1 npm start`; then `&place=1` opens placement mode, on a `?wow=` player link and in the main demo as a Player (`index.html?role=player&place=1`). Without both conditions the write routes answer 403 with the reason, and placed portals are shown read-only. Never set this in a deploy file. `npm run check:placement` and `npm run check:local-only` prove this. Like every check that starts a browser, they need a headless Chrome for Testing, which `tools/find-browser.mjs` finds.

## Stop and clean up

```bash
npm stop
```

The command stops the frontend and every local world server, removes runtime PID files, and releases ports `8143` and `18151`–`18154`.

For a clean restart, including after a partial startup, run:

```bash
npm stop
npm start
```

## Troubleshooting

- **Unsupported Node or npm:** confirm `node --version` is 22.x and `npm --version` is 10.x.
- **Install fails:** confirm network access, remove `node_modules`, and run `npm ci` again.
- **A port is occupied:** run `npm stop`. If the message identifies an unrelated process, stop that application or choose another machine.
- **A page looks stale:** perform a hard refresh in the browser.
- **A service is not ready:** run `npm stop`, then `npm start` and use the newly printed URLs. The supported topology has exactly five listeners: frontend `8143` and world servers `18151`–`18154`.
- **Browser verification cannot find Chrome for Testing:** install Chrome for Testing, or set `PUPPETEER_EXECUTABLE_PATH` to a Chrome for Testing binary, and rerun `npm run verify`. The checks never fall back to another browser.

## Planned improvements

These are future enhancements, not additional setup steps for the current demo, and no delivery dates are promised.

- Smoother continuous portal transitions and automatic two-way return paths
- Deeper Denver Skyport continuity, and live presence across browsers and machines (today player presence stays inside one browser)
- Clearer navigation, a more focused home launcher, and a spatial avatar carousel
- User, avatar, and storefront identity profiles with previews and proximity exchange
- Richer airport experiences, including interactive storefronts, a Gate A12 journey, and moving travelers
- Airport localization, spatial-content discovery, and augmented-reality overlays
- Broader multi-machine, real-device, unhappy-path, and sample-world coverage

## Contributing

- Open an issue to report a bug or propose a change, or open a pull request against `main`.
- Before you open a pull request, run `npm run verify` and the proofs that cover your change.
- Keep code comments about the code. `npm run trace-check` fails on internal tracker ids, private paths and secret-shaped values.
- Contributions are licensed under Apache-2.0, as section 5 of the license states.

## License and security

Source code is licensed under Apache-2.0. Bundled media has its own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `LICENSE`. See [SECURITY.md](SECURITY.md) for responsible vulnerability reporting.
