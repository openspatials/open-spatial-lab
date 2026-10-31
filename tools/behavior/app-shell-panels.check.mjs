// The panels a Player opens from the header, and what a crossing leaves in them: the Destinations panel, the
// notification center with the toast that points at it, the avatar selector's "none" choice, and what the page's
// teardown lets go of.
//   node tools/behavior/app-shell-panels.check.mjs [--faults] [--only id,id]
import { runBehavior } from "./kit.mjs";
import { headerFaults, headerStatements } from "./app-shell-header.mjs";

await runBehavior({ title: "app-shell-panels", firstPort: 36520, statements: headerStatements, faults: headerFaults });
