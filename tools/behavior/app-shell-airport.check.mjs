// The airport's two panels as a Player meets them: the storefront counter and the boarding gate.
//   node tools/behavior/app-shell-airport.check.mjs [--faults] [--only id,id]
import { runBehavior } from "./kit.mjs";
import { airportFaults, airportStatements } from "./app-shell-airport.mjs";

await runBehavior({ title: "app-shell-airport", firstPort: 36540, statements: airportStatements, faults: airportFaults });
