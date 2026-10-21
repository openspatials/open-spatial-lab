'use strict';

/*
 * What a node's `localTransform` may be.
 *
 * It is a column-major 4x4 matrix in metres that maps the node's frame into its parent's frame. It
 * must decompose into translation, rotation and a non-zero scale, with no shear, which is what
 * glTF 2.0 section 3.5.3 requires of `node.matrix`. That keeps every matrix meaning one thing to
 * every reader: a node is a place, an orientation and a size.
 *
 * checkLocalTransform() returns null for a valid matrix, or { reason, message } for the first
 * thing wrong with it. The reasons are stable names a client can act on.
 */

// Column-major: the last ROW of the matrix is elements 3, 7, 11 and 15.
const LAST_ROW_TOLERANCE = 1e-9;
// Cosine of the angle between two basis columns beyond which the matrix is sheared. About 0.0006 degrees.
const SHEAR_TOLERANCE = 1e-5;
const ZERO_SCALE = 1e-12;

const REASONS = Object.freeze({
    NOT_AN_ARRAY : 'not_an_array',
    WRONG_LENGTH : 'wrong_length',
    NOT_FINITE : 'not_a_finite_number',
    LAST_ROW : 'last_row_not_0001',
    ZERO_SCALE : 'zero_scale',
    SHEAR : 'shear',
});

function refusal(reason, message)
{
    return { reason : reason, message : message };
}

function checkLocalTransform(m)
{
    if (!Array.isArray(m))
        return refusal(REASONS.NOT_AN_ARRAY, 'localTransform must be an array of 16 numbers');
    if (m.length !== 16)
        return refusal(REASONS.WRONG_LENGTH, 'localTransform has ' + m.length + ' elements; a 4x4 matrix has 16');
    for (let i = 0; i < 16; i += 1)
    {
        if (typeof m[i] !== 'number' || !Number.isFinite(m[i]))
            return refusal(REASONS.NOT_FINITE, 'localTransform[' + i + '] is not a finite number (an overflowing literal such as 1e999 parses to Infinity)');
    }
    if (Math.abs(m[3]) > LAST_ROW_TOLERANCE || Math.abs(m[7]) > LAST_ROW_TOLERANCE
        || Math.abs(m[11]) > LAST_ROW_TOLERANCE || Math.abs(m[15] - 1) > LAST_ROW_TOLERANCE)
        return refusal(REASONS.LAST_ROW, 'the last row of a column-major localTransform (elements 3, 7, 11, 15) must be 0, 0, 0, 1');

    const columns = [ [ m[0], m[1], m[2] ], [ m[4], m[5], m[6] ], [ m[8], m[9], m[10] ] ];
    const lengths = columns.map(c => Math.hypot(c[0], c[1], c[2]));
    const axis = [ 'x', 'y', 'z' ];
    for (let i = 0; i < 3; i += 1)
    {
        if (lengths[i] < ZERO_SCALE)
            return refusal(REASONS.ZERO_SCALE, 'the scale along ' + axis[i] + ' is zero, so the matrix does not decompose into translation, rotation and scale');
    }
    for (const [ i, j ] of [ [ 0, 1 ], [ 0, 2 ], [ 1, 2 ] ])
    {
        const cosine = (columns[i][0] * columns[j][0] + columns[i][1] * columns[j][1] + columns[i][2] * columns[j][2])
            / (lengths[i] * lengths[j]);
        if (Math.abs(cosine) > SHEAR_TOLERANCE)
            return refusal(REASONS.SHEAR, 'the ' + axis[i] + ' and ' + axis[j] + ' axes are not perpendicular (cosine ' + cosine.toFixed(6)
                + '), so the matrix has shear and does not decompose into translation, rotation and scale');
    }
    return null;
}

module.exports = { checkLocalTransform, REASONS };
