# Open Spatial Lab

Open Spatial Lab is a local Web of Worlds and spatial-computing demo. From the player lobby and launcher, an avatar can move among three authored Three.js destinations—Location A, Location B, and Denver Skyport—while preserving supported identity, equipment, pose, and portal state.

## Included

- Player lobby and mission launcher
- Three authored Three.js destinations: Location A, Location B, and Denver Skyport
- Denver Skyport access through the lobby's Portal C path
- Local world servers and a one-command launcher
- Selectable avatars and equipment
- Included models, textures, procedural animation, and runtime assets
- Portal navigation and player-state continuity
- Automated integrity and browser verification commands

## Requirements

The tested setup is macOS 13 or newer with:

- Git; the public workflow has been verified with Git 2.33.0
- Node.js 22.x
- npm 10.x
- Bash, `curl`, and `lsof`
- A current Google Chrome, Chromium, Brave, or Microsoft Edge browser

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
- `runtime/` — local world-server and Three.js scene runtime
- `web/` — browser demo, authored worlds, and included runtime assets
- `wow-spec/` — Web of Worlds schema and validation code
- `tools/` — launcher helpers and public verification scripts
- `licenses/` — third-party asset and library license texts

## Quick start

Use the following commands as the required first-run path; there is no separate build or preflight step.

```bash
git clone https://github.com/openspatials/open-spatial-lab.git
cd open-spatial-lab
npm ci
npm start
```

No build step or configuration file is required. Startup completes with a receipt similar to:

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
3. Choose **Switch avatar**, select an included avatar, one worn item, and one held item, then choose **Apply**. Continue moving to see the selection remain with the player.
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
- Avatar selector: **Switch avatar**, choose an avatar plus one worn and one held item, then **Apply**; `Escape` or **Cancel** discards pending changes

## Verification

Optional but recommended: run the complete public check from the repository root:

```bash
npm run verify
```

It verifies the packaged tree, starts the local topology, opens the launcher and world scenes in a local browser, checks included assets, and shuts everything down. A successful run ends with `PASS: Open Spatial Lab verification complete`. Run `npm start` afterward to resume the demo.

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
- **Browser verification cannot find Chrome:** set `PUPPETEER_EXECUTABLE_PATH` to a compatible browser executable and rerun `npm run verify`.

## Planned improvements

These are future enhancements, not additional setup steps for the current demo, and no delivery dates are promised.

- Smoother continuous portal transitions and automatic two-way return paths
- Deeper Denver Skyport continuity and multi-world presence
- Clearer navigation, a more focused home launcher, and a spatial avatar carousel
- User, avatar, and storefront identity profiles with previews and proximity exchange
- Richer airport experiences, including interactive storefronts, a Gate A12 journey, and moving travelers
- Airport localization, spatial-content discovery, and augmented-reality overlays
- Broader multi-machine, real-device, unhappy-path, and sample-world coverage

## License and security

Source code is licensed under Apache-2.0. Bundled media has its own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `LICENSE`. See [SECURITY.md](SECURITY.md) for responsible vulnerability reporting.
