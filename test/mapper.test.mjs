import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSet, matchGames, buildContext } from '../src/match.mjs';
import { createClient, loadEvent, eventVariables } from '../src/startgg.mjs';
import { digest, writeOutput, scanDirectory } from '../src/files.mjs';

function official(id = '100') {
  return { id, state: 3, winnerId: 10, fullRoundText: 'Winners Final',
    slots: [10, 20].map((id, i) => ({ entrant: { id, name: `Player ${id}`,
      participants: [{ gamerTag: `Player ${id}`, prefix: '' }] }, standing: { stats: { score: { value: i ? 0 : 2 } } } })),
    games: [1, 2].map(orderNum => ({ orderNum, winnerId: 10, stage: { id: orderNum === 1 ? 19 : 20 },
      selections: [10, 20].map((id, i) => ({ entrant: { id }, character: { name: i ? 'Marth' : 'Fox' } })),
    })),
  };
}
function local() {
  return [1, 2].map((n, i) => ({ file: `${n}.slp`, sha256: `hash${n}`, startMs: 1000000 + i * 200000,
    durationMs: 180000, stage: n === 1 ? 19 : 20, winnerPort: 2,
    players: [{ port: 1, character: 'marth', characterName: 'Marth' }, { port: 2, character: 'fox', characterName: 'Fox' }],
  }));
}
const event = { id: 1, name: 'Singles', tournament: { id: 2, name: 'Tournament' } };
test('exact unique sequence maps reversed ports and produces pre-game scores', () => {
  const result = matchGames([local()], [official()]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].flip, true);
  const context = buildContext(event, result.accepted[0]);
  assert.deepEqual(context.scores.map(s => s.slots.map(p => p.score)), [[0, 0], [1, 0]]);
  assert.deepEqual(context.finalScore.slots.map(s => s.score), [2, 0]);
  assert.deepEqual(context.scores[0].slots.map(s => s.ports), [[2], [1]]);
  assert.equal(context.startgg.set.id, '100');
});
test('two identical official sequences are ambiguous', () => {
  assert.equal(matchGames([local()], [official(), official('101')]).accepted.length, 0);
});
test('missing character or stage records never establish a match', () => {
  for (const field of ['selections', 'stage']) {
    const set = official(); set.games[0][field] = null;
    assert.equal(matchGames([local()], [set]).accepted.length, 0);
  }
});
test('incomplete competing set blocks a seemingly unique complete match', () => {
  const incomplete = official('101'); incomplete.games = [];
  assert.equal(matchGames([local()], [official(), incomplete]).accepted.length, 0);
});
test('known different score rules out an incomplete competitor', () => {
  const other = official('101'); other.games = []; other.slots[1].standing.stats.score.value = 1;
  assert.equal(matchGames([local()], [official(), other]).accepted.length, 1);
});
test('DQ and bye sets do not block completed games', () => {
  const dq = official('101'); dq.slots[1].standing.stats.score.value = -1;
  const bye = official('102'); bye.slots.pop();
  assert.equal(matchGames([local()], [official(), dq, bye]).accepted.length, 1);
});
test('wrong stage, character, winner, switched ports and overlapping clocks are rejected', () => {
  const mutations = [
    g => { g[1].stage = 15; }, g => { g[1].players[0].character = 'falco'; },
    g => { g[1].winnerPort = 1; }, g => { g[1].players[0].port = 3; },
    g => { g[1].startMs = g[0].startMs; }, g => { g[1].error = 'Unfinished'; },
  ];
  for (const mutate of mutations) {
    const games = local(); mutate(games);
    assert.equal(matchGames([games], [official()]).accepted.length, 0);
  }
});
test('same official set matching separate local sequences rejects both', () => {
  const second = local().map(g => ({ ...g, sha256: `other-${g.sha256}` }));
  assert.equal(matchGames([local(), second], [official()]).accepted.length, 0);
});
test('overlapping candidates are rejected even when each has a unique official match', () => {
  const a = official(), b = official('101');
  b.games[0].stage.id = 20; b.games[1].stage.id = 15;
  const games = local(); games.push({ ...games[1], file: '3.slp', sha256: 'hash3', stage: 15, startMs: 1400000 });
  const result = matchGames([games], [a, b]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.conflictingCandidates, 2);
});
test('invalid official ordering, score, or set winner fails closed', () => {
  const mutations = [s => { s.games[1].orderNum = 1; }, s => { s.winnerId = 20; },
    s => { s.slots[0].standing.stats.score.value = 3; }, s => { s.games[1].winnerId = 20; }];
  for (const mutate of mutations) { const s = official(); mutate(s); assert.equal(normalizeSet(s).complete, false); }
});
test('incomplete longer sequence blocks an exact shorter mapping inside it', () => {
  const longer = official('101'); longer.games = []; longer.slots[0].standing.stats.score.value = 3;
  const games = local(); games.push({ ...games[1], file: '3.slp', sha256: 'hash3', stage: 15, startMs: 1400000 });
  assert.equal(matchGames([games], [official(), longer]).accepted.length, 0);
});
test('event URL and ID parsing', () => {
  assert.deepEqual(eventVariables('https://www.start.gg/tournament/demo/event/singles/brackets?x=1'), { slug: 'tournament/demo/event/singles' });
  assert.deepEqual(eventVariables('123'), { id: '123' });
  assert.throws(() => eventVariables('https://example.com/event/1'));
});
test('API pagination must be complete and deduplicated', async () => {
  const pages = [official(), official('101')];
  const request = async (_, variables) => variables.page
    ? { event: { sets: { pageInfo: { total: 2, totalPages: 2 }, nodes: [pages[variables.page - 1]] } } }
    : { event: { ...event, videogame: { id: 1 } } };
  assert.equal((await loadEvent('1', request)).sets.length, 2);
  pages[1] = pages[0];
  await assert.rejects(loadEvent('1', request), /duplicate/);
});
test('API retries throttling and rejects partial GraphQL results', async () => {
  let calls = 0;
  const client = createClient('test-token', { sleep: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429 }) : Response.json({ data: { event } });
  } });
  assert.deepEqual(await client('query', {}), { event }); assert.equal(calls, 2);
  const partial = createClient('test-token', { sleep: async () => {},
    fetchImpl: async () => Response.json({ data: { event }, errors: [{ message: 'partial' }] }) });
  await assert.rejects(partial('query', {}), /incomplete/);
});
test('writer preserves input, reserves new output, verifies bytes, and numbers game files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-vlerk-game-data-mapper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = local().map((g, i) => {
    const buffer = Buffer.from(`fixture ${i}`); const file = path.join(root, `${i}.slp`);
    fs.writeFileSync(file, buffer); return { ...g, file, sha256: digest(buffer) };
  });
  const results = matchGames([games], [official()]);
  const out = path.join(root, 'output');
  writeOutput(out, event, results, {}, { write: true });
  assert.deepEqual(fs.readdirSync(path.join(out, 'set-100')), ['01.slp', '02.slp', 'context.json']);
  assert.equal(fs.readFileSync(games[0].file, 'utf8'), 'fixture 0');
  assert.throws(() => writeOutput(out, event, results, {}, { write: true }));
  fs.writeFileSync(games[0].file, 'changed');
  const changed = path.join(root, 'changed');
  assert.throws(() => writeOutput(changed, event, results, {}, { write: true }), /changed/);
  assert.deepEqual(fs.readdirSync(changed), ['report.json']);
});
test('preview writes only report; existing context folders are skipped', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-vlerk-game-data-mapper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'preview');
  writeOutput(out, event, matchGames([local()], [official()]), {});
  assert.deepEqual(fs.readdirSync(out), ['report.json']);
  fs.writeFileSync(path.join(root, 'context.json'), '{}');
  assert.equal(scanDirectory(root).streams.length, 0);
});
