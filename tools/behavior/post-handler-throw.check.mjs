// A world server answers a POST whose handler throws: it answers 500 with a JSON error, writes the throw to its log,
// and stays up for the next request. Before, the throw landed in readBody's own catch, which had already settled, so
// the client waited for ever and nothing was logged. The body used here makes the movement handler throw
// (String() of an object whose toString is not a function); the movement handler itself is not changed.
// Run: node tools/behavior/post-handler-throw.check.mjs [--faults]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fail, runBehavior, waitUntil } from "./kit.mjs";

const ANSWER_LIMIT_MS = 15000;
const THROWS = '{"source":{"toString":1}}';
const THROW_LOGGED = /POST \/movement threw: TypeError/g;

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** One POST to world a. A request with no answer in time, or a broken connection, fails with its own reason. */
async function post(lab, path, text, limitMs = ANSWER_LIMIT_MS) {
  try {
    const response = await fetch(`${lab.address("a")}${path.slice(1)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: text, signal: AbortSignal.timeout(limitMs),
    });
    const body = await response.text();
    return { status: response.status, type: response.headers.get("content-type") || "", body, json: parse(body) };
  } catch (error) {
    if (error.name === "TimeoutError") fail(`no answer to POST ${path} (timed out after ${limitMs / 1000} s)`);
    return fail(`the connection for POST ${path} broke: ${(error.cause && error.cause.code) || error.message}`);
  }
}

async function healthy(lab, key) {
  try {
    const response = await fetch(`${lab.address(key)}healthz`, { signal: AbortSignal.timeout(ANSWER_LIMIT_MS) });
    return response.status;
  } catch (error) {
    return `no answer (${(error.cause && error.cause.code) || error.name})`;
  }
}

const position = (answer) => JSON.stringify(answer.json && answer.json.avatar && answer.json.avatar.transform.position);
const logOf = (lab) => readFileSync(join(lab.runDir, "runtime", "world-servers.log"), "utf8");
const loggedThrows = (lab) => (logOf(lab).match(THROW_LOGGED) || []).length;

const statements = [
  {
    id: "throwing-handler-answers",
    says: "a POST whose handler throws is answered 500 with a JSON error",
    async run(ctx) {
      const answer = await post(ctx.lab, "/movement", THROWS);
      expect(answer.status === 500, `POST /movement answered ${answer.status}, not 500: ${answer.body.slice(0, 120)}`);
      expect(answer.type.includes("application/json") && answer.json && answer.json.ok === false && typeof answer.json.error === "string",
        `the 500 is not a JSON error: ${answer.type} ${answer.body.slice(0, 120)}`);
      return `500 ${answer.json.error}`;
    },
  },
  {
    id: "throwing-handler-logged",
    says: "the throw is written to the server's log, once",
    async run(ctx) {
      const before = loggedThrows(ctx.lab);
      await post(ctx.lab, "/movement", THROWS, 5000).catch(() => null);
      const after = await waitUntil(() => { const n = loggedThrows(ctx.lab); return n > before ? n : 0; }, "the server's log has no line for the throw", { limitMs: 5000 });
      expect(after === before + 1, `the throw was logged ${after - before} times`);
      return "1 log line";
    },
  },
  {
    id: "server-keeps-serving",
    says: "after the throw every world still answers, and a good movement still moves the avatar",
    async run(ctx) {
      const still = await post(ctx.lab, "/movement", "{}");
      expect(still.status === 200, `POST /movement {} answered ${still.status}`);
      await post(ctx.lab, "/movement", THROWS, 5000).catch(() => null);
      const health = [];
      for (const key of ["a", "b", "lobby", "airport"]) health.push(`${key} ${await healthy(ctx.lab, key)}`);
      expect(health.every((line) => line.endsWith(" 200")), `after the throw: ${health.join(", ")}`);
      const moved = await post(ctx.lab, "/movement", '{"forward":1}');
      expect(moved.status === 200 && moved.json && moved.json.ok === true, `a good movement answered ${moved.status}: ${moved.body.slice(0, 120)}`);
      expect(position(moved) !== position(still), `a good movement left the avatar at ${position(still)}`);
      return `all four worlds 200, avatar ${position(still)} -> ${position(moved)}`;
    },
  },
  {
    id: "body-errors-unchanged",
    says: "a broken JSON body is still 400 bad_json, and an empty body is still taken as {}",
    async run(ctx) {
      const broken = await post(ctx.lab, "/movement", '{"source":');
      expect(broken.status === 400 && broken.json && broken.json.error === "bad_json", `broken JSON answered ${broken.status} ${broken.body.slice(0, 120)}`);
      const empty = await post(ctx.lab, "/movement", "");
      expect(empty.status === 200 && empty.json && empty.json.ok === true, `an empty body answered ${empty.status} ${empty.body.slice(0, 120)}`);
      return "400 bad_json, 200 for an empty body";
    },
  },
];

const SERVER = "runtime/world-server/src/server.js";
const HANDLER_CATCH = {
  file: SERVER,
  find: "            try { cb(err, value); }\n            catch (failure) { rejectUnreadableRequest(res, failure); }\n",
  replace: "            cb(err, value);\n",
};

const faults = [
  {
    statement: "throwing-handler-answers",
    name: "the handler runs inside the body parser's try, as before the fix",
    expect: /no answer to POST \/movement/,
    edits: [
      HANDLER_CATCH,
      {
        file: SERVER,
        find: "            let parsed;\n            try { parsed = JSON.parse(data); }\n            catch (err) { return finish(err, null); }\n            finish(null, parsed);\n",
        replace: "            try { finish(null, JSON.parse(data)); }\n            catch (err) { finish(err, null); }\n",
      },
    ],
  },
  {
    statement: "server-keeps-serving",
    name: "a throw from the handler is not caught, so it stops every world",
    expect: /after the throw: a no answer/,
    edits: [HANDLER_CATCH],
  },
  {
    statement: "throwing-handler-logged",
    name: "the throw is answered but not logged",
    expect: /the server's log has no line for the throw/,
    edits: [{
      file: SERVER,
      find: "        if (!unreadable)\n            console.error('[node][' + runtime.LOCATION_ID + '] ' + res.req.method + ' ' + String(res.req.url).slice(0, 200)\n                + ' threw: ' + (err && err.stack || err));\n",
      replace: "",
    }],
  },
  {
    statement: "body-errors-unchanged",
    name: "a broken JSON body is answered as a handler failure",
    expect: /broken JSON answered 500/,
    edits: [{
      file: SERVER,
      find: "            catch (err) { return finish(err, null); }\n",
      replace: "            catch (err) { return rejectUnreadableRequest(res, err); }\n",
    }],
  },
];

await runBehavior({ title: "post-handler-throw", firstPort: 40260, statements, faults });
