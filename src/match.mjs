export const characterKey = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const id = value => value == null ? null : String(value);

export function normalizeSet(raw) {
  const entrants = (raw.slots ?? []).map(slot => ({
    id: id(slot.entrant?.id), name: slot.entrant?.participants?.[0]?.gamerTag ?? slot.entrant?.name,
    prefix: slot.entrant?.participants?.[0]?.prefix ?? '',
    singles: slot.entrant?.participants?.length === 1,
    score: slot.standing?.stats?.score?.value,
  }));
  const games = (raw.games ?? []).map(game => ({
    order: game.orderNum, winner: id(game.winnerId), stage: game.stage?.id,
    characters: Object.fromEntries(entrants.map(e => {
      const picks = (game.selections ?? []).filter(s => id(s.entrant?.id) === e.id);
      return [e.id, picks.length === 1 ? characterKey(picks[0].character?.name) : ''];
    })),
  })).sort((a, b) => a.order - b.order);
  const scoresValid = entrants.length === 2 && entrants.every(e => e.id && Number.isInteger(e.score) && e.score >= 0);
  const target = scoresValid ? Math.max(...entrants.map(e => e.score)) : null;
  const count = scoresValid ? entrants[0].score + entrants[1].score : null;
  const complete = raw.state === 3 && scoresValid && entrants.every(e => e.singles && e.name)
    && new Set(entrants.map(e => e.id)).size === 2
    && [2, 3].includes(target) && entrants[0].score !== entrants[1].score
    && games.length === count && games.every((g, i) => g.order === i + 1 && g.stage != null
      && entrants.some(e => e.id === g.winner) && entrants.every(e => g.characters[e.id]))
    && entrants.every(e => games.filter(g => g.winner === e.id).length === e.score)
    && id(raw.winnerId) === entrants.find(e => e.score === target)?.id
    && games.at(-1)?.winner === id(raw.winnerId)
    && games.slice(0, -1).filter(g => g.winner === id(raw.winnerId)).length < target;
  return { id: id(raw.id), round: raw.fullRoundText ?? '', entrants, games, count, complete };
}

// Missing official evidence is a wildcard for competing sets, never positive evidence.
function compatible(set, window, flip) {
  if (set.count != null && set.count !== window.length) return false;
  if (set.entrants.length !== 2) return true;
  const ports = window[0].players.map(p => p.port);
  const portFor = i => ports[flip ? 1 - i : i];
  for (let i = 0; i < 2; i++) {
    const entrant = set.entrants[i];
    if (Number.isInteger(entrant.score) && entrant.score >= 0
      && window.filter(g => g.winnerPort === portFor(i)).length !== entrant.score) return false;
  }
  for (let i = 0; i < window.length; i++) {
    const local = window[i];
    const official = set.games.find(g => g.order === i + 1);
    if (!official) continue;
    if (official.stage != null && Number(official.stage) !== local.stage) return false;
    for (let side = 0; side < 2; side++) {
      const entrant = set.entrants[side];
      const player = local.players.find(p => p.port === portFor(side));
      if (official.characters[entrant.id] && official.characters[entrant.id] !== player.character) return false;
      if (official.winner === entrant.id && local.winnerPort !== player.port) return false;
    }
  }
  return true;
}

function validWindow(window) {
  if (window.some(g => g.error || g.players?.length !== 2 || !Number.isFinite(g.startMs))) return false;
  const ports = window[0].players.map(p => p.port).sort().join(',');
  return window.every((g, i) => g.players.map(p => p.port).sort().join(',') === ports
    && g.players.some(p => p.port === g.winnerPort)
    && (!i || (g.startMs > window[i - 1].startMs
      && g.startMs >= window[i - 1].startMs + window[i - 1].durationMs - 2000
      && g.startMs - window[i - 1].startMs - window[i - 1].durationMs <= 15 * 60000)));
}

export function matchGames(streams, rawSets) {
  const sets = rawSets.filter(s => s.state === 3
    && s.slots?.length === 2 && s.slots.every(slot => slot.entrant?.id)
    && !s.slots.some(slot => slot.standing?.stats?.score?.value < 0)).map(normalizeSet);
  const candidates = [];
  const plausibleWindows = [];
  let ambiguousWindows = 0;
  for (const stream of streams) {
    for (let start = 0; start < stream.length; start++) {
      for (let length = 2; length <= 5 && start + length <= stream.length; length++) {
        const window = stream.slice(start, start + length);
        if (!validWindow(window)) continue;
        const possible = [];
        for (const set of sets) {
          for (const flip of [false, true]) {
            if (compatible(set, window, flip)) possible.push({ set, flip, games: window });
          }
        }
        if (possible.length) plausibleWindows.push({ games: window, possible });
        if (possible.length === 1 && possible[0].set.complete) candidates.push(possible[0]);
        else if (possible.some(p => p.set.complete)) ambiguousWindows++;
      }
    }
  }
  // Resolve nothing greedily: repeated sets and overlapping windows all remain unassigned.
  const accepted = candidates.filter(candidate => !plausibleWindows.some(other =>
    other.possible[0] !== candidate && (other.possible.some(p => p.set.id === candidate.set.id)
      || other.games.some(g => candidate.games.some(c => c.sha256 === g.sha256)))));
  return { accepted, ambiguousWindows, conflictingCandidates: candidates.length - accepted.length,
    completeSets: sets.filter(s => s.complete).length, totalSets: sets.length };
}

export function buildContext(event, match) {
  const { set, games, flip } = match;
  const ports = games[0].players.map(p => p.port);
  const counts = [0, 0];
  const slots = () => set.entrants.map((e, i) => ({
    displayNames: [e.name], prefixes: [e.prefix], pronouns: [''],
    ports: [ports[flip ? 1 - i : i]], score: counts[i],
  }));
  const scores = games.map(game => {
    const entry = { slots: slots() };
    counts[game.winnerPort === ports[flip ? 1 : 0] ? 0 : 1]++;
    return entry;
  });
  return {
    bestOf: Math.max(...counts) * 2 - 1, startMs: games[0].startMs,
    scores, finalScore: { slots: slots() },
    players: Object.fromEntries(set.entrants.map((e, i) => [`entrant${i + 1}`, [{ name: e.name,
      characters: [...new Set(games.map(g => g.players.find(p => p.port === ports[flip ? 1 - i : i]).characterName))],
    }]])),
    startgg: { tournament: { id: event.tournament.id, name: event.tournament.name },
      event: { id: event.id, name: event.name }, set: { id: event.provider === 'parry' ? null : set.id,
        ...(event.provider === 'parry' ? { internalId: set.id } : {}), fullRoundText: set.round } },
    mapping: { generatedBy: 'auto-vlerk-game-data-mapper', version: 1, evidence: 'unique-complete-game-sequence',
      files: games.map((g, i) => ({ name: `${String(i + 1).padStart(2, '0')}.slp`, sha256: g.sha256 })) },
  };
}
