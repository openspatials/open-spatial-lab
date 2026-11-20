// Plain value checks shared by the Scene, importers and systems. Format-specific checks stay with their importer.

/** Freezes plain data in place, including shared references. Typed number arrays cannot be frozen and are left as they are. */
export function freezeDeep(value, seen = new WeakSet()) {
    if (value && typeof value === "object" && !seen.has(value) && !ArrayBuffer.isView(value)) {
        seen.add(value);
        for (const child of Object.values(value)) freezeDeep(child, seen);
        Object.freeze(value);
    }
    return value;
}

/** Returns false when the type is not one of the plain types, true or false for whether the value passes. */
export function checkField(type, value) {
    const finite = (v) => typeof v === "number" && Number.isFinite(v);
    const arrayOf = (test) => {
        if (!Array.isArray(value)) return false;
        for (let i = 0; i < value.length; i++) {
            if (!Object.hasOwn(value, i) || !test(value[i])) return false;
        }
        return true;
    };
    switch (type) {
        case "string": return typeof value === "string";
        case "boolean": return typeof value === "boolean";
        case "strings": return arrayOf((v) => typeof v === "string");
        case "numbers": return arrayOf(finite);
        case "indices": return arrayOf((v) => Number.isSafeInteger(v) && v >= 0);
        case "units": return arrayOf((v) => finite(v) && v >= 0 && v <= 1);
        case "positive": return finite(value) && value > 0;
        case "nonnegative": return finite(value) && value >= 0;
        case "unit": return finite(value) && value >= 0 && value <= 1;
        case "dimension": return Number.isSafeInteger(value) && value >= 2;
        case "fov": return finite(value) && value > 0 && value < Math.PI;
        case "vec3": case "color": case "nonnegative3": case "positive3": case "direction": {
            let valid = arrayOf(finite) && value.length === 3;
            if (valid && type === "color") valid = value.every((v) => v >= 0 && v <= 1);
            if (valid && type === "nonnegative3") valid = value.every((v) => v >= 0);
            if (valid && type === "positive3") valid = value.every((v) => v > 0);
            if (valid && type === "direction") valid = Math.hypot(...value) > 0;
            return valid;
        }
        // An axis and an angle in radians; a zero axis is admitted only with a zero angle.
        case "rotation": return arrayOf(finite) && value.length === 4 && (value[3] === 0 || Math.hypot(...value.slice(0, 3)) > 0);
        case "quaternion": return arrayOf(finite) && value.length === 4 && Math.hypot(...value) > 0;
        default: return undefined;
    }
}

/** Throws a path-bearing TypeError when the value is outside the plain type. */
export function validateField(type, value, path) {
    const valid = checkField(type, value);
    if (valid === undefined) throw new TypeError(`${path}: unknown field type ${type}`);
    if (!valid) throw new TypeError(`${path}: expected ${type}`);
}
