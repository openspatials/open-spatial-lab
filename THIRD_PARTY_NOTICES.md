# Third-party notices

Open Spatial Lab source code is licensed under Apache-2.0. Media and dependency licenses remain with their respective authors.

## Runtime dependencies

- [Three.js](https://github.com/mrdoob/three.js), Copyright 2010–2023 Three.js Authors, MIT License. The checked-in browser module is revision 160; the npm runtime package is version 0.173.0.
- [three-vrm](https://github.com/pixiv/three-vrm), Copyright 2019–2024 pixiv Inc., MIT License.
- Ajv, ajv-formats, js-yaml, and Puppeteer Core are used by local verification and retain their published package licenses.

## Container support

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docker/entrypoint.sh` and the `OSL_FRONTEND_HOST` setting are by Arjun Rai Gupta of VDC ([vdc-lab/open-spatial-lab](https://github.com/vdc-lab/open-spatial-lab)), commit `3652e44ca6`, 2026-08-26, Apache-2.0 (the `LICENSE` of that repository at that commit, "Copyright 2026 Open Spatial Lab contributors"). Open Spatial Lab changed them to follow the worlds list, `OSL_PUBLIC_ORIGIN` and the local-only placement rule; see the commit that follows his.

## Opt-in renderers

The switch is `?renderer=`. three.js stays the default. See `web/renderer-lane.html`.

- **Nicholas Polys** wrote the render adapter boundary and the X3DOM path: his public fork [npolys/open-spatial-lab](https://github.com/npolys/open-spatial-lab), commit `99175b4b6` (2026-08-16), Apache-2.0 (the fork's own `LICENSE` file at that commit, the Apache License 2.0 with the notice "Copyright 2026 Open Spatial Lab contributors"). He is co-author of lab commit `ef702ec`.
  - Ported by hand from his files, each with a header that credits him: in `runtime/scene-core/public/render-adapter/`, `render-adapter.mjs`, `three-render-adapter.mjs`, `spatial-math.mjs`, `x3dom-render-adapter.mjs`, `x3dom-inline-pool.js`; in `web/`, `x3dom-live-mode.mjs`, `x3dom-portal-traversal-glue.mjs`, `x3dom-airport-terminal-scene.mjs`, `x3dom-equipment-glue.mjs`, `x3dom-gltf-humanoid-provider.mjs`, `x3dom-hud-glue.mjs`, `x3dom-movement-camera-controller.mjs`, `x3dom-peer-avatars-glue.mjs`, `x3dom-portal-hosted-objects.mjs`.
  - Written new in the lab, after his interface and naming his work in the header: `x-ite-render-adapter.mjs`, `registry.mjs`, `canonical-room.mjs`, `web/x-ite-live-mode.mjs`, `web/orbit-camera-controller.mjs`, `web/humanoid-provider.mjs`, `web/x3d-wow-graph-stage.mjs`. His fork has its own files for some of these; they were not among the fetched files.
  - Left out of his fork: its personal and scratch files, its release manifest and generator, its `.gitignore` edit, and its orchestrator change that keeps a process alive after an uncaught exception.
- [X3DOM](https://github.com/x3dom/x3dom) 1.8.3, Copyright 2009-2020 X3DOM, dual licensed under MIT and GPL; the lab takes MIT. Vendored in `runtime/scene-core/public/vendor/x3dom/` with its `LICENSE.md`, as vendored in his fork. Loaded only with `?renderer=x3dom`.
- [X_ITE](https://github.com/create3000/x_ite) 16.6.0, Copyright 2009 Holger Seelig and other contributors, MIT, from the [npm package](https://www.npmjs.com/package/x_ite/v/16.6.0). Vendored in `runtime/scene-core/public/vendor/x_ite/` with its `LICENSE.md` (the copy from the package's `dist/` folder, which adds the SGI Free B notice for the libtess code inside `x_ite.min.mjs`), `LICENSES/` and font licences (Apache for Droid Serif, OFL for PT Sans, the Ubuntu font licence for Ubuntu). Loaded only with `?renderer=x_ite`, and by the X3D JSON world page.
  - The files the lab serves in `assets/lib/` come from other projects, which X_ITE's `assets/lib/README.md`, source and `package.json` name. `assets/lib/LICENSES.md`, beside them, gives each copyright line and licence, with the MIT text: `draco_decoder_gltf.js` from Google's [Draco](https://github.com/google/draco), Copyright The Draco Authors, Apache-2.0; `meshopt_decoder.js` from [meshoptimizer](https://github.com/zeux/meshoptimizer), Copyright (c) 2016-2025 Arseny Kapoulkine, MIT; `mikktspace_bg.wasm` from [mikktspace-wasm](https://github.com/donmccurdy/mikktspace-wasm), Copyright (c) 2021 Don McCurdy, MIT, built from the gltf-rs `mikktspace` Rust crate 0.3.0 and `nalgebra` 0.26.2, named in the next sub-bullet; `woff2_decoder.js`, the WOFF2 decoder of the npm package [woff2-encoder](https://github.com/itskyedo/woff2-encoder) 2.0.0, Copyright (c) 2023-PRESENT Kyedo, MIT, with its last statement changed by X_ITE, compiled with [Emscripten](https://github.com/emscripten-core/emscripten) 3.1.46 (Copyright (c) 2010-2014 Emscripten authors, MIT or NCSA; the lab takes MIT) from Google's [WOFF2](https://github.com/google/woff2), Copyright (c) 2013-2017 by the WOFF2 Authors, MIT, and [Brotli](https://github.com/google/brotli), Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors, MIT; the look-up tables `lut_ggx.png`, `lut_charlie.png` and `lut_sheen_E.png` from the Khronos [glTF Sample Viewer](https://github.com/KhronosGroup/glTF-Sample-Viewer), Apache-2.0, which X_ITE re-encoded without changing a pixel; `sorter_no_simd_non_shared.wasm`, the Gaussian splat sorter of [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) 0.4.7, Copyright (c) 2023 Mark Kellogg, MIT, which `mkkellogg-sort.worker.js`, X_ITE's own code, runs.
  - **Code bundled inside X_ITE's own files.** The minified files carry no notices, so `vendor/x_ite/THIRD-PARTY-IN-BUNDLES.md`, beside them, names each library and gives its licence text. `x_ite.min.mjs`: SuperGif from [libgif-js](https://github.com/create3000/libgif-js) (npm `@create3000/libgif` 0.0.5), a fork of [jsgif](https://github.com/shachaf/jsgif), Copyright (c) 2011 Shachaf Ben-Kiki, MIT; [apng-js](https://github.com/davidmz/apng-js) 1.1.5, Copyright (c) 2016 David Mzareulyan, MIT, with Node.js's `events` module inside it, Copyright Joyent, Inc. and other Node contributors, MIT; [libtess.js](https://github.com/brendankenny/libtess.js), Copyright 2000 Silicon Graphics, Inc. and 2015 Google Inc., SGI Free Software License B 2.0; DOMIntegration, Copyright (c) 2016 Andreas Plesch, MIT. `Texturing3DComponent.min.js`: [CharLS.js](https://github.com/chafey/charls) 2.0.1 and [OpenJPEG.js](https://github.com/chafey/openjpeg) 0.10.2, (c) 2016 Chris Hafey, MIT, built from [CharLS](https://github.com/team-charls/charls) 2.0.0, Copyright (c) 2007-2010 Jan de Vaan, BSD-3-Clause, and [OpenJPEG](https://github.com/uclouvain/openjpeg) (2016-01 source, before v2.1.1), Copyright (c) 2002-2014 Universite catholique de Louvain (UCL), Belgium, and others, BSD-2-Clause; [dicom-parser](https://github.com/cornerstonejs/dicomParser) 1.8.12, Chris Hafey, MIT; the [jpeg-js](https://github.com/jpeg-js/jpeg-js) 0.4.4 decoder, Copyright 2011 notmasteryet, Apache-2.0, in the jpeg-js package, Copyright (c) 2014 Eugene Ware, BSD-3-Clause; [jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEGLosslessDecoderJS) 2.1.2, Copyright (c) 2015 RII-UTHSCSA, MIT. `RigidBodyPhysicsComponent.min.js`: X_ITE's own build of [ammo.js](https://github.com/kripken/ammo.js), Copyright (c) 2011 ammo.js contributors, zlib, with [Bullet](https://github.com/bulletphysics/bullet3) 2.82, Copyright (c) 2003-2011 Erwin Coumans, zlib. `TextComponent.min.js`: [opentype.js](https://github.com/opentypejs/opentype.js) 2.0.0, Copyright (c) 2020 Frederik De Bleser, MIT, with [tiny-inflate](https://github.com/devongovett/tiny-inflate) 1.0.3, Copyright (c) 2015-present Devon Govett, MIT. `NURBSComponent.min.js`: [nurbs](https://github.com/standardcyborg/nurbs) 1.1.1, © 2018 Standard Cyborg, Inc., MIT, with [isndarray](https://github.com/scijs/isndarray), Copyright (c) 2013 Kyle Robinson Young, MIT. `assets/lib/mikktspace_bg.wasm` also holds the [mikktspace](https://github.com/gltf-rs/mikktspace) crate 0.3.0, Copyright (c) 2017 The mikktspace Library Developers, MIT (or Apache-2.0), and [nalgebra](https://github.com/dimforge/nalgebra) 0.26.2, Copyright 2020 Sébastien Crozet, Apache-2.0 by the `LICENSE` at its v0.26.2 tag (its crates.io record says BSD-3-Clause).
  - **Left out of `assets/lib/`, because one file built into them is not open source.** `libktx.js` and `libktx.wasm`, the JavaScript build of libktx from [KTX-Software](https://github.com/KhronosGroup/KTX-Software) (its version string reads `v5.0.0-rc1~5`). KTX-Software's licence says Ericsson's `etcdec.cxx` is not open source; the Ericsson licence allows its use only in products that compress or decompress textures by the Khronos OpenGL, OpenGL ES and WebGL standards. KTX-Software's library build compiles that file in when ETC unpacking is on, which is the default, and its web build does not turn it off; `libktx.wasm` holds that file's tables. So X_ITE, as the lab serves it, cannot load KTX or KTX2 textures.
- **What the lab leaves out of X_ITE.** The package holds a CC-BY-NC-4.0 text that names no work and no file. Its `package.json` says MIT, `LICENSE.md` is the MIT licence, and a search of every file in the package finds no other mention of that licence and no SPDX tag. So nothing the package ships is marked as falling under it, and the package does not say why the text is there. To leave nothing of unstated origin behind a public link, the lab does not carry that text, X_ITE's hatching and line type pictures, or its icons other than the logo. The renderer loaded none of them in a trace of its worlds. A scene that uses X3D hatching or line types would not find those pictures; no lab world does. Also left out: the package's unminified builds, `x_ite.zip`, `x_ite.d.ts`, `X3DUOM.xml` and `example.html`.
- The X3D paths load the lab's own avatar, `rpm_female_character.glb`, under the CC BY-NC-SA 4.0 terms given below. That licence comes with the lab, not with either engine.
- The X3D JSON test world, `web/x3d-worlds/anchor-portal-world.x3d.json`, is lab code under Apache-2.0.

### John Carlson's soft-body world

- **John Carlson** wrote the world and its physics set-up: his public repository [coderextreme/open-spatial-lab](https://github.com/coderextreme/open-spatial-lab), commit [`bf12953173`](https://github.com/coderextreme/open-spatial-lab/commit/bf12953173) (2026-10-06, "Check in these changes to support softbody physics"), Apache-2.0 (the repository's `LICENSE` file at that commit). The world file's own head names more creators, kept as they are: Kripken (Ammo.js) and Bullet Physics (C++), and its generator.
- `web/worlds/soft-body.json` is his file, unchanged. `web/x3d-worlds/soft-body.x3d.json` is the copy the page loads: the lab added a credit line, a viewpoint to stand at and an X3D Anchor back to the Lobby, and took out the humanoid. `web/soft-body-world.mjs` ports his Bullet calls and numbers from his `web/index.js` and credits him in its header.
- **His humanoid is left out.** `web/assets/HumanoidComplete.json` and `web/assets/textures/gramps_2_outfit1_diffuse.png` are not in the lab. The humanoid's `license` meta points at a file that is not in his commit, his release manifest does not list either file, and the commit does not state the texture's origin. The copy the page loads does not refer to them; his unchanged file still names the humanoid.
- Bullet on this path is the Ammo.js build inside X_ITE's RigidBodyPhysics component, `vendor/x_ite/assets/components/RigidBodyPhysicsComponent.min.js`, built by X_ITE from [ammo.js](https://github.com/kripken/ammo.js) (Copyright (c) 2011 ammo.js contributors, zlib) with Bullet 2.82 (Copyright (c) 2003-2011 Erwin Coumans, zlib). Both zlib texts are in `vendor/x_ite/THIRD-PARTY-IN-BUNDLES.md`.

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

- The Web of Worlds API descriptions from [WebOfWorlds/WoWAPI](https://github.com/WebOfWorlds/WoWAPI), commit `d39a1a0`, Apache-2.0. Unmodified copies are in `wow-spec/upstream/wowapi-d39a1a0/`, with the upstream `LICENSE`. The Open Spatial Lab contract in `wow-spec/` is derived from them. The proposed edits are patches in `wow-spec/overlays/iteration-1/` to `wow-spec/overlays/iteration-4/`; the World README is vendored too, for the README edits of iterations 2 and 3.
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

The equipment models, `web/assets/equip-*.glb`, `web/assets/hero-held-lantern.gltf` and `web/assets/hero-worn-visor.gltf`, are original CC0-1.0 assets made for this project.

The avatars are four characters from Adobe Mixamo (Adam, David, Elizabeth and Sophie, `web/assets/actionforge/characters/<name>/<name>.glb`). They were converted onto ActionForge's CC0 skeleton (see below) by the project's avatar pipeline, with their meshes and textures kept and the textures re-encoded as WebP. They are the player avatars and dress the Denver Skyport actors. Each has a prepared file (`<name>.avatar.json`: clip choices and measured gait) and body details (`<name>.body.json`), measured by the project.

The animation comes from the ActionForge animation library: the rig and its 84 clips by Quaternius, exported from ActionForge, dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). `web/assets/actionforge/clips/actionforge-clips.glb` holds them in place, on the rig's own 71 joints; the file carries the same credit. The clips play on each character's own skeleton, with no retargeting.

One unmodified Ready Player Me model, `web/assets/avatars/glb/rpm_female_character.glb` ([source](https://sketchfab.com/3d-models/ready-player-me-female-character-f2791ae3c40c4920a158f96c7dc46f53)), remains as the avatar of the X3D paths (X3DOM and X_ITE) until they take a collection character. It is licensed CC BY-NC-SA 4.0 (attribution, non-commercial, ShareAlike), is not covered by the project's Apache-2.0 license, and Ready Player Me is its credited creator. The legal text is in `licenses/CC-BY-NC-SA-4.0.txt`.

No redistribution-prohibited avatar or raw third-party animation source file is included. Earlier releases used motion capture from the [100STYLE dataset](https://zenodo.org/records/8127870) by Ian Mason, Sebastian Starke and Taku Komura (CC BY 4.0); its text stays in `licenses/CC-BY-4.0.txt`.

The airport interface images in `web/assets/hud/` (round profile images) were generated for this project from its own prompts. They picture the lab's fictional travelers and storefronts.


Full CC0, CC BY 4.0, CC BY-NC-SA 4.0, SIL OFL 1.1, MIT, and SCEA license texts are included in `licenses/`.
