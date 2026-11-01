# Licences of the files in this folder

These files come unchanged with X_ITE 16.6.0 (the npm package `x_ite`). X_ITE's `assets/lib/README.md`, its source
and its `package.json` name the project each one comes from. The copyright line and the licence below were read from
that project's own package or repository. The full Apache-2.0 and MIT texts are also in `../../LICENSES/`, and
`../../THIRD-PARTY-IN-BUNDLES.md` gives each project's own licence file in full.

## `README.md`

X_ITE's own list of references. Copyright (c) 2009 Holger Seelig and other contributors. MIT License, in
`../../LICENSE.md`.

## `draco_decoder_gltf.js`

The Draco decoder for glTF, compiled to JavaScript, from Google's Draco project, https://github.com/google/draco
(npm packages `draco3d` and `draco3dgltf`). Copyright The Draco Authors. Licensed under the Apache License, Version
2.0 (Apache-2.0), in `../../LICENSES/Apache-2.0.txt`.

## `meshopt_decoder.js`

The meshoptimizer decoder, from https://github.com/zeux/meshoptimizer (npm package `meshoptimizer`).
Copyright (c) 2016-2025 Arseny Kapoulkine. MIT License, below.

## `mikktspace_bg.wasm`

MikkTSpace tangent generation in WebAssembly, from https://github.com/donmccurdy/mikktspace-wasm (npm package
`mikktspace`). Copyright (c) 2021 Don McCurdy. MIT License, below. The binary is built from two Rust crates, as its
own strings show, after the MikkTSpace standard by Morten S. Mikkelsen:

- `mikktspace` 0.3.0, from https://github.com/gltf-rs/mikktspace. Copyright (c) 2017 The mikktspace Library
  Developers. MIT or Apache-2.0; Open Spatial Lab takes the MIT License, below.
- `nalgebra` 0.26.2, from https://github.com/dimforge/nalgebra. Copyright 2020 Sébastien Crozet. The Apache License,
  Version 2.0, in `../../LICENSES/Apache-2.0.txt`, as the `LICENSE` file at its tag `v0.26.2` says; its crates.io
  record says BSD-3-Clause.

It also holds Rust's standard library. `../../THIRD-PARTY-IN-BUNDLES.md` gives these licence texts in full, and the
code from other projects inside X_ITE's other files.

## `woff2_decoder.js`

The WOFF2 font decoder of the npm package `woff2-encoder` 2.0.0, from https://github.com/itskyedo/woff2-encoder
(tag `v2.0.0`): its `dist/decompress.js`, in which X_ITE replaced the last statement, the module export, with a plain
`return`, and which X_ITE's build then minified. Copyright (c) 2023-PRESENT Kyedo. MIT License, below.

Its WebAssembly part was built by woff2-encoder with Emscripten 3.1.46 from:

- WOFF2, from https://github.com/google/woff2 at commit `4721483`. Copyright (c) 2013-2017 by the WOFF2 Authors.
  MIT License, below.
- Brotli, from https://github.com/google/brotli at commit `533843e`, the one WOFF2 names at that commit. Copyright
  (c) 2009, 2010, 2013-2016 by the Brotli Authors. MIT License, below.

It also holds Emscripten's runtime and generated code, from https://github.com/emscripten-core/emscripten.
Copyright (c) 2010-2014 Emscripten authors. MIT or the University of Illinois/NCSA Open Source License; Open Spatial
Lab takes the MIT License, below.

## `lut_ggx.png`, `lut_charlie.png`, `lut_sheen_E.png`

Look-up tables for image-based lighting and for sheen, from the Khronos glTF Sample Viewer,
https://github.com/KhronosGroup/glTF-Sample-Viewer (its `assets/images/`). Licensed under the Apache License, Version
2.0 (Apache-2.0), in `../../LICENSES/Apache-2.0.txt`; the project's `LICENSE.md` is that text, with no copyright line,
and its `package.json` names Khronos Group Inc. as author.

X_ITE changed these files: in March 2025 it re-encoded all three PNG files to make them smaller. Every pixel is the
same as in the glTF Sample Viewer's files. In `lut_sheen_E.png` the re-encoding also dropped the colour profiles and
other metadata the original carried.

## `sorter_no_simd_non_shared.wasm`

The Gaussian splat sorter of GaussianSplats3D, https://github.com/mkkellogg/GaussianSplats3D (npm package
`@mkkellogg/gaussian-splats-3d`), compiled with Emscripten from its `src/worker/sorter_no_simd.cpp`; the same file
as in that repository at tag `v0.4.7`. Copyright (c) 2023 Mark Kellogg. MIT License, below.

## `mkkellogg-sort.worker.js`

X_ITE's own Web Worker, which loads and runs `sorter_no_simd_non_shared.wasm`. Copyright (c) 2009 Holger Seelig and
other contributors. MIT License, in `../../LICENSE.md`.

## Left out

X_ITE's package also has `libktx.js` and `libktx.wasm`, from KTX-Software. Open Spatial Lab does not serve them,
because KTX-Software's licence says one file built into them, Ericsson's `etcdec.cxx`, is not open source.
`THIRD_PARTY_NOTICES.md` at the root of the Open Spatial Lab repository says why, and what X_ITE then cannot do.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
