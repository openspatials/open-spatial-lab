// Distribution of the shared catalog item records; edit the canonical catalog, then refresh this projection.
export const SHARED_CATALOG_ITEMS = Object.freeze([
  {
    "key": "item-equip-hat",
    "label": "Wide-brim explorer hat",
    "url": "/assets/equip-hat.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "head",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "Head"
      },
      "vrm": {
        "humanoid_bone": "head"
      },
      "hanim": {
        "name": "osl_head_equipment_pt",
        "parent_segment": "skull",
        "parent_joint": "skullbase",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "worn",
        "hands": 0,
        "placement": {
          "anchor": "head",
          "rotation": [
            0,
            0,
            0,
            1
          ],
          "attach_point": [
            0,
            0.5,
            0
          ],
          "head_surface": {
            "crown_span": [
              0.84,
              0.84
            ],
            "clearance_m": 0.003
          }
        }
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  },
  {
    "key": "item-equip-helmet",
    "label": "Iron helmet",
    "url": "/assets/equip-helmet.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "head",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "Head"
      },
      "vrm": {
        "humanoid_bone": "head"
      },
      "hanim": {
        "name": "osl_head_equipment_pt",
        "parent_segment": "skull",
        "parent_joint": "skullbase",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "worn",
        "hands": 0,
        "placement": {
          "anchor": "head",
          "rotation": [
            0.016261,
            0,
            0,
            0.999868
          ],
          "attach_point": [
            0,
            0.35,
            -0.025
          ],
          "scale_with": "head_width_m",
          "offset": {
            "up": {
              "measure": "head_height_m",
              "factor": 0.3933
            },
            "forward": {
              "measure": "head_depth_m",
              "factor": -0.0323
            },
            "right": {
              "measure": "head_width_m",
              "factor": 0
            }
          }
        },
        "scale_m_per_unit": 0.24
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  },
  {
    "key": "item-equip-crown",
    "label": "Gold crown",
    "url": "/assets/equip-crown.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "head",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "Head"
      },
      "vrm": {
        "humanoid_bone": "head"
      },
      "hanim": {
        "name": "osl_head_equipment_pt",
        "parent_segment": "skull",
        "parent_joint": "skullbase",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "worn",
        "hands": 0,
        "placement": {
          "anchor": "head",
          "rotation": [
            0.016261,
            0,
            0,
            0.999868
          ],
          "attach_point": [
            0,
            0.6,
            0
          ],
          "scale_with": "head_width_m",
          "offset": {
            "up": {
              "measure": "head_height_m",
              "factor": 0.5868
            },
            "forward": {
              "measure": "head_depth_m",
              "factor": 0.0013
            },
            "right": {
              "measure": "head_width_m",
              "factor": 0
            }
          }
        },
        "scale_m_per_unit": 0.155
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  },
  {
    "key": "item-equip-hammer",
    "label": "War hammer",
    "url": "/assets/equip-hammer.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "rightHand",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "hand_r"
      },
      "vrm": {
        "humanoid_bone": "rightHand"
      },
      "hanim": {
        "name": "osl_right_hand_equipment_pt",
        "parent_segment": "r_carpal",
        "parent_joint": "r_radiocarpal",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "held",
        "hands": 1,
        "hand": "r",
        "stance": "sword_idle",
        "grip": {
          "clip": "sword_idle",
          "time": 0
        },
        "contacts": {
          "r": {
            "point": [
              0,
              0.25,
              0
            ],
            "grip_axis": [
              0,
              1,
              0
            ],
            "forward_axis": [
              1,
              0,
              0
            ]
          }
        },
        "placement": {
          "anchor": "hand",
          "contact_on_hand": "hollow"
        },
        "scale": 0.4
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  },
  {
    "key": "item-equip-torch",
    "label": "Torch",
    "url": "/assets/equip-torch.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "leftHand",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "hand_l"
      },
      "vrm": {
        "humanoid_bone": "leftHand"
      },
      "hanim": {
        "name": "osl_left_hand_equipment_pt",
        "parent_segment": "l_carpal",
        "parent_joint": "l_radiocarpal",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "held",
        "hands": 1,
        "hand": "l",
        "stance": "idle_torch_loop",
        "grip": {
          "clip": "idle_torch_loop",
          "time": 0
        },
        "contacts": {
          "l": {
            "point": [
              0,
              0.3,
              0
            ],
            "grip_axis": [
              0,
              1,
              0
            ],
            "forward_axis": [
              0,
              0,
              1
            ]
          }
        },
        "placement": {
          "anchor": "hand",
          "contact_on_hand": "hollow"
        },
        "scale": 0.35
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  },
  {
    "key": "item-equip-shield",
    "label": "Round shield",
    "url": "/assets/equip-shield.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "leftHand",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "hand_l"
      },
      "vrm": {
        "humanoid_bone": "leftHand"
      },
      "hanim": {
        "name": "osl_left_hand_equipment_pt",
        "parent_segment": "l_carpal",
        "parent_joint": "l_radiocarpal",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "held",
        "hands": 1,
        "hand": "l",
        "stance": "idle_shield_loop",
        "grip": {
          "clip": "idle_shield_loop",
          "time": 0
        },
        "contacts": {
          "l": {
            "point": [
              0,
              0,
              0.165
            ],
            "grip_axis": [
              0,
              1,
              0
            ],
            "forward_axis": [
              1,
              0,
              0
            ]
          }
        },
        "placement": {
          "anchor": "hand",
          "contact_on_hand": "hollow"
        },
        "scale": 0.38
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  },
  {
    "key": "item-equip-mug",
    "label": "Tankard",
    "url": "/assets/equip-mug.glb",
    "attachment": {
      "schema": "osl-equipment-attachment/1",
      "glb": {
        "role": "leftHand",
        "bone_lookup": "body.roles",
        "reference_rig": "actionforge",
        "reference_bone": "hand_l"
      },
      "vrm": {
        "humanoid_bone": "leftHand"
      },
      "hanim": {
        "name": "osl_left_hand_equipment_pt",
        "parent_segment": "l_carpal",
        "parent_joint": "l_radiocarpal",
        "standard": "ISO/IEC 19774-1:2019",
        "project_defined_site": true,
        "transform": "inverse(parent_segment_in_avatar) * item_in_avatar",
        "child_transform": "identity"
      },
      "fit": {
        "mode": "held",
        "hands": 1,
        "hand": "l",
        "stance": "idle_torch_loop",
        "grip": {
          "clip": "consume",
          "time": 0.6667
        },
        "contacts": {
          "l": {
            "point": [
              0.35,
              0.3,
              0
            ],
            "grip_axis": [
              0,
              1,
              0
            ],
            "forward_axis": [
              -1,
              0,
              0
            ]
          }
        },
        "placement": {
          "anchor": "hand",
          "contact_on_hand": "hollow"
        },
        "scale": 0.28
      },
      "evaluated_pose": {
        "frame": "avatar-holder",
        "units": "metres",
        "matrix": "column-major-4x4",
        "update": "after existing avatar step"
      }
    },
    "license": "CC0-1.0",
    "license_holder": "Open Spatial Lab (original asset made for the project)"
  }
]);
