// head-seat.mjs: the head-item seat rule of the Lab's avatar layer, as plain numbers. A worn head item (crown, hat, helmet) that
// the avatar layer attaches itself is seated on the rig's measured skull top, then sinks into it by a fraction of the item's
// own height: 0 would rest the item's underside exactly on the crown of the head; a crown or a hat wants to sit down into the
// hair rather than balance on it. The fraction is of the item, and the skull top is measured on each rig, so the same
// numbers seat the same item on any avatar height and any item scale. It replaces the catalog's authored absolute y-offsets
// for head items, which were written for one skull.
//
// Public API
//   HEAD_ITEM_SINK_FRACTION                       item id -> sink fraction; _default for any other item
//   headSeat({ itemId, headTop, underside, height })
//       headTop: the skull top above the head bone, underside: the item's lowest y with the item at y 0, height: the item's
//       height (both in the head bone's local frame, the item's scale folded in) -> { sink, y }: the fraction used and the
//       item's y. The caller measures the item (web/avatar-equipment-layer.js seatHeadItem); nothing here reads an object.
//
// No DOM use: browser and Node.

export const HEAD_ITEM_SINK_FRACTION = Object.freeze({
  "equip-crown": 0.34,
  "equip-hat": 0.42,
  "equip-helmet": 0.55,
  _default: 0.35,
});

export function headSeat({ itemId, headTop, underside, height }) {
  const sink =
    HEAD_ITEM_SINK_FRACTION[itemId] !== undefined
      ? HEAD_ITEM_SINK_FRACTION[itemId]
      : HEAD_ITEM_SINK_FRACTION._default;
  return { sink, y: headTop - underside - height * sink };
}
