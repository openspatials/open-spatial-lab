# Third-party notices

Open Spatial Lab source code is licensed under Apache-2.0. Media and dependency licenses remain with their respective authors.

## Runtime dependencies

- [Three.js](https://github.com/mrdoob/three.js), Copyright 2010–2023 Three.js Authors, MIT License. The checked-in browser module is revision 160; the npm runtime package is version 0.173.0.
- [three-vrm](https://github.com/pixiv/three-vrm), Copyright 2019–2024 pixiv Inc., MIT License.
- Ajv, ajv-formats, js-yaml, and Puppeteer Core are used by local verification and retain their published package licenses.

## Container support

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docker/entrypoint.sh` and the `OSL_FRONTEND_HOST` setting are by Arjun Rai Gupta of VDC ([vdc-lab/open-spatial-lab](https://github.com/vdc-lab/open-spatial-lab)), commit `3652e44ca6`, 2026-08-26, Apache-2.0 (the `LICENSE` of that repository at that commit, "Copyright 2026 Open Spatial Lab contributors"). Open Spatial Lab changed them to follow the worlds list, `OSL_PUBLIC_ORIGIN` and the local-only placement rule; see the commit that follows his.

## Code from other projects inside X3DOM

`runtime/scene-core/public/vendor/x3dom/x3dom-full.js` is X3DOM 1.8.3 as published on npm (the package's `x3dom.js`), Copyright (c) 2009-2020 X3DOM, dual licensed under MIT and GPL, with its `LICENSE.md` beside it; the lab takes MIT. The built file carries no notices for the code from other projects inside it, so `vendor/x3dom/THIRD-PARTY-IN-BUNDLES.md`, beside it, names that code and says how it was found. The two libraries, with their licence texts:

- [earcut](https://github.com/mapbox/earcut), X3DOM's `x3dom.EarCut`, taken into X3DOM in November 2015, when earcut's latest release was v2.0.7. Copyright (c) 2015, Mapbox. ISC, from its `LICENSE` at tag `v2.0.7`:

      Copyright (c) 2015, Mapbox

      Permission to use, copy, modify, and/or distribute this software for any purpose
      with or without fee is hereby granted, provided that the above copyright notice
      and this permission notice appear in all copies.

      THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
      REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
      FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
      INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
      OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
      TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
      THIS SOFTWARE.

- [es6-promise](https://github.com/stefanpenner/es6-promise) 4.2.4, X3DOM's Promise polyfill. Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors. MIT, from its `LICENSE` at tag `v4.2.4`:

      Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors

      Permission is hereby granted, free of charge, to any person obtaining a copy of
      this software and associated documentation files (the "Software"), to deal in
      the Software without restriction, including without limitation the rights to
      use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
      of the Software, and to permit persons to whom the Software is furnished to do
      so, subject to the following conditions:

      The above copyright notice and this permission notice shall be included in all
      copies or substantial portions of the Software.

      THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
      IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
      FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
      AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
      LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
      OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
      SOFTWARE.

## Fonts and interface icon

- Space Grotesk — Copyright 2020 The Space Grotesk Project Authors; SIL Open Font License 1.1.
- Space Mono — Copyright 2016 The Space Mono Project Authors; SIL Open Font License 1.1.
- Rajdhani — Copyright 2014 Indian Type Foundry; SIL Open Font License 1.1.
- The GitHub interface glyph in `web/assets/icons8-github-250.svg` is an Icons8 asset used under the [Icons8 free license](https://icons8.com/license), which requires attribution and a link to Icons8.

The bundled WOFF2 files are local Latin web subsets. The font copyright notices and complete SIL Open Font License 1.1 text are included in `licenses/OFL-1.1.txt`.

## API descriptions and schemas

- The Web of Worlds API descriptions from [WebOfWorlds/WoWAPI](https://github.com/WebOfWorlds/WoWAPI), commit `d39a1a0`, Apache-2.0. Unmodified copies are in `wow-spec/upstream/wowapi-d39a1a0/`, with the upstream `LICENSE`. The Open Spatial Lab contract in `wow-spec/` is derived from them. The proposed edits are patches in `wow-spec/overlays/iteration-1/` and `wow-spec/overlays/iteration-2/`; the World README is vendored too, for iteration 2's README edit.
- The JSON Schema for OpenAPI 3.0 documents (2021-09-28) from the [OpenAPI Initiative](https://spec.openapis.org/oas/3.0/schema/2021-09-28), Apache-2.0. An unmodified copy is in `wow-spec/upstream/openapi-3.0/`; the iteration 2 proof validates the patched World API against it.
- The OGC GeoPose Basic-YPR schema from [opengeospatial/GeoPose](https://github.com/opengeospatial/GeoPose), Apache-2.0, in `wow-spec/upstream/geopose/`. One rename is recorded in its `README.md`. The Apache-2.0 text is in `LICENSE`.

## World models

The following GLB files are redistributed from [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets):

- AntiqueCamera — CC0 1.0; UX3D / Maximilian Kamps.
- ToyCar — CC0 1.0; Microsoft.
- BoomBox — CC0 1.0; Microsoft.
- Lantern — CC0 1.0; Microsoft (sbtron) and Frank Galligan.
- Avocado — CC0 1.0; Microsoft.
- BarramundiFish — CC0 1.0; Microsoft.
- Fox — model by PixelMannen under CC0 1.0; rigging and animation by tomkranis under CC BY 4.0; glTF conversion by Asobo Studio and scurest under CC BY 4.0.
- Duck — Copyright 2006 Sony, provided under the [SCEA Shared Source License 1.0](https://spdx.org/licenses/SCEA.html).

The complete redistribution terms are included in `licenses/`, together with each model's source notice. No changes were made to these model files.

## Avatars and equipment

The bundled dwarf avatar and equipment models are original CC0-1.0 assets. The selectable VRM files under `web/assets/avatars/vrm/` declare CC0 in their embedded metadata and originate from Open Source Avatars and Polygonal Mind collections. Attribution is not required by CC0 and is included here as a courtesy.

Five unmodified Ready Player Me avatar models are included under CC BY-NC-SA 4.0. They are the player avatars, and they dress the Denver Skyport actors. They are third-party works, are not covered by the project's Apache-2.0 license, and may be reused only under their own attribution, non-commercial, and ShareAlike terms:

- Readyplayerme Cyberpunk — [source](https://sketchfab.com/3d-models/readyplayerme-cyberpunk-5881c7e4431d44058325b4be4d8d30dc).
- Cyberpunk female full-body character — [source](https://sketchfab.com/3d-models/cyberpunk-female-full-body-character-25db1f1e45f948ec9a74b30356766908).
- Female full-body cyberpunk themed avatar — [source](https://sketchfab.com/3d-models/female-full-body-cyberpunk-themed-avatar-7a8fa15955084fa3bf7103ed1818c584).
- Female full-body Ninja avatar — [source](https://sketchfab.com/3d-models/female-full-body-ninja-avatar-490dfcc890694c3cb711869fd9f98e4b).
- Ready Player Me female character — [source](https://sketchfab.com/3d-models/ready-player-me-female-character-f2791ae3c40c4920a158f96c7dc46f53).

Ready Player Me is the credited creator for each model. No changes were made to the model files. The complete [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) legal text is included in `licenses/CC-BY-NC-SA-4.0.txt`.

The airport interface images in `web/assets/hud/` (round profile images) were generated for this project from its own prompts. They picture the lab's fictional travelers and storefronts.

No redistribution-prohibited avatar or raw third-party animation source file is included. The idle, walk and run animation is motion capture from the [100STYLE dataset](https://zenodo.org/records/8127870) by Ian Mason, Sebastian Starke and Taku Komura, licensed CC BY 4.0. `web/assets/mocap/locomotion-mocap.json` holds one cycle each of its Neutral idle, Rushed walk and BigSteps run, cut and resampled by `tools/mocap/bake-locomotion.mjs`; the file carries the same credit. The CC BY 4.0 text is in `licenses/CC-BY-4.0.txt`. The jump is authored by the application.

Full CC0, CC BY 4.0, CC BY-NC-SA 4.0, SIL OFL 1.1, MIT, and SCEA license texts are included in `licenses/`.
