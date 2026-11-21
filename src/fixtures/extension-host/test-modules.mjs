// Small WebAssembly core modules for the extension host checks, written out as bytes so no compiler is needed. Each
// imports only Sneeze.Call (i32, i32) -> i64 and exports memory, Init, Alloc, Free, Open, Close and Shutdown; only Init
// (and _initialize) differ:
//
//   loopsForever      Init loops for ever.
//   initialPages2048  declares 2,048 initial pages (128 MiB); Init returns.
//   growsMemory       Init grows memory one page at a time until memory.grow returns -1, and traps if 300 grows all
//                     succeed (300 pages is over a 16 MiB budget).
//   needsInitialize   _initialize sets a global; Init traps unless it is set.

const I32 = 0x7f, I64 = 0x7e;
const END = 0x0b;

const uleb = (value) => {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
};
const name = (text) => [...uleb(text.length), ...new TextEncoder().encode(text)];
const vector = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];

// Types: 0 Call (i32 i32)->i64, 1 ()->(), 2 Alloc (i32)->i32, 3 Free (i32 i32)->(), 4 Open (i64 i32 i32)->(), 5 Close (i64)->()
const TYPES = [
  [0x60, ...vector([[I32], [I32]]), ...vector([[I64]])],
  [0x60, 0x00, 0x00],
  [0x60, ...vector([[I32]]), ...vector([[I32]])],
  [0x60, ...vector([[I32], [I32]]), 0x00],
  [0x60, ...vector([[I64], [I32], [I32]]), 0x00],
  [0x60, ...vector([[I64]]), 0x00],
];

// Function bodies (locals vector, then instructions, then end).
const EMPTY = [0x00, END];
const ALLOC_1024 = [0x00, 0x41, 0x80, 0x08, END]; // i32.const 1024
const LOOP_FOR_EVER = [0x00, 0x03, 0x40, 0x0c, 0x00, END, END]; // loop br 0 end
const GROW_UNTIL_REFUSED = [
  0x01, 0x01, I32, // one i32 local: the count of grows
  0x02, 0x40, // block
  0x03, 0x40, //   loop
  0x41, 0x01, 0x40, 0x00, //     memory.grow (i32.const 1)
  0x41, 0x7f, 0x46, 0x0d, 0x01, //     i32.const -1, i32.eq, br_if 1 (refused: done)
  0x20, 0x00, 0x41, 0x01, 0x6a, 0x22, 0x00, //     local.get 0, i32.const 1, i32.add, local.tee 0
  0x41, 0xac, 0x02, 0x49, 0x0d, 0x00, //     i32.const 300, i32.lt_u, br_if 0 (grow again)
  END, //   end loop
  0x00, //   unreachable: 300 grows succeeded
  END, // end block
  END,
];
const SET_READY = [0x00, 0x41, 0x01, 0x24, 0x00, END]; // global.set 0 (i32.const 1)
const TRAP_UNLESS_READY = [0x00, 0x23, 0x00, 0x45, 0x04, 0x40, 0x00, END, END]; // global.get 0, i32.eqz, if unreachable end

function coreModule({ pages, init, initialize = null }) {
  // Function 0 is the import; defined functions start at 1.
  const funcs = [
    { export: "Init", type: 1, body: init },
    { export: "Alloc", type: 2, body: ALLOC_1024 },
    { export: "Free", type: 3, body: EMPTY },
    { export: "Open", type: 4, body: EMPTY },
    { export: "Close", type: 5, body: EMPTY },
    { export: "Shutdown", type: 1, body: EMPTY },
    ...(initialize ? [{ export: "_initialize", type: 1, body: initialize }] : []),
  ];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector(TYPES)),
    ...section(2, vector([[...name("Sneeze"), ...name("Call"), 0x00, 0x00]])),
    ...section(3, vector(funcs.map((func) => uleb(func.type)))),
    ...section(5, vector([[0x00, ...uleb(pages)]])),
    ...(initialize ? section(6, vector([[I32, 0x01, 0x41, 0x00, END]])) : []),
    ...section(7, vector([[...name("memory"), 0x02, 0x00], ...funcs.map((func, i) => [...name(func.export), 0x00, ...uleb(i + 1)])])),
    ...section(10, vector(funcs.map((func) => [...uleb(func.body.length), ...func.body]))),
  ];
  return new Uint8Array(bytes);
}

export const TEST_MODULES = Object.freeze({
  loopsForever: () => coreModule({ pages: 1, init: LOOP_FOR_EVER }),
  initialPages2048: () => coreModule({ pages: 2048, init: EMPTY }),
  growsMemory: () => coreModule({ pages: 1, init: GROW_UNTIL_REFUSED }),
  needsInitialize: () => coreModule({ pages: 1, init: TRAP_UNLESS_READY, initialize: SET_READY }),
});

// ---- ue-core/0 modules ----
//
// Each imports only ue.call (i32 offset, i32 size) -> i64 and exports memory, Init () -> i64, Alloc, Free, Open, Close,
// Shutdown and Notify (i32, i32) -> i64. A call is an 8-byte little-endian header (subsystem u16, method u16, size u32)
// and a JSON payload; every payload below sits in the data section with 8 free bytes in front for its header. Results
// reach the check through console.log, as text "<label> <number>":
//
//   ueNodeMaker        Open: scene.attachment-root, then scene.node-create "Box", mesh, `resource` (default
//                      assets/Box.glb) under it.
//   ueUnknownMethod    Open: calls (1, 99), which the table does not define.
//   ueBadPayload       Open: calls clock.wall-ms with the payload `not json`.
//   ueDataReader       Open: data.get {"path":"title"}, then logs the returned JSON bytes as the log text's value.
//   ueTimerUser        Open of attachment 1 only: timer.set every 20 ms; Notify logs "tick".
//   ueTimerFlooder     Open: 33 timer.set calls; logs how many returned an id, and the 33rd result.
//   ueLoopsForever, ueInitialPages2048, ueGrowsMemory: the Step 1 memory and CPU modules, with ue.call.
//
// ue:host@0.2.0 modules (network and storage):
//
//   ueFetcher          Open: data.get {"path":"fetch"}; when there is a value, it is the network.fetch payload
//                      ({ url, method, headers, body }) and the module calls network.fetch with it `times` times
//                      (default 1), logging "fetch <result>" each time; without one it logs "data.get -4". Notify
//                      logs "notified".
//   ueStorageUser      Open: storage.get {"key":"note"} (logs the value, or "get <error>"); then, when data "set" has
//                      a value, storage.set with it as the payload ("set <result>") and storage.get again; then, when
//                      data "delete" has a value, storage.delete with it ("delete <result>") and storage.get again.
//                      8 pages of memory, so a 256 KiB value fits.
//   ueFetcher({ every }) With `every` (ms) over 0, Open also sets a repeating timer of that period (logging
//                      "timer.set <result>"), and each timer event calls network.fetch again with the same payload
//                      ("fetch <result>"); every other Notify logs "notified". The payload's length is kept at FETCH_LEN.
//   uePointerListener  Open as ueNodeMaker (one node, Box, under the attachment root); Notify logs "notified". The
//                      pointer events themselves reach the check through the host's record of Notify events.
//   ueBusyTimer({ delayMs, busyMs, busyCalls })  Open (attachment 1) sets a repeating timer of delayMs; Notify spins on
//                      clock.monotonic-ns for busyMs in its first busyCalls calls (every call when busyCalls is 0), then
//                      logs "tick". Needs ue.clock.read and ue.clock.timer.
//   ueTimerNode({ delayMs })  Open as ueNodeMaker, then a repeating timer of delayMs; Notify logs "tick" for any event.

const UE = { BUF: 16384, BUF2: 20480, TMP_END: 24640, FETCH_LEN: 24648, COUNT: 24656, HEAP: 32768, DATA: 1024 };

const sleb = (input) => {
  let value = BigInt(input);
  const out = [];
  for (;;) {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    const done = (value === 0n && !(byte & 0x40)) || (value === -1n && byte & 0x40);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
};
const op = {
  i32: (value) => [0x41, ...sleb(value)],
  i64: (value) => [0x42, ...sleb(value)],
  get: (index) => [0x20, ...uleb(index)],
  set: (index) => [0x21, ...uleb(index)],
  tee: (index) => [0x22, ...uleb(index)],
  call: (index) => [0x10, ...uleb(index)],
  store8: [0x3a, 0x00, 0x00],
  store16: (offset) => [0x3b, 0x00, ...uleb(offset)],
  store32: (offset) => [0x36, 0x00, ...uleb(offset)],
  copy: [0xfc, ...uleb(10), 0x00, 0x00],
};
const locals = (...types) => vector(types.map((type) => [0x01, type]));

/** The static strings of one module, each with 8 free bytes in front of it. */
function strings() {
  let at = UE.DATA;
  const placed = [];
  return {
    add(text) {
      const bytes = [...new TextEncoder().encode(text)];
      at += 8;
      const item = { ptr: at, len: bytes.length };
      placed.push({ ptr: at, bytes });
      at += bytes.length + ((8 - (bytes.length % 8)) % 8);
      return item;
    },
    segments: () => placed.map(({ ptr, bytes }) => [0x00, ...op.i32(ptr), END, ...vector(bytes.map((byte) => [byte]))]),
  };
}

// Function indices: 0 is the import ue.call; the defined functions follow in this order.
const F = { Init: 1, Alloc: 2, Free: 3, Open: 4, Close: 5, Shutdown: 6, Notify: 7, send: 8, append: 9, itoa: 10, logNum: 11, logJson: 12, logText: 13 };
// Types: 0 (i32 i32)->i64, 1 ()->i64, 2 (i32)->i32, 3 (i32 i32)->(), 4 (i64 i32 i32)->(), 5 (i64)->(), 6 ()->(),
// 7 (i32 i32 i32 i32)->i64, 8 (i32 i32 i32)->i32, 9 (i32 i64)->i32, 10 (i32 i32 i64)->()
const UE_TYPES = [
  [0x60, ...vector([[I32], [I32]]), ...vector([[I64]])],
  [0x60, 0x00, ...vector([[I64]])],
  [0x60, ...vector([[I32]]), ...vector([[I32]])],
  [0x60, ...vector([[I32], [I32]]), 0x00],
  [0x60, ...vector([[I64], [I32], [I32]]), 0x00],
  [0x60, ...vector([[I64]]), 0x00],
  [0x60, 0x00, 0x00],
  [0x60, ...vector([[I32], [I32], [I32], [I32]]), ...vector([[I64]])],
  [0x60, ...vector([[I32], [I32], [I32]]), ...vector([[I32]])],
  [0x60, ...vector([[I32], [I64]]), ...vector([[I32]])],
  [0x60, ...vector([[I32], [I32], [I64]]), 0x00],
];

// send(subsystem, method, payload, length) -> i64: writes the header in the 8 bytes before the payload and calls ue.call.
const SEND = [
  0x00,
  ...op.get(2), ...op.i32(8), 0x6b, ...op.get(0), ...op.store16(0),
  ...op.get(2), ...op.i32(8), 0x6b, ...op.get(1), ...op.store16(2),
  ...op.get(2), ...op.i32(8), 0x6b, ...op.get(3), ...op.store32(4),
  ...op.get(2), ...op.i32(8), 0x6b, ...op.get(3), ...op.i32(8), 0x6a, ...op.call(0),
  END,
];
// append(dst, src, length) -> dst + length
const APPEND = [0x00, ...op.get(0), ...op.get(1), ...op.get(2), ...op.copy, ...op.get(0), ...op.get(2), 0x6a, END];
// itoa(dst, value) -> the end of the decimal text written at dst
const ITOA = [
  ...locals(I32),
  ...op.get(1), ...op.i64(0), 0x53, 0x04, 0x40, // if value < 0
  ...op.get(0), ...op.i32(45), ...op.store8, ...op.get(0), ...op.i32(1), 0x6a, ...op.set(0),
  ...op.i64(0), ...op.get(1), 0x7d, ...op.set(1),
  END,
  ...op.i32(UE.TMP_END), ...op.set(2),
  0x03, 0x40,
  ...op.get(2), ...op.i32(1), 0x6b, ...op.tee(2),
  ...op.get(1), ...op.i64(10), 0x82, 0xa7, ...op.i32(48), 0x6a, ...op.store8,
  ...op.get(1), ...op.i64(10), 0x80, ...op.tee(1), ...op.i64(0), 0x52, 0x0d, 0x00,
  END,
  ...op.get(0), ...op.get(2), ...op.i32(UE.TMP_END), ...op.get(2), 0x6b, ...op.copy,
  ...op.get(0), ...op.i32(UE.TMP_END), ...op.get(2), 0x6b, 0x6a,
  END,
];
const logCall = (lengthLocal) => [...op.i32(1), ...op.i32(1), ...op.i32(UE.BUF + 8), ...op.get(lengthLocal), ...op.i32(UE.BUF + 8), 0x6b, ...op.call(F.send), 0x1a];
const appendStatic = (item) => [...op.i32(item.ptr), ...op.i32(item.len), ...op.call(F.append)];

// Bytes 1..n of a call to send(subsystem, method, payload) that leaves the i64 result on the stack.
const send = (subsystem, method, item) => [...op.i32(subsystem), ...op.i32(method), ...op.i32(item.ptr), ...op.i32(item.len), ...op.call(F.send)];
const logNum = (label) => (value) => [...op.i32(label.ptr), ...op.i32(label.len), ...value, ...op.call(F.logNum)];

function ueModule({ pages = 1, init = [0x00, ...op.i64(0), END], open = () => [0x00, END], notify = () => [0x00, ...op.i64(0), END] }) {
  const text = strings();
  const S = {
    textOpen: text.add('{"level":1,"text":"'), textClose: text.add('"}'),
    jsonOpen: text.add('{"level":1,"text":'), jsonClose: text.add("}"),
  };
  const openBody = open(text);
  const notifyBody = notify(text);
  const LOG_NUM = [
    ...locals(I32),
    ...op.i32(UE.BUF + 8), ...appendStatic(S.textOpen),
    ...op.get(0), ...op.get(1), ...op.call(F.append), ...op.tee(3), ...op.i32(32), ...op.store8,
    ...op.get(3), ...op.i32(1), 0x6a, ...op.get(2), ...op.call(F.itoa),
    ...appendStatic(S.textClose), ...op.set(3),
    ...logCall(3),
    END,
  ];
  const wrapLog = (opening, closing) => [
    ...locals(I32),
    ...op.i32(UE.BUF + 8), ...appendStatic(opening),
    ...op.get(0), ...op.get(1), ...op.call(F.append), ...appendStatic(closing), ...op.set(2),
    ...logCall(2),
    END,
  ];
  const funcs = [
    { export: "Init", type: 1, body: init },
    { export: "Alloc", type: 2, body: [0x00, 0x23, 0x00, 0x23, 0x00, ...op.get(0), 0x6a, 0x24, 0x00, END] },
    { export: "Free", type: 3, body: [0x00, ...op.get(0), ...op.get(1), 0x6a, 0x23, 0x00, 0x46, 0x04, 0x40, ...op.get(0), 0x24, 0x00, END, END] },
    { export: "Open", type: 4, body: openBody },
    { export: "Close", type: 5, body: [0x00, END] },
    { export: "Shutdown", type: 6, body: [0x00, END] },
    { export: "Notify", type: 0, body: notifyBody },
    { type: 7, body: SEND },
    { type: 8, body: APPEND },
    { type: 9, body: ITOA },
    { type: 10, body: LOG_NUM },
    { type: 3, body: wrapLog(S.jsonOpen, S.jsonClose) },
    { type: 3, body: wrapLog(S.textOpen, S.textClose) },
  ];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector(UE_TYPES)),
    ...section(2, vector([[...name("ue"), ...name("call"), 0x00, 0x00]])),
    ...section(3, vector(funcs.map((func) => uleb(func.type)))),
    ...section(5, vector([[0x00, ...uleb(pages)]])),
    ...section(6, vector([[I32, 0x01, ...op.i32(UE.HEAP), END]])),
    ...section(7, vector([[...name("memory"), 0x02, 0x00], ...funcs.flatMap((func, i) => (func.export ? [[...name(func.export), 0x00, ...uleb(i + 1)]] : []))])),
    ...section(10, vector(funcs.map((func) => [...uleb(func.body.length), ...func.body]))),
    ...section(11, vector(text.segments())),
  ];
  return new Uint8Array(bytes);
}

const NODE_MAKER_OPEN = (resource) => (text) => {
  const empty = text.add("{}");
  const head = text.add('{"parent":');
  const tail = text.add(`,"name":"Box","kind":"mesh","resource":${JSON.stringify(resource)}}`);
  const root = text.add("attachment-root"), created = text.add("node-create");
  // locals: 3 root i64, 4 end i32
  return [
    ...locals(I64, I32),
    ...send(3, 1, empty), ...op.set(3),
    ...logNum(root)(op.get(3)),
    ...op.i32(UE.BUF2 + 8), ...appendStatic(head), ...op.get(3), ...op.call(F.itoa), ...appendStatic(tail), ...op.set(4),
    ...logNum(created)([...op.i32(3), ...op.i32(2), ...op.i32(UE.BUF2 + 8), ...op.get(4), ...op.i32(UE.BUF2 + 8), 0x6b, ...op.call(F.send)]),
    END,
  ];
};
const ONE_CALL_OPEN = (subsystem, method, payload, label) => (text) => {
  const item = text.add(payload), tag = text.add(label);
  return [0x00, ...logNum(tag)(send(subsystem, method, item)), END];
};
const DATA_READER_OPEN = (text) => {
  const path = text.add('{"path":"title"}'), tag = text.add("data.get");
  return [
    ...locals(I64),
    ...send(2, 2, path), ...op.tee(3), ...op.i64(0), 0x53, 0x04, 0x40,
    ...logNum(tag)(op.get(3)),
    0x05,
    ...op.get(3), ...op.i64(32), 0x88, 0xa7, ...op.get(3), 0xa7, ...op.call(F.logJson),
    END,
    END,
  ];
};
const TIMER_USER_OPEN = (text) => {
  const every = text.add('{"delay-ms":20,"repeat":true}'), tag = text.add("timer.set");
  return [0x00, ...op.get(0), ...op.i64(1), 0x51, 0x04, 0x40, ...logNum(tag)(send(5, 1, every)), END, END];
};
const TICK_NOTIFY = (text) => {
  const tick = text.add("tick");
  return [0x00, ...op.i32(tick.ptr), ...op.i32(tick.len), ...op.call(F.logText), ...op.i64(0), END];
};
const TIMER_FLOODER_OPEN = (text) => {
  const later = text.add('{"delay-ms":60000,"repeat":false}'), setTag = text.add("timers set"), lastTag = text.add("timer 33");
  // locals: 3 count i32, 4 result i64, 5 ok i32
  return [
    ...locals(I32, I64, I32),
    0x03, 0x40,
    ...send(5, 1, later), ...op.set(4),
    ...op.get(5), ...op.get(4), ...op.i64(0), 0x55, 0x6a, ...op.set(5),
    ...op.get(3), ...op.i32(1), 0x6a, ...op.tee(3), ...op.i32(33), 0x48, 0x0d, 0x00,
    END,
    ...logNum(setTag)([...op.get(5), 0xad]),
    ...logNum(lastTag)(op.get(4)),
    END,
  ];
};
const returnsZero = (body) => [...body.slice(0, -1), ...op.i64(0), END];

// Leaves the pointer and the length of a packed (ptr << 32) | len result held in i64 local `local` on the stack.
const unpack = (local) => [...op.get(local), ...op.i64(32), 0x88, 0xa7, ...op.get(local), 0xa7];
const FETCHER_OPEN = (times, every = 0) => (text) => {
  const path = text.add('{"path":"fetch"}'), dataTag = text.add("data.get"), fetchTag = text.add("fetch");
  const timer = every > 0 ? { payload: text.add(`{"delay-ms":${every},"repeat":true}`), tag: text.add("timer.set") } : null;
  // locals: 3 data result i64, 4 count i32, 5 payload length i32
  return [
    ...locals(I64, I32, I32),
    ...send(2, 2, path), ...op.tee(3), ...op.i64(0), 0x53, 0x04, 0x40,
    ...logNum(dataTag)(op.get(3)),
    0x05,
    ...op.get(3), 0xa7, ...op.set(5),
    ...op.i32(UE.FETCH_LEN), ...op.get(5), ...op.store32(0),
    ...op.i32(UE.BUF2 + 8), ...op.get(3), ...op.i64(32), 0x88, 0xa7, ...op.get(5), ...op.call(F.append), 0x1a,
    0x03, 0x40,
    ...logNum(fetchTag)([...op.i32(6), ...op.i32(1), ...op.i32(UE.BUF2 + 8), ...op.get(5), ...op.call(F.send)]),
    ...op.get(4), ...op.i32(1), 0x6a, ...op.tee(4), ...op.i32(times), 0x48, 0x0d, 0x00,
    END,
    ...(timer ? logNum(timer.tag)(send(5, 1, timer.payload)) : []),
    END,
    END,
  ];
};
const NOTIFIED = (text) => {
  const notified = text.add("notified");
  return [0x00, ...op.i32(notified.ptr), ...op.i32(notified.len), ...op.call(F.logText), ...op.i64(0), END];
};
// Notify of the polling fetcher: a timer event ({"type":"timer"...}, "t" at byte 9) fetches again with the payload Open
// kept at BUF2 + 8; any other event logs "notified".
const FETCH_AGAIN_NOTIFY = (text) => {
  const notified = text.add("notified"), fetchTag = text.add("fetch");
  return [
    0x00,
    ...op.get(0), 0x2d, 0x00, 0x09, ...op.i32(116), 0x46, 0x04, 0x40,
    ...logNum(fetchTag)([...op.i32(6), ...op.i32(1), ...op.i32(UE.BUF2 + 8), ...op.i32(UE.FETCH_LEN), 0x28, 0x02, 0x00, ...op.call(F.send)]),
    0x05,
    ...op.i32(notified.ptr), ...op.i32(notified.len), ...op.call(F.logText),
    END,
    ...op.i64(0),
    END,
  ];
};
const STORAGE_USER_OPEN = (text) => {
  const key = text.add('{"key":"note"}'), setPath = text.add('{"path":"set"}'), deletePath = text.add('{"path":"delete"}');
  const getTag = text.add("get"), setTag = text.add("set"), deleteTag = text.add("delete");
  // local 3: the last result (i64)
  const getAndLog = [
    ...send(7, 1, key), ...op.tee(3), ...op.i64(0), 0x53, 0x04, 0x40,
    ...logNum(getTag)(op.get(3)),
    0x05,
    ...unpack(3), ...op.call(F.logText),
    END,
  ];
  // When data `path` has a value, call (7, method) with it as the payload (the header goes in the 8 bytes before it).
  const fromData = (path, method, tag) => [
    ...send(2, 2, path), ...op.tee(3), ...op.i64(0), 0x59, 0x04, 0x40,
    ...logNum(tag)([...op.i32(7), ...op.i32(method), ...unpack(3), ...op.call(F.send)]),
    ...getAndLog,
    END,
  ];
  return [...locals(I64), ...getAndLog, ...fromData(setPath, 2, setTag), ...fromData(deletePath, 3, deleteTag), END];
};

// Notify of the busy timer: counts its calls in memory at UE.COUNT; the first `busyCalls` calls (every call when 0) spin
// on clock.monotonic-ns until `busyMs` have passed; every call logs "tick".
const BUSY_NOTIFY = (busyMs, busyCalls) => (text) => {
  const empty = text.add("{}"), tick = text.add("tick");
  const spin = [
    ...send(4, 2, empty), ...op.set(2),
    0x03, 0x40,
    ...send(4, 2, empty), ...op.get(2), 0x7d, ...op.i64(Math.round(busyMs * 1e6)), 0x53, 0x0d, 0x00,
    END,
  ];
  // locals: 2 start i64, 3 count i32
  return [
    ...locals(I64, I32),
    ...op.i32(UE.COUNT), ...op.i32(UE.COUNT), 0x28, 0x02, 0x00, ...op.i32(1), 0x6a, ...op.tee(3), ...op.store32(0),
    ...(busyCalls > 0 ? [...op.get(3), ...op.i32(busyCalls), 0x4d, 0x04, 0x40, ...spin, END] : spin),
    ...op.i32(tick.ptr), ...op.i32(tick.len), ...op.call(F.logText),
    ...op.i64(0),
    END,
  ];
};
// Open of the busy timer: attachment 1 sets one repeating timer of `delayMs`.
const BUSY_TIMER_OPEN = (delayMs) => (text) => {
  const every = text.add(`{"delay-ms":${delayMs},"repeat":true}`), tag = text.add("timer.set");
  return [0x00, ...op.get(0), ...op.i64(1), 0x51, 0x04, 0x40, ...logNum(tag)(send(5, 1, every)), END, END];
};
// Open of the timer node: one node, Box, under the attachment root (as ueNodeMaker), then one repeating timer.
const TIMER_NODE_OPEN = (delayMs) => (text) => {
  const node = NODE_MAKER_OPEN("assets/Box.glb")(text);
  const every = text.add(`{"delay-ms":${delayMs},"repeat":true}`), tag = text.add("timer.set");
  return [...node.slice(0, -1), ...logNum(tag)(send(5, 1, every)), END];
};

export const UE_TEST_MODULES = Object.freeze({
  ueNodeMaker: ({ resource = "assets/Box.glb" } = {}) => ueModule({ open: NODE_MAKER_OPEN(resource) }),
  ueUnknownMethod: () => ueModule({ open: ONE_CALL_OPEN(1, 99, "{}", "unknown-method") }),
  ueBadPayload: () => ueModule({ open: ONE_CALL_OPEN(4, 1, "not json", "bad-payload") }),
  ueDataReader: () => ueModule({ open: DATA_READER_OPEN }),
  ueTimerUser: () => ueModule({ open: TIMER_USER_OPEN, notify: TICK_NOTIFY }),
  ueTimerFlooder: () => ueModule({ open: TIMER_FLOODER_OPEN }),
  ueLoopsForever: () => ueModule({ init: [...LOOP_FOR_EVER.slice(0, -1), 0x00, END] }),
  ueInitialPages2048: () => ueModule({ pages: 2048 }),
  ueGrowsMemory: () => ueModule({ init: returnsZero(GROW_UNTIL_REFUSED) }),
  ueFetcher: ({ times = 1, every = 0 } = {}) => ueModule({ open: FETCHER_OPEN(times, every), notify: every > 0 ? FETCH_AGAIN_NOTIFY : NOTIFIED }),
  uePointerListener: ({ resource = "assets/Box.glb" } = {}) => ueModule({ open: NODE_MAKER_OPEN(resource), notify: NOTIFIED }),
  ueStorageUser: () => ueModule({ pages: 8, open: STORAGE_USER_OPEN }),
  ueBusyTimer: ({ delayMs = 20, busyMs = 0, busyCalls = 0 } = {}) => ueModule({ open: BUSY_TIMER_OPEN(delayMs), notify: BUSY_NOTIFY(busyMs, busyCalls) }),
  ueTimerNode: ({ delayMs = 100 } = {}) => ueModule({ open: TIMER_NODE_OPEN(delayMs), notify: TICK_NOTIFY }),
});
