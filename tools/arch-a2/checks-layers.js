'use strict';

/*
 * A2, the layers themselves (in Node).
 *
 *   L1  the reading: the game layer reads the weather value through the mirror rule of O6 and O6b. Its
 *       node holds the weather layer's data-point URL under mirror.temperature, its world's server writes
 *       every weather value into the game node, and the weather world receives no write and has no user.
 *   L3  the description: each layer's description validates against iteration 3's JSON-LD context
 *       (every key and every @type expands through the context; mirror maps defined terms to data-point
 *       URLs), and both layers name the same place.
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const nonReads = (log) => log.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
const SERIES = [3, 1.5, -0.5, -2, -1, 0.5, 2, -1.5];

async function layerChecks(ports) {
  const copiesOnce = { layerEdits: [['    mirror: { temperature: weatherPoint },\n', '']] };
  const mirrorReadsOnce = { serverEdits: { mirrors: [['                onChange : (point) => apply(point),', '                onChange : () => {},']] } };
  await run('L1', 'the game layer holds the weather layer\'s data-point URL under mirror.temperature; while the stand-in source changes the weather value, the game world\'s server writes every value into the game node (the O6/O6b mirror rule), and the weather world receives no write and has no user', async (impl) => {
    const p = await lab.place(ports, impl);
    const { createObserver } = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', '..', 'web', 'wow-observe.mjs')).href);
    const seen = [];
    const observer = createObserver({ onChange: (point) => seen.push(point.value) });
    try {
      await observer.watch(p.gamePoint);
      const game = (await p.G.node(1, p.gameNode)).json.properties;
      const writes = lab.requestLog(p.W);
      const log = await p.startWeather({ values: SERIES, interval_ms: 300 }).done;
      await lab.sleep(800);
      await observer.idle();
      writes.stop();
      const failures = [];
      if (!game.mirror || game.mirror.temperature !== p.weatherPoint) failures.push('the game node does not hold the weather data point under mirror.temperature: ' + JSON.stringify(game.mirror));
      const missing = log.filter((e) => !seen.includes(e.temperature));
      if (missing.length) failures.push(`the game layer never showed ${missing.map((e) => e.temperature).join(', ')}`);
      const final = (await p.G.node(1, p.gameNode)).json.properties.temperature;
      if (final !== SERIES[SERIES.length - 1]) failures.push(`the game layer ends at ${final}`);
      if (nonReads(writes.log).length) failures.push(`the weather world received ${nonReads(writes.log).length} writes`);
      const users = [(await lab.worldDoc(p.W)).users.active_user_count, (await lab.worldDoc(p.G)).users.active_user_count];
      if (users.some((n) => n !== 0)) failures.push('users: ' + users.join(', '));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `the game layer read all ${log.length} weather values through mirror.temperature (last ${final}); the weather world received only reads (${writes.log.length} requests); no user in either world` };
    } finally {
      observer.close();
      await p.close();
    }
  }, {}, [
    { name: 'a game layer that copies the weather value once instead of mirroring it', impl: copiesOnce },
    { name: 'a game world whose mirror reads once and never follows (O6\'s fault)', impl: mirrorReadsOnce },
  ]);

  const bareTerm = { layerEdits: [['    "osl:unit": "Cel",\n', '    unit: "Cel",\n']] };
  const permissive = { layerEdits: [['    if (!iri) errors.push(`term "${key}" is not defined by the context`);\n    else expanded[key] = iri;', '    expanded[key] = iri;']] };
  await run('L3', 'each layer\'s description, read from its node, validates against iteration 3\'s JSON-LD context as its world serves it (every key and @type expands through the context; mirror maps defined terms to data-point URLs); both name the same place; and the validator refuses a term the context does not define', async (impl) => {
    const p = await lab.place(ports, impl);
    try {
      const failures = [];
      const descriptions = {};
      for (const [layer, world, id] of [['weather', p.W, p.weatherNode], ['game', p.G, p.gameNode]]) {
        const props = (await world.node(1, id)).json.properties;
        const contexts = new Map();
        for (const url of [].concat(props['@context'] || [])) {
          if (typeof url !== 'string') continue;
          const r = await fetch(url, { headers: { Accept: 'application/ld+json' } });
          contexts.set(url, r.ok ? await r.json() : null);
        }
        const verdict = p.layers.validateDescription(props, contexts);
        descriptions[layer] = { props, verdict, contexts };
        if (!verdict.ok) failures.push(`${layer}: ${verdict.errors.join('; ')}`);
      }
      if (descriptions.weather.props['osl:place'] !== descriptions.game.props['osl:place']) failures.push('the layers name different places');
      // The rule must refuse what it claims to refuse: a term outside the context, an undefined prefix.
      const { contexts } = descriptions.weather;
      const bad = [
        Object.assign({}, descriptions.weather.props, { humidity: 40 }),
        Object.assign({}, descriptions.weather.props, { 'xyz:humidity': 40 }),
      ];
      for (const d of bad) if (p.layers.validateDescription(d, contexts).ok) failures.push('the validator accepts ' + Object.keys(d).filter((k) => k === 'humidity' || k === 'xyz:humidity').join());
      const types = Object.values(descriptions).map((d) => d.verdict.expanded['@type']).join(', ');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `both descriptions validate (types ${types}; place ${descriptions.weather.props['osl:place']}); the validator refuses an undefined term and an undefined prefix` };
    } finally {
      await p.close();
    }
  }, {}, [
    { name: 'a weather layer described with a term the context does not define', impl: bareTerm },
    { name: 'a validator that lets undefined terms through', impl: permissive },
  ]);
}

module.exports = { layerChecks, SERIES };
