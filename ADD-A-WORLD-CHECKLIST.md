# Add a world: checklist

This is the checklist for adding a world to Open Spatial Lab. You edit one configuration file. You change no code.

The launch script, the world servers, the web server and the browser all read the same file. So a world you list there is launched, served, routed, shown on the launcher page and offered as a portal destination.

All commands run in the repository root.

## 1. Pick a free port

- Choose a port that no other program uses.
- It must not be the frontend port or the port of another listed world.
- Test it. This command must print nothing:

```bash
lsof -nP -iTCP:32465 -sTCP:LISTEN
```

## 2. Add one entry to the worlds file

- The worlds file is `worlds.json` in the repository root.
- If you set `OSL_WORLDS`, the worlds file is the file it names.
- Add one entry to the `worlds` list. Give it these fields:
  - `key`: a short name in lowercase letters, digits or `-`. Links use it, for example `/w/e/`.
  - `name`: the name people read.
  - `port`: the port from step 1.
  - `address`: the world's address. Use the same port, for example `http://127.0.0.1:32465/`.
  - `anchor`: where the world sits on Earth, as `lat`, `lon` and `h` (meters).
  - `room` (optional): the colour of the world's room, for example `#c86bff`.
  - `preview_radius_m` (optional): how much of the world a portal into it shows, in meters.
- Example:

```json
{ "key": "e", "name": "Location E", "port": 32465, "address": "http://127.0.0.1:32465/",
  "anchor": { "lat": 47.7009, "lon": -122.3, "h": 11.5 }, "room": "#c86bff", "preview_radius_m": 8 }
```

- A new world is a plain room. It has no portals yet. You connect it in step 6.

## 3. Restart the lab

```bash
npm stop
npm start
```

- Use the same `OSL_WORLDS` and `OSL_RUN_DIR` settings for both commands, if you use them.
- The ready message lists every world with its address and its player link. Find the new world there.
- If the start stops with an error that names a port, that port is in use. Go back to step 1.

## 4. Run the check

```bash
npm run check:worlds
```

- The check reads the worlds file and tests every listed world by name.
- The last line must be `PASS: every listed world is launched and answers.`
- The check exits with code 1 when anything is wrong. It never skips a world.
- What it can say, and what to do:
  - `port ... is missing from the launch`: the running lab did not start this world. Restart the lab (step 3).
  - `does not answer at ...`: nothing answers at the world's address. Check the port and the address, then restart.
  - `answers as ..., not as ...`: another world is on that port. Fix the port.
  - `the frontend ... does not reach it`: the web server did not load the new list. Restart the lab.
  - `configuration: ...`: the entry is wrong (a key, port or address). Fix the entry.
  - `portal ... leads to ..., which does not answer`: a portal leads to a world that is not running. The portal would wake but not deliver the visitor. Start that world, or change the portal's destination.

## 5. Open the new world

- Open its player link from the ready message, for example:
  `http://127.0.0.1:8143/index.html?role=source&intro=bypass&wow=http%3A%2F%2F127.0.0.1%3A32465%2Fwow%2Fspatial%2F1`
- You see its room.
- The launcher page also shows it, under Destinations, as "Start in" and its name.

## 6. Connect it with a portal

- Open another world's player link and add `&place=1` to it. Placement mode opens.
- The Destination list shows the new world. Pick it.
- Set the active radius, or leave it empty for a portal that is always awake.
- Click the floor. The portal is placed and saved.
- Run the check again (step 4). It also checks every portal's destination.

## To remove a world

- Delete its entry from the worlds file.
- Restart the lab (step 3) and run the check (step 4).
