import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventIdentifier, adaptMatch, loadEvent, createClient } from '../src/parry.mjs';
import { normalizeSet, matchGames, buildContext } from '../src/match.mjs';
import { writeOutput, digest } from '../src/files.mjs';
const uuid = n => `019b5300-0000-7000-8000-${String(n).padStart(12, '0')}`;
const event = { provider: 'parry', id: uuid(1), name: 'Singles', tournament: { id: uuid(2), name: 'Tournament' } };
function fixture() {
  return { hierarchy: { paths: [{ type: 'PATH_TYPE_EVENT', id: event.id }] },
    round: { label: 'Winners Final' },
    seeds: [0, 1].map(i => ({ id: uuid(10 + i), eventEntrant: { id: uuid(20 + i),
      entrant: { users: [{ id: uuid(30 + i), gamerTag: i ? 'Marth player' : 'Fox player' }] } } })),
    match: { id: uuid(3), state: 'MATCH_STATE_COMPLETED',
      slots: [0, 1].map(i => ({ slot: i, seedId: uuid(10 + i), state: 'SLOT_STATE_NUMERIC', score: i ? 0 : 2 })),
      matchGames: [0, 1].map(index => ({ index, state: 'MATCH_GAME_STATE_COMPLETED',
        stages: [{ slug: index ? 'final-destination' : 'battlefield' }],
        slots: [0, 1].map(i => ({ slot: i, score: i ? 0 : 1, state: 'SLOT_STATE_NUMERIC',
          participants: [{ userId: uuid(30 + i), characters: [{ slug: i ? 'marth' : 'fox' }] }] })),
      })),
    },
  };
}
const adapt = c => adaptMatch(c, new Map(c.seeds.map(s => [s.id, s])));
function local() {
  return [0, 1].map(i => ({ file: `${i}.slp`, sha256: `hash${i}`, startMs: 1000000 + i * 200000,
    durationMs: 180000, stage: i ? 20 : 19, winnerPort: 2,
    players: [{ port: 1, character: 'marth', characterName: 'Marth' }, { port: 2, character: 'fox', characterName: 'Fox' }],
  }));
}
test('Parry URLs and UUIDs resolve without accepting unrelated hosts', () => {
  assert.deepEqual(eventIdentifier(uuid(1)), { id: uuid(1) });
  assert.deepEqual(eventIdentifier('https://parry.gg/demo/singles/bracket?x=1'),
    { eventSlugPath: { tournamentSlug: 'demo', eventSlug: 'singles' } });
  for (const value of ['https://parry.gg/demo', 'https://evil.test/demo/singles', '123']) assert.throws(() => eventIdentifier(value));
});
test('Parry exact mapping preserves reversed ports and importer-compatible UUID context', () => {
  const result = matchGames([local()], [adapt(fixture())]);
  assert.equal(result.accepted.length, 1);
  const context = buildContext(event, result.accepted[0]);
  assert.equal(context.startgg.set.id, null);
  assert.equal(context.startgg.set.internalId, uuid(3));
  assert.equal(context.startgg.event.id, uuid(1));
  assert.deepEqual(context.scores.map(g => g.slots.map(s => s.score)), [[0, 0], [1, 0]]);
  assert.deepEqual(context.finalScore.slots.map(s => s.ports), [[2], [1]]);
});
test('protobuf omitted zeros and numeric enums are supported; placement is not used as winner evidence', () => {
  const c = fixture(); c.match.state = 4;
  delete c.match.slots[0].slot; delete c.match.slots[1].score;
  c.match.slots.forEach(s => { s.state = 2; });
  delete c.match.matchGames[0].index;
  for (const g of c.match.matchGames) {
    g.state = 3; delete g.slots[0].slot; delete g.slots[1].score;
    g.slots[0].placement = -1; g.slots[1].placement = 1;
    g.slots.forEach(s => { s.state = 2; });
  }
  assert.equal(normalizeSet(adapt(c)).complete, true);
});
test('missing or malformed game evidence cannot establish a match', () => {
  const mutations = [
    c => { c.match.matchGames[0].stages = []; },
    c => { c.match.matchGames[0].slots[0].participants[0].characters = []; },
    c => { c.match.matchGames[0].slots[0].participants[0].userId = uuid(99); },
    c => { c.match.matchGames[0].slots[0].participants[0].characters.push({ slug: 'falco' }); },
    c => { c.match.matchGames[0].slots[0].score = 0; },
    c => { c.match.matchGames[0].state = 'MATCH_GAME_STATE_PENDING'; },
    c => { c.match.matchGames[1].index = 0; },
    c => { c.match.matchGames[0].slots[1].slot = 0; },
    c => { c.match.slots[0].state = 'SLOT_STATE_PENDING'; },
    c => { c.seeds[0].eventEntrant.entrant.users.push({ id: uuid(88), gamerTag: 'Third' }); },
  ];
  for (const mutate of mutations) {
    const c = fixture(); mutate(c);
    assert.equal(matchGames([local()], [adapt(c)]).accepted.length, 0);
  }
});
test('incomplete competing Parry sets still block unique-looking mappings; DQ and BYE do not', () => {
  for (const state of [undefined, 'SLOT_STATE_DQ', 'SLOT_STATE_BYE']) {
    const other = fixture(); other.match.id = uuid(4); other.match.matchGames = [];
    if (state) other.match.slots[1].state = state;
    assert.equal(matchGames([local()], [adapt(fixture()), adapt(other)]).accepted.length, state ? 1 : 0);
  }
});
function requestFor(contexts = [fixture()], modify = () => {}) {
  return async (service, method, body) => {
    if (method === 'GetEvent') {
      assert.deepEqual(body, { identifier: { id: event.id } });
      const e = { ...event, tournamentId: event.tournament.id, game: { slug: 'super-smash-bros-melee' }, entrantSize: 1 };
      modify(e); return { event: e };
    }
    if (method === 'GetTournament') return { tournament: event.tournament };
    assert.equal(method, 'GetMatches');
    assert.deepEqual(body, { filter: { event: { id: event.id } } });
    return { matches: contexts };
  };
}
test('loader fetches the full event and rejects wrong events, duplicate matches, malformed responses and teams', async () => {
  const loaded = await loadEvent(event.id, requestFor());
  assert.equal(loaded.provider, 'parry'); assert.equal(loaded.sets.length, 1);
  await assert.rejects(loadEvent(event.id, requestFor([fixture(), fixture()])), /duplicate/);
  const wrong = fixture(); wrong.hierarchy.paths[0].id = uuid(99);
  await assert.rejects(loadEvent(event.id, requestFor([wrong])), /outside/);
  await assert.rejects(loadEvent(event.id, requestFor(null)), /Incomplete/);
  await assert.rejects(loadEvent(event.id, requestFor([], e => { e.entrantSize = 2; })), /singles/);
  const malformed = fixture(); malformed.match.slots.pop();
  await assert.rejects(loadEvent(event.id, requestFor([malformed])), /slots/);
});
test('Parry API uses only its own optional credential and retries throttling', async () => {
  let calls = 0;
  const request = createClient('parry-key', { sleep: async () => {}, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://grpcweb.parry.gg/parrygg.services.EventService/GetEvent');
    assert.equal(init.headers['X-API-KEY'], 'parry-key'); assert.equal(init.headers.Authorization, undefined);
    return ++calls === 1 ? new Response('', { status: 429 }) : Response.json({ event: {} });
  } });
  await request('EventService', 'GetEvent', {}); assert.equal(calls, 2);
  const publicRead = createClient(undefined, { sleep: async () => {}, fetchImpl: async (_, init) => {
    assert.equal(init.headers['X-API-KEY'], undefined); return Response.json({ code: 5 });
  } });
  await assert.rejects(publicRead('EventService', 'GetEvent', {}), /Incomplete/);
});
test('UUID output folders contain copied games and compatible context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parry-mapper-test-'));
  try {
    const games = local();
    for (const [i, g] of games.entries()) {
      const bytes = Buffer.from(`game-${i}`); g.file = path.join(root, `${i}.slp`);
      fs.writeFileSync(g.file, bytes); g.sha256 = digest(bytes);
    }
    const result = matchGames([games], [adapt(fixture())]);
    const out = path.join(root, 'out'); writeOutput(out, event, result, {}, { write: true });
    const folder = path.join(out, `set-${uuid(3)}`);
    const context = JSON.parse(fs.readFileSync(path.join(folder, 'context.json')));
    assert.equal(context.startgg.set.internalId, uuid(3));
    assert.equal(fs.readFileSync(path.join(folder, '01.slp'), 'utf8'), 'game-0');
    result.accepted[0].set.id = '../escape';
    assert.throws(() => writeOutput(path.join(root, 'bad'), event, result, {}, { write: true }), /Invalid set ID/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('official metadata aliases cover Doctor Mario, Mr. Game & Watch and Pokémon Stadium', () => {
  const c = fixture();
  for (const g of c.match.matchGames) {
    g.stages = [{ slug: 'pokmon-stadium' }];
    g.slots[0].participants[0].characters = [{ slug: 'doctor-mario' }];
    g.slots[1].participants[0].characters = [{ slug: 'mr-game-and-watch' }];
  }
  const set = normalizeSet(adapt(c));
  assert.equal(set.complete, true);
  assert.equal(set.games[0].stage, 15);
  assert.equal(set.games[0].characters[uuid(10)], 'drmario');
  assert.equal(set.games[0].characters[uuid(11)], 'mrgamewatch');
});
test('best-of-five Parry sets use the shared sequence matcher', () => {
  const c = fixture(); c.match.slots[0].score = 3;
  c.match.matchGames.push({ ...structuredClone(c.match.matchGames[1]), index: 2 });
  const games = local(); games.push({ ...structuredClone(games[1]), file: 'third.slp', sha256: 'third', startMs: 1400000 });
  const result = matchGames([games], [adapt(c)]);
  assert.equal(result.accepted.length, 1);
  assert.equal(buildContext(event, result.accepted[0]).bestOf, 5);
});
