# Third-party code inside the X_ITE files

The files in this folder are X_ITE 16.6.0, from the npm package `x_ite`, unchanged. Two files are Open Spatial Lab's own: `assets/lib/LICENSES.md` and this file. X_ITE is under the MIT License, Copyright (c) 2009 Holger Seelig and other contributors, in `LICENSE.md`.

X_ITE's minified files carry no licence notices for the code from other projects that is built into them. This file names that code for each file served from this folder, with its copyright line, licence, source and version, and then gives each licence text. The code was found in the unminified builds in the same package, by their webpack module paths, numbered modules and banners. Each licence text was read from the project's own repository at the tag or commit named, or from its npm package where that is said. The files in `assets/lib/` were traced through X_ITE's own repository at its tag `16.6.0`, where X_ITE keeps them in `src/assets/lib/`, and compared with each project's own files.

## 1. Each file and the code inside it

### `x_ite.min.mjs`

- **X_ITE** 16.6.0, https://github.com/create3000/x_ite. MIT. Copyright (c) 2009 Holger Seelig and other contributors. Text in `LICENSE.md`.
- **DOMIntegration**, part of X_ITE's source, taken from https://github.com/andreasplesch/x_ite_dom. MIT. Copyright (c) 2016 Andreas Plesch. Text in 2.2.
- **libtess.js**, npm `libtess` 1.2.2, https://github.com/brendankenny/libtess.js. SGI Free Software License B 2.0. Copyright 2000, Silicon Graphics, Inc.; Copyright 2015, Google Inc. Text in `LICENSE.md` and in 2.7.
- **SuperGif** from **libgif-js**, npm `@create3000/libgif` 0.0.5, https://github.com/create3000/libgif-js at commit `3ab2c17`, a fork of https://github.com/shachaf/jsgif, whose `LICENSE` is the same file. MIT. Copyright (c) 2011 Shachaf Ben-Kiki. Text in 2.1.
- **apng-js** 1.1.5, https://github.com/davidmz/apng-js, tag `v1.1.5`. MIT. Copyright (c) 2016 David Mzareulyan. Text in 2.1.
- **Node.js's `events` module** (EventEmitter), inside apng-js's own build; its version is not named in the file. MIT. Copyright Joyent, Inc. and other Node contributors. Text in 2.2.

### `assets/components/Texturing3DComponent.min.js`

- **CharLS.js** 2.0.1 (its banner: "(c) 2016 Chris Hafey"; its npm record says MIT), https://github.com/chafey/charls at commit `2911313`. It is CharLS 2.0.0 with 13 commits more, and its `License.txt` is CharLS's.
- **CharLS** 2.0.0, https://github.com/team-charls/charls, tag `2.0.0`. BSD-3-Clause. Copyright (c) 2007-2010, Jan de Vaan. Text in 2.3.
- **OpenJPEG.js** 0.10.2 (its banner: "(c) 2016 Chris Hafey"; its npm record says MIT), https://github.com/chafey/openjpeg at commit `f201250`. It forks OpenJPEG, and its `LICENSE` is OpenJPEG's.
- **OpenJPEG**, https://github.com/uclouvain/openjpeg at commit `5c5ae1d` (2016-01-25), where OpenJPEG.js forks it. BSD-2-Clause. Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium, and the others named in its licence. Text in 2.4.
- **dicom-parser** 1.8.12 (its banner: "(c) 2017 Chris Hafey"), https://github.com/cornerstonejs/dicomParser, tag `v1.8.12`. MIT. Text in 2.1.
- **The jpeg-js decoder**, from jpeg-js 0.4.4, https://github.com/jpeg-js/jpeg-js, tag `v0.4.4`. The decoder's own header: Apache-2.0, Copyright 2011 notmasteryet (text in 2.6). The jpeg-js package: BSD-3-Clause, Copyright (c) 2014, Eugene Ware (text in 2.3).
- **jpeg-lossless-decoder-js** 2.1.2, https://github.com/rii-mango/JPEGLosslessDecoderJS at commit `ea0eaa0`. MIT. Copyright (c) 2015 RII-UTHSCSA. Text in 2.1.

### `assets/components/RigidBodyPhysicsComponent.min.js`

- **ammo.js**, as X_ITE builds it from its own `src/lib/ammojs/`, https://github.com/kripken/ammo.js. zlib. Copyright (c) 2011 ammo.js contributors. The licence was read at commit `ac08f42` (2019-03-08), the last before X_ITE's build of 2019-03-21; it is the same file today. Text in 2.5.
- **Bullet** 2.82, which ammo.js carries, https://github.com/bulletphysics/bullet3, tag `2.82`. zlib. Copyright (c) 2003-2011 Erwin Coumans (`COPYING`) and Copyright (c) 2003-2010 Erwin Coumans (`BulletLicense.txt`). Texts in 2.5.

### `assets/components/TextComponent.min.js`

- **opentype.js** 2.0.0, https://github.com/opentypejs/opentype.js. MIT. Copyright (c) 2020 Frederik De Bleser. Text, from its npm package, in 2.1.
- **tiny-inflate** 1.0.3, inside opentype.js, https://github.com/devongovett/tiny-inflate. MIT. Copyright (c) 2015-present Devon Govett. Text, from its npm package, in 2.1.

### `assets/components/NURBSComponent.min.js`

- **nurbs** 1.1.1, copied into X_ITE's source, https://github.com/standardcyborg/nurbs, tag `v1.1.1`. MIT. © 2018 Standard Cyborg, Inc. Text in 2.1.
- **isndarray** 1.0.0, inside nurbs, https://github.com/scijs/isndarray, tag `v1.0.0`. MIT. Copyright (c) 2013 Kyle Robinson Young. Text in 2.1.

### `assets/lib/mikktspace_bg.wasm`

- **mikktspace-wasm** 1.1.1, npm `mikktspace`, https://github.com/donmccurdy/mikktspace-wasm, tag `v1.1.1`. MIT. Copyright (c) 2021 Don McCurdy. Text, from its npm package, in 2.1.
- **The `mikktspace` Rust crate** 0.3.0, https://github.com/gltf-rs/mikktspace at commit `b34fbc4`, after MikkTSpace by Morten S. Mikkelsen. MIT or Apache-2.0; the lab takes MIT. Copyright (c) 2017 The mikktspace Library Developers. Text in 2.1.
- **The `nalgebra` Rust crate** 0.26.2, https://github.com/dimforge/nalgebra, tag `v0.26.2`. The `LICENSE` file at that tag is the Apache License 2.0, with the line "Copyright 2020 Sébastien Crozet"; the crate's crates.io record for 0.26.2 says BSD-3-Clause. Text in `LICENSES/Apache-2.0.txt`; the copyright line in 2.6.
- **Rust's standard library**, which the compiler builds in. MIT OR Apache-2.0. See section 3.

### `assets/lib/draco_decoder_gltf.js`

- **Draco**, https://github.com/google/draco (X_ITE asks for `draco3d` ^1.5.9). Apache-2.0. Copyright The Draco Authors. Text in `LICENSES/Apache-2.0.txt`; also named in `assets/lib/LICENSES.md`.

### `assets/lib/meshopt_decoder.js`

- **meshoptimizer**, https://github.com/zeux/meshoptimizer (X_ITE asks for `meshoptimizer` ^1.3.0). MIT. Copyright (c) 2016-2025 Arseny Kapoulkine. Text in `assets/lib/LICENSES.md` and in 2.1.

### `assets/lib/woff2_decoder.js`

- **woff2-encoder** 2.0.0, npm `woff2-encoder`, https://github.com/itskyedo/woff2-encoder, tag `v2.0.0`. MIT. Copyright (c) 2023-PRESENT Kyedo. The file is the package's `dist/decompress.js` with its last statement, the module export, replaced by X_ITE with a plain `return`, then minified by X_ITE's build. Text in 2.1.
- **WOFF2**, https://github.com/google/woff2 at commit `4721483`, the commit woff2-encoder's build checks out. MIT. Copyright (c) 2013-2017 by the WOFF2 Authors. Text in 2.1.
- **Brotli**, https://github.com/google/brotli at commit `533843e`, WOFF2's `brotli` submodule at that commit. MIT. Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors. Text in 2.1.
- **Emscripten** 3.1.46, the compiler woff2-encoder's build names, for the runtime and generated code it put in the file, https://github.com/emscripten-core/emscripten, tag `3.1.46`. MIT or the University of Illinois/NCSA Open Source License; the lab takes MIT. Copyright (c) 2010-2014 Emscripten authors. Its licence file in full in 2.1.

### `assets/lib/sorter_no_simd_non_shared.wasm`

- **GaussianSplats3D**, https://github.com/mkkellogg/GaussianSplats3D, tag `v0.4.7` (npm `@mkkellogg/gaussian-splats-3d` 0.4.7). The file is byte for byte its `src/worker/sorter_no_simd_non_shared.wasm`, compiled with Emscripten from its `src/worker/sorter_no_simd.cpp`; it imports only memory and links in no library code. MIT. Copyright (c) 2023 Mark Kellogg. Text in 2.1.

### `assets/lib/lut_ggx.png`, `assets/lib/lut_charlie.png`, `assets/lib/lut_sheen_E.png`

- **glTF Sample Viewer**, https://github.com/KhronosGroup/glTF-Sample-Viewer, `assets/images/` at commit `f22c8b8` (2024-06-11), the files X_ITE took. Apache-2.0: the project's `LICENSE.md` is the Apache License 2.0 with no copyright line, and its `package.json` names Khronos Group Inc. as author. X_ITE changed the files: in March 2025 it re-encoded all three PNG files, leaving every pixel as it was. Text in `LICENSES/Apache-2.0.txt`.

### Files with X_ITE's own code only

`x_ite.css` and the other 19 components: `AnnotationComponent`, `CADGeometryComponent`, `CubeMapTexturingComponent`, `DISComponent`, `EventUtilitiesComponent`, `GaussianSplatsComponent`, `Geometry2DComponent`, `Geometry3DComponent`, `GeospatialComponent`, `HAnimComponent`, `KeyDeviceSensorComponent`, `LayoutComponent`, `ParticleSystemsComponent`, `PickingComponent`, `ScriptingComponent`, `TextureProjectionComponent`, `VolumeRenderingComponent`, `WebXRComponent` and `X_ITEComponent` (all `.min.js`). Their unminified builds have no numbered modules and no module paths outside X_ITE's own source. X_ITE's MIT licence in `LICENSE.md` covers them. The fonts carry their own licence files beside them, and `assets/images/logo.svg` is X_ITE's. `assets/lib/mkkellogg-sort.worker.js` is X_ITE's own Web Worker, which loads and runs the GaussianSplats3D sorter above; X_ITE's MIT licence covers it.

## 2. Licence texts

### 2.1 MIT License

The MIT permission notice below goes with each of these copyright lines:

- Copyright (c) 2009 Holger Seelig and other contributors (X_ITE)
- (c) 2016 Chris Hafey (CharLS.js 2.0.1 and OpenJPEG.js 0.10.2, the JavaScript builds)
- (c) 2017 Chris Hafey; Copyright 2016 Chris Hafey (dicom-parser)
- © 2018 Standard Cyborg, Inc. (nurbs)
- Copyright (c) 2013 Kyle Robinson Young (isndarray)
- Copyright (c) 2016-2025 Arseny Kapoulkine (meshoptimizer)

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

These MIT libraries have their own licence files, copied as they are.

SuperGif / libgif-js and jsgif:

```text
Copyright (c) 2011 Shachaf Ben-Kiki

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

apng-js 1.1.5:

```text
The MIT License (MIT)

Copyright (c) 2016 David Mzareulyan

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
```

jpeg-lossless-decoder-js 2.1.2:

```text
Copyright (c) 2015 RII-UTHSCSA

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The `mikktspace` crate 0.3.0, its MIT option:

```text
Copyright (c) 2017 The mikktspace Library Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

opentype.js 2.0.0, from its npm package:

```text
The MIT License (MIT)

Copyright (c) 2020 Frederik De Bleser

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

tiny-inflate 1.0.3, from its npm package:

```text
MIT License

Copyright (c) 2015-present Devon Govett

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
```

mikktspace-wasm 1.1.1, from its npm package:

```text
The MIT License (MIT)

Copyright (c) 2021 Don McCurdy

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
```

woff2-encoder 2.0.0, its `LICENSE` at tag `v2.0.0` (the same file as in the npm package):

```text
MIT License

Copyright (c) 2023-PRESENT Kyedo <https://github.com/itskyedo>

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
```

WOFF2, its `LICENSE` at commit `4721483`:

```text
Copyright (c) 2013-2017 by the WOFF2 Authors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Brotli, its `LICENSE` at commit `533843e`:

```text
Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

GaussianSplats3D, its `LICENSE` at tag `v0.4.7`:

```text
The MIT License (MIT)

Copyright (c) 2023 Mark Kellogg

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
```

Emscripten, its `LICENSE` at tag `3.1.46`, in full; the lab takes its MIT option:

```text
Emscripten is available under 2 licenses, the MIT license and the
University of Illinois/NCSA Open Source License.

Both are permissive open source licenses, with little if any
practical difference between them.

The reason for offering both is that (1) the MIT license is
well-known, while (2) the University of Illinois/NCSA Open Source
License allows Emscripten's code to be integrated upstream into
LLVM, which uses that license, should the opportunity arise.

The full text of both licenses follows.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal with the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimers.

    Redistributions in binary form must reproduce the above
    copyright notice, this list of conditions and the following disclaimers
    in the documentation and/or other materials provided with the
    distribution.

    Neither the names of Mozilla,
    nor the names of its contributors may be used to endorse
    or promote products derived from this Software without specific prior
    written permission. 

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE SOFTWARE.

==============================================================================

This program uses portions of Node.js source code located in src/library_path.js,
in accordance with the terms of the MIT license. Node's license follows:

    """
        Copyright Joyent, Inc. and other Node contributors. All rights reserved.
        Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to
        deal in the Software without restriction, including without limitation the
        rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
        sell copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:

        The above copyright notice and this permission notice shall be included in
        all copies or substantial portions of the Software.

        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
        FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
        IN THE SOFTWARE.
    """

The musl libc project is bundled in this repo, and it has the MIT license, see
system/lib/libc/musl/COPYRIGHT

The third_party/ subdirectory contains code with other licenses. None of it is
used by default, but certain options use it (e.g., the optional closure compiler
flag will run closure compiler from third_party/).
```

### 2.2 MIT notices inside X_ITE's unminified build

Node.js's `events` module, from `dist/x_ite.mjs` in the package, without its comment markers:

```text
Copyright Joyent, Inc. and other Node contributors.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```

DOMIntegration, from `dist/x_ite.mjs` in the package:

```text
/*******************************************************************************
 * MIT License
 *
 * Copyright (c) 2016 Andreas Plesch
 * taken from https://github.com/andreasplesch/x_ite_dom.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 ******************************************************************************/
```

### 2.3 BSD-3-Clause

CharLS (the same file in CharLS.js):

```text
Copyright (c) 2007-2010, Jan de Vaan
All rights reserved.

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this 
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice, 
  this list of conditions and the following disclaimer in the documentation 
  and/or other materials provided with the distribution.

* Neither the name of my employer, nor the names of its contributors may be 
  used to endorse or promote products derived from this software without 
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES 
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; 
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON 
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT 
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS 
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. 
```

jpeg-js:

```text
Copyright (c) 2014, Eugene Ware
All rights reserved.
  
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:  

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.  
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.  
3. Neither the name of Eugene Ware nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.  
  
THIS SOFTWARE IS PROVIDED BY EUGENE WARE ''AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 2.4 BSD-2-Clause

OpenJPEG (the same file in OpenJPEG.js):

```text
/*
 * The copyright in this software is being made available under the 2-clauses 
 * BSD License, included below. This software may be subject to other third 
 * party and contributor rights, including patent rights, and no such rights
 * are granted under this license.
 *
 * Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium
 * Copyright (c) 2002-2014, Professor Benoit Macq
 * Copyright (c) 2003-2014, Antonin Descampe
 * Copyright (c) 2003-2009, Francois-Olivier Devaux
 * Copyright (c) 2005, Herve Drolon, FreeImage Team
 * Copyright (c) 2002-2003, Yannick Verschueren
 * Copyright (c) 2001-2003, David Janssens
 * Copyright (c) 2011-2012, Centre National d'Etudes Spatiales (CNES), France 
 * Copyright (c) 2012, CS Systemes d'Information, France
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS `AS IS'
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
```

### 2.5 zlib

ammo.js:

```text
Copyright (c) 2011 ammo.js contributors

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

---

See AUTHORS for list of contributors.
```

Bullet 2.82, `COPYING`:

```text
/*
Bullet Continuous Collision Detection and Physics Library
Copyright (c) 2003-2011 Erwin Coumans  http://bulletphysics.org

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the use of this software.
Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely,
subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
*/

All files in the Bullet/src folder are under this Zlib license.
Files in the Extras and Demos folder may have a different license, see the respective files.
```

Bullet 2.82, `BulletLicense.txt`:

```text
/*
Copyright (c) 2003-2010 Erwin Coumans  http://continuousphysics.com/Bullet/

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the use of this software.
Permission is granted to anyone to use this software for any purpose, 
including commercial applications, and to alter it and redistribute it freely, 
subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
*/


Free for commercial use, please report projects in the forum at http://www.bulletphysics.org

In case you want to display a Bullet logo in your software: you can download the Bullet logo in various vector formats and high resolution at the download section in http://bullet.googlecode.com
```

### 2.6 Apache License 2.0

The Apache License 2.0 text is in `LICENSES/Apache-2.0.txt` in this folder. It covers Draco, nalgebra 0.26.2, the jpeg-js decoder's own header and the glTF Sample Viewer's look-up tables, and, if taken under that licence, Rust's standard library. Apache-2.0 also asks for the attributions of any NOTICE file. None of these has a NOTICE file at the root of its repository at the version named: Draco 1.5.9, jpeg-js v0.4.4, nalgebra v0.26.2, the `mikktspace` crate at `b34fbc4`, the glTF Sample Viewer at `f22c8b8`, and Rust at the commit that built this file.

The jpeg-js decoder's own header, from `dist/assets/components/Texturing3DComponent.js` in the package:

```text
/*
   Copyright 2011 notmasteryet

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
```

nalgebra's copyright line, from the end of its `LICENSE` at tag `v0.26.2`:

```text
   Copyright 2020 Sébastien Crozet
```

### 2.7 SGI Free Software License B 2.0 (libtess)

Also in `LICENSE.md`:

```text
/**
 * @license
 * Copyright 2000, Silicon Graphics, Inc. All Rights Reserved.
 * Copyright 2015, Google Inc. All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice including the dates of first publication and
 * either this permission notice or a reference to http://oss.sgi.com/projects/FreeB/
 * shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * SILICON GRAPHICS, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 * IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Original Code. The Original Code is: OpenGL Sample Implementation,
 * Version 1.2.1, released January 26, 2000, developed by Silicon Graphics,
 * Inc. The Original Code is Copyright (c) 1991-2000 Silicon Graphics, Inc.
 * Copyright in any portions created by third parties is as indicated
 * elsewhere herein. All Rights Reserved.
 */
```

## 3. What this file does not cover

- Code that compilers built into these files was not traced to its own licence files: Rust's standard library in `mikktspace_bg.wasm` (MIT OR Apache-2.0), and the Emscripten runtime, with its C and C++ libraries, in ammo.js, CharLS.js, OpenJPEG.js and Draco. For `woff2_decoder.js`, Emscripten's own licence, at the version its build names, is in 2.1; the C and C++ libraries Emscripten linked into it (musl, libc++) were not traced to their own licence files.
- nalgebra 0.26.2: the crate's record says BSD-3-Clause and the `LICENSE` file at its tag says Apache-2.0. This file follows the `LICENSE` file.
- Copyright lines in single source files of OpenJPEG and Bullet were not read. Bullet's `COPYING` says files outside its `src` folder may have a different licence.
- The copyright lines of dicom-parser, nurbs and isndarray are from their npm registry pages, not from licence files in their repositories.
- The glTF Sample Viewer's `LICENSE.md` has no copyright line, and none was found for the look-up tables. This file names Khronos Group Inc. only as the author the project's `package.json` gives.
- X_ITE's `assets/lib/libktx.js` and `assets/lib/libktx.wasm` are not served. `THIRD_PARTY_NOTICES.md` at the root of the Open Spatial Lab repository says why.
