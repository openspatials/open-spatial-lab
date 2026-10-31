// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// runtime/scene-core/public/render-adapter/spatial-math.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: none.

// Pure 4x4 matrix math, independent of any render engine. Matrices are flat 16-element
// column-major arrays (element [col*4 + row]) — the same layout as three.js's Matrix4.elements
// and the WoW spec's `Node.localTransform` field (wow-spec/generated/schema.json).
//
// This exists so world-position/bounds computation over a WoW composition graph does not
// depend on a live engine scene graph (no renderer, no DOM attachment, no render tick) — the
// same computation must work identically whether the active render adapter is three.js or X3DOM,
// and must be able to run before anything is ever mounted.
export function multiplyMat4(ae, be) {
    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
    return [
        a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
        a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
        a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
        a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
        a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
        a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
        a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
        a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
        a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
        a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
        a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
        a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
        a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
        a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
        a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
        a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
    ];
}
export function transformPoint(m, p) {
    const x = p[0], y = p[1], z = p[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1;
    return [
        (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
        (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
        (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
}
/**
 * Decomposes an affine (translation * rotation * scale) matrix into its components.
 * Only valid for affine matrices (bottom row [0,0,0,1]) — true for every spatial transform
 * in this codebase (WoW graph nodes, scene content); never a perspective/projection matrix.
 */
export function decomposeTRS(m) {
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    // Affine 3x3 minor determinant; negative means an odd number of axes are mirrored, in
    // which case one scale component's sign must flip to reproduce the original matrix.
    const det3 = m[0] * (m[5] * m[10] - m[6] * m[9])
        - m[4] * (m[1] * m[10] - m[2] * m[9])
        + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (det3 < 0)
        sx = -sx;
    const translation = [m[12], m[13], m[14]];
    const invSx = sx !== 0 ? 1 / sx : 0;
    const invSy = sy !== 0 ? 1 / sy : 0;
    const invSz = sz !== 0 ? 1 / sz : 0;
    const m11 = m[0] * invSx, m21 = m[1] * invSx, m31 = m[2] * invSx;
    const m12 = m[4] * invSy, m22 = m[5] * invSy, m32 = m[6] * invSy;
    const m13 = m[8] * invSz, m23 = m[9] * invSz, m33 = m[10] * invSz;
    const trace = m11 + m22 + m33;
    let qx, qy, qz, qw;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        qw = 0.25 / s;
        qx = (m32 - m23) * s;
        qy = (m13 - m31) * s;
        qz = (m21 - m12) * s;
    }
    else if (m11 > m22 && m11 > m33) {
        const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        qw = (m32 - m23) / s;
        qx = 0.25 * s;
        qy = (m12 + m21) / s;
        qz = (m13 + m31) / s;
    }
    else if (m22 > m33) {
        const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        qw = (m13 - m31) / s;
        qx = (m12 + m21) / s;
        qy = 0.25 * s;
        qz = (m23 + m32) / s;
    }
    else {
        const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        qw = (m21 - m12) / s;
        qx = (m13 + m31) / s;
        qy = (m23 + m32) / s;
        qz = 0.25 * s;
    }
    return { translation, quaternion: [qx, qy, qz, qw], scale: [sx, sy, sz] };
}
/**
 * The inverse of decomposeTRS: builds a flat column-major matrix from separate translation/
 * quaternion/scale components (three.js's Matrix4.compose formula — the same convention this
 * file's header documents matching). Exists for callers that receive TRS-shaped authored data
 * (e.g. the equipment catalog's { position, quaternion, scale } items) but need to hand a matrix
 * to a RenderAdapter.setLocalMatrix() call.
 */
export function composeTRS(translation, quaternion, scale) {
    const [x, y, z, w] = quaternion;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const [sx, sy, sz] = scale;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        translation[0], translation[1], translation[2], 1,
    ];
}
export const IDENTITY_MAT4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
