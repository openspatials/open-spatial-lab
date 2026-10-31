# Third-party code inside the X3DOM files

The files in this folder are X3DOM 1.8.3. `x3dom-full.js` is the file `x3dom.js` of the npm package `x3dom` 1.8.3, byte for byte (SHA-256 `0d336683d039d19c94a4b748299a13270db3a9e71edfccbf6ad6a58133e1b3fb`; the package's npm integrity is `sha512-sqd4bIyKEKcGG+D9fa7lB5oiOeN57a1FzX0HBZvrOGwVmFTYjNmT3zqEobzqo/YaDYc7FWi2Dvt6RBVPMXyuXA==`). Its header names X3DOM 1.8.3, build 7482, revision `03da6d38708e4eafc94c2305fdc175312a880321` of https://github.com/x3dom/x3dom. `x3dom.css` and `package.json` are the package's files with Windows line ends made Unix ones. `LICENSE.md` is X3DOM's `LICENSE.md` at that revision, the same git blob. `VERSION` names the version. This file is Open Spatial Lab's.

X3DOM is dual licensed under the MIT and GPL licences, Copyright (c) 2009-2020 X3DOM. Open Spatial Lab takes MIT. Both texts are in `LICENSE.md`.

The built file carries no licence notices. This file names the code from other projects inside it, with its copyright line, licence, source and version, and gives each licence text.

## 1. What is inside `x3dom-full.js`

X3DOM's build list at that revision, `build/core/packages.json`, puts 240 source files into its BASIC set, and the package's `x3dom.js` is that set. Every string literal in the built file is in those 240 files, or is made of pieces of them that the minifier joined, or is the build's own version, build number, revision and date. The 182 node types the built file registers are all from that set. None of the files of X3DOM's FULL set (the Geospatial, Layout, Geometry2D, VolumeRendering, CADGeometry, BVHRefiner, Geometry3DExt, H-Anim and NURBS nodes, and the Draco decoder `draco-1.5.5.js`) or of its PHYSICS set (the RigidBodyPhysics nodes and ammo.js) is in it. The built file refers to a Draco decoder and to dash.js but holds neither; a page has to load them itself, and neither is in this folder.

Two of the 240 files hold code from other projects.

### 1.1 Code from other projects

- **earcut**, https://github.com/mapbox/earcut, as `x3dom.EarCut` in X3DOM's `src/util/EarClipping.js`. ISC. Copyright (c) 2015, Mapbox. X3DOM took it on 2015-11-19 (commit `16b12aa`, "use mapbox/earcut library"), with earcut's copyright line and permission notice in a comment, which the minifier drops. X3DOM names no version. earcut's latest release that day was v2.0.7, and earcut's `LICENSE` is the same file at every release from v2.0.0 to v2.0.7. The text, read from that file at tag `v2.0.7`, is in 2.1.
- **es6-promise** 4.2.4, https://github.com/stefanpenner/es6-promise, as the Promise polyfill in X3DOM's `src/util/Promise.js`. MIT. Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors. X3DOM took it in 2018 (commit `8d61fa4`) as a minified build with no version line. Its code is es6-promise 4.2.4's `dist/es6-promise.auto.min.js`, token for token, apart from the module wrapper X3DOM took out (commit `d3b277e`) and the braces, semicolons and one pair of parentheses its lint pass added (commit `ad07930`). The text, read from its `LICENSE` at tag `v4.2.4`, is in 2.2.

### 1.2 Credits inside X3DOM's own files

The headers of X3DOM's source files, which the minifier also drops, name the following. Each of these files carries X3DOM's line "Dual licensed under the MIT and GPL", and `LICENSE.md` covers them.

- Fraunhofer IGD, Darmstadt, Germany: "(C)2009" in most files, "(C)2018" in `JSONParser.js` and `PrototypeExpander.js`, and "(C)2020" in `PointProperties.js`.
- Philip Taylor, http://philip.html5.org: 46 of the files say they are based on code he originally provided.
- Andreas Plesch: "(C)2020 Andreas Plesch, Waltham, MA" in `NodeNameSpaceProtos.js` and `ProtoDeclaration.js`; "(C) 2017 Andreas Plesch" in `WalkNavigation.js`; "(C)2017 A. Plesch, Fraunhofer IGD" in `CoordinateDouble.js`; "(C)2009, 2017, A. Plesch, Fraunhofer IGD" in nine EventUtilities files.
- Toshiba Corporation, Japan: "(C)2014" in `SplinePositionInterpolator.js` and `SphereSensor.js`.
- John Carlson's X3DJSONLD, https://coderextreme.net/X3DJSONLD, on which `JSONParser.js` and `PrototypeExpander.js` say they are based.

### 1.3 What X3DOM's licence alone covers

- `OrientationChaser.js` and `PositionChaser.js` say their handler code "was basically taken from" http://www.hersto.com/X3D/Followers. They carry X3DOM's licence line and state no other licence.
- `x3dom.BRDF_LUT`, a 256 by 256 PNG look-up table written into `Internals.js` as a data address. X3DOM states no other origin for it.
- `requestAnimFrame` in `Internals.js` points to Khronos's `webgl-utils.js` with "@see". Its body returns the browser's `requestAnimationFrame`, under its own or a prefixed name, or else a 16 ms timer.

## 2. Licence texts

### 2.1 ISC (earcut)

From https://github.com/mapbox/earcut, `LICENSE` at tag `v2.0.7`:

```
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
```

### 2.2 MIT (es6-promise)

From https://github.com/stefanpenner/es6-promise, `LICENSE` at tag `v4.2.4`:

```
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
```
