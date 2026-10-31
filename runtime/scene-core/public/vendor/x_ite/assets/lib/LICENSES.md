# Licences of the files in this folder

These files come unchanged with X_ITE 16.6.0 (the npm package `x_ite`). X_ITE's `assets/lib/README.md`, its source
and its `package.json` name the project each one comes from. The copyright line and the licence below were read from
that project's own package, and for the two Rust crates from their repositories. The full Apache-2.0 and MIT texts
are also in `../../LICENSES/`.

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

## Left out

X_ITE's package also has `libktx.js`, `libktx.wasm`, `woff2_decoder.js`, `lut_charlie.png`, `lut_ggx.png`,
`lut_sheen_E.png`, `mkkellogg-sort.worker.js` and `sorter_no_simd_non_shared.wasm`. Open Spatial Lab does not serve
them, because their licences could not be shown from the files and the package. `THIRD_PARTY_NOTICES.md` at the root
of the Open Spatial Lab repository says why for each, and what X_ITE then cannot do.

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
