// Finite JSON scene vocabulary. These declarations do not implement entire X3D profiles.
import { checkField } from "../../scene/check.mjs";

export const SOFT_BODY_COMPATIBILITY = "carlson-soft-body-1";
export const SOFT_BODY_SHA256 = "c7b42847b502f9c895bec63e05eb5cbc7423e11a8dce47447b0897c05c50a0e6";

/** Recursively seals plain values, including shared node references. */
export function sealX3dValue(value, seen = new WeakSet()) {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        for (const child of Object.values(value)) sealX3dValue(child, seen);
        Object.freeze(value);
    }
    return value;
}

const field = (type, initial) => ({ type, initial });
const sceneTypes = "WorldInfo NavigationInfo Viewpoint Background DirectionalLight EnvironmentLight Transform Shape Anchor ProximitySensor RigidBodyCollection";
const children = field(`nodes:${sceneTypes}`, []);
export const X3D_SCENE_TYPES = sceneTypes.split(" ");
export const X3D_FIELDS = sealX3dValue({
    WorldInfo: { title: field("string", ""), info: field("strings", []) },
    NavigationInfo: { type: field("navigation", ["WALK", "ANY"]), avatarSize: field("nonnegative3", [0.25, 1.6, 0.75]), speed: field("nonnegative", 1), headlight: field("boolean", true) },
    Viewpoint: { description: field("string", ""), position: field("vec3", [0, 0, 10]), orientation: field("rotation", [0, 0, 1, 0]), fieldOfView: field("fov", Math.PI / 4), centerOfRotation: field("vec3", [0, 0, 0]) },
    Background: { skyColor: field("color", [0, 0, 0]) },
    DirectionalLight: { color: field("color", [1, 1, 1]), direction: field("direction", [0, 0, -1]), intensity: field("unit", 1), ambientIntensity: field("unit", 0), global: field("boolean", false) },
    EnvironmentLight: { color: field("color", [1, 1, 1]), ambientIntensity: field("unit", 0) },
    Transform: { translation: field("vec3", [0, 0, 0]), rotation: field("rotation", [0, 0, 1, 0]), children },
    Shape: { appearance: field("node:Appearance", null), geometry: field("node:Box Cylinder Sphere Text ElevationGrid", null) },
    Appearance: { material: field("node:Material", null) },
    Material: { diffuseColor: field("color", [0.8, 0.8, 0.8]), emissiveColor: field("color", [0, 0, 0]), ambientIntensity: field("unit", 0.2) },
    Box: { size: field("positive3", [2, 2, 2]) },
    Cylinder: { radius: field("positive", 1), height: field("positive", 2) },
    Sphere: { radius: field("positive", 1) },
    Text: { string: field("strings", []), fontStyle: field("node:FontStyle", null) },
    FontStyle: { size: field("positive", 1), justify: field("justify", ["BEGIN", "FIRST"]) },
    Anchor: { description: field("string", ""), url: field("strings", []), parameter: field("strings", []), children, metadata: field("node:MetadataSet", null) },
    ProximitySensor: { center: field("vec3", [0, 0, 0]), size: field("nonnegative3", [0, 0, 0]), enabled: field("boolean", true) },
    MetadataSet: { name: field("string", ""), reference: field("string", ""), value: field("nodes:MetadataString MetadataFloat", []) },
    MetadataString: { name: field("string", ""), value: field("strings", []) },
    MetadataFloat: { name: field("string", ""), value: field("numbers", []) },
    RigidBodyCollection: { gravity: field("vec3", [0, -9.8, 0]), bodies: field("nodes:RigidBody SoftBody", []), joints: field("nodes:SingleAxisHingeJoint Stitch", []) },
    RigidBody: { mass: field("nonnegative", 1), position: field("vec3", [0, 0, 0]), geometry: field("nodes:CollidableShape", []) },
    SoftBody: { mass: field("positive", 1), position: field("vec3", [0, 0, 0]), geometry: field("nodes:CollidableShape", []) },
    CollidableShape: { shape: field("node:Shape", null) },
    ElevationGrid: { xDimension: field("dimension", 2), zDimension: field("dimension", 2), xSpacing: field("positive", 1), zSpacing: field("positive", 1) },
    SingleAxisHingeJoint: { anchorPoint: field("vec3", [0, 0, 0]), axis: field("direction", [0, 1, 0]), body1: field("node:RigidBody", null), body2: field("node:RigidBody", null) },
    Stitch: { body1Index: field("indices", []), weight: field("units", []), body1: field("node:RigidBody", null), body2: field("node:SoftBody", null) },
});
Object.freeze(X3D_SCENE_TYPES);

/** Throws a path-bearing TypeError for values outside the supported field domain. */
export function validateX3dField(type, value, path) {
    let valid;
    switch (type) {
        case "justify": valid = checkField("strings", value) && value.every((v) => ["BEGIN", "MIDDLE", "END", "FIRST"].includes(v)) && value.length >= 1 && value.length <= 2; break;
        case "navigation": valid = checkField("strings", value) && value.every((v) => ["WALK", "EXAMINE", "ANY", "NONE"].includes(v)) && value.length > 0; break;
        default: valid = checkField(type, value) === true;
    }
    if (!valid) throw new TypeError(`${path}: expected ${type}`);
}
