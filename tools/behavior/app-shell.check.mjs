// How a Player's page first looks and what it says about its connection: the first frame, loading, a world that does
// not answer or stops answering, the browser going offline, and the inspector that starts closed. The panels of the
// header are in app-shell-panels.check.mjs and the airport's in app-shell-airport.check.mjs; the three are separate so
// that each fits the runner's time limit.
//   node tools/behavior/app-shell.check.mjs [--faults] [--only id,id]
import { runBehavior } from "./kit.mjs";
import { connectionFaults, connectionStatements } from "./app-shell-connection.mjs";

await runBehavior({ title: "app-shell", firstPort: 36500, statements: connectionStatements, faults: connectionFaults });
