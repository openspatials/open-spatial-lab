import { readAvatarResources } from "./avatar-render-resources.mjs";

/** Read completed evaluator transforms; this bridge never advances a clip or writes a joint. */
export function readEvaluatedAvatarPose({ instance, equipment = null, catalogKey = null }) {
  const root = instance?.holder;
  if (!instance?.bones || !root) return null;
  const entries = Object.entries(instance.bones);
  const ids = new Map(entries.map(([id, bone]) => [bone, id]));
  const parents = entries.map(([, bone]) => {
    let parent = bone.parent;
    while (parent && parent !== root && !ids.has(parent)) parent = parent.parent;
    return parent && ids.has(parent) ? parent : root;
  });
  const matrix = value => {
    const values = value?.toArray?.() || value?.elements;
    if (!values || values.length !== 16 || !Array.from(values).every(Number.isFinite)) throw new TypeError("Invalid evaluated matrix");
    return Array.from(values);
  };
  const attachments = typeof equipment?.attachmentPoses === "function"
    ? equipment.attachmentPoses().map(pose => ({
      ...pose, itemMatrix: Array.from(pose.itemMatrix), parentMatrix: Array.from(pose.parentMatrix),
      hanimSite: pose.hanimSite ? { ...pose.hanimSite } : null,
    })) : [];
  for (const pose of attachments) {
    if (pose.frame !== "avatar-holder" || pose.units !== "metres" || pose.matrixOrder !== "column-major" ||
        [pose.itemMatrix, pose.parentMatrix].some(m => m.length !== 16 || !m.every(Number.isFinite)))
      throw new TypeError("Invalid evaluated attachment pose");
  }
  return {
    catalogKey, rootMatrix: matrix(root.matrixWorld), rootFrame: "world",
    frame: "avatar-holder", jointFrame: "nearest-mapped-parent-or-holder", units: "metres", matrixOrder: "column-major",
    jointIds: entries.map(([id]) => id), parentJointIds: parents.map(parent => ids.get(parent) || null),
    jointLocalMatrices: entries.map(([, bone], index) => matrix(parents[index].matrixWorld.clone().invert().multiply(bone.matrixWorld))), attachments,
    attachmentStatus: typeof equipment?.attachmentPoses === "function" ? "evaluated" : "unavailable",
  };
}

/** Capture once at adoption, before the evaluator's first step. Imported skin
 * bind matrices retain their explicit mesh bind space; they are never refitted. */
export function readAvatarBindDescription(instance, items = null) {
  const pose = readEvaluatedAvatarPose({ instance });
  if (!pose) return null;
  return {
    schema: "avatar-render/1",
    jointIds: pose.jointIds, parentJointIds: pose.parentJointIds,
    parentIndices: pose.parentJointIds.map(id => id == null ? -1 : pose.jointIds.indexOf(id)),
    jointFrame: pose.jointFrame, bindLocalMatrices: pose.jointLocalMatrices,
    units: "metres", matrixOrder: "column-major",
    resources: readAvatarResources(instance, items),
    skins: (instance.skinnedMeshes || []).map(mesh => ({
      name: mesh.name, frame: "mesh-skin-bind",
      jointIds: mesh.skeleton.bones.map(bone => bone.name),
      inverseBindMatrices: mesh.skeleton.boneInverses.map(matrix => matrix.toArray()),
      bindMatrix: mesh.bindMatrix.toArray(), bindMatrixInverse: mesh.bindMatrixInverse.toArray(),
    })),
  };
}
