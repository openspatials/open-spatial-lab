# GeoPose Basic-YPR schema

`GeoPose.Basic.YPR.Schema.json` is the OGC GeoPose Basic-YPR JSON schema, from
https://github.com/opengeospatial/GeoPose (Apache-2.0), `Data/Schemata/`, last changed there in
April 2021.

One edit: the repository's file names the position member `location`. Its own example instances
(`standard/standard/Instances/GeoPose.Basic.YPR.Instance.*.json`) and the Web of Worlds API call it
`position`, so this copy does too. The definition is renamed from `Location` to `Position`.
Nothing else differs.

The schema sets no bounds on latitude or longitude. The shared reader in `web/wow-geopose.js`
checks them itself, and `tools/arch-i1/proof.js` (check F4) shows the schema accepting a value that
the reader refuses.
