import { characterKey } from './match.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MELEE = '01920676-416e-7838-b6aa-8d4453256f05';
const STAGES = new Map([['fountainofdreams', 11], ['pokemonstadium', 15], ['pokmonstadium', 15], ['yoshisstory', 5],
  ['dreamland', 25], ['dreamland64', 25], ['battlefield', 19], ['finaldestination', 20]]);
const CHARACTERS = new Set(['Captain Falcon', 'Donkey Kong', 'Fox', 'Mr. Game & Watch', 'Kirby',
  'Bowser', 'Link', 'Luigi', 'Mario', 'Marth', 'Mewtwo', 'Ness', 'Peach', 'Pikachu', 'Ice Climbers',
  'Jigglypuff', 'Samus', 'Yoshi', 'Zelda', 'Sheik', 'Falco', 'Young Link', 'Dr. Mario', 'Roy', 'Pichu',
  'Ganondorf'].map(characterKey));
const CHARACTER_ALIASES = new Map([['doctormario', 'drmario'], ['mrgameandwatch', 'mrgamewatch']]);
const metadataCharacter = value => CHARACTER_ALIASES.get(characterKey(value)) ?? characterKey(value);
const numeric = state => state === 'SLOT_STATE_NUMERIC' || state === 2;
const excluded = state => ['SLOT_STATE_DQ', 'SLOT_STATE_BYE', 3, 4].includes(state);

export function eventIdentifier(value) {
  if (UUID.test(value)) return { id: value.toLowerCase() };
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  const parts = url?.pathname.split('/').filter(Boolean);
  if (!url || !['https:', 'http:'].includes(url.protocol) || !/^(www\.)?parry\.gg$/i.test(url.hostname)
    || parts.length < 2 || !parts.slice(0, 2).every(p => /^[a-zA-Z0-9_-]+$/.test(p))) {
    throw new Error('Use a Parry.gg event URL (https://parry.gg/tournament/event) or event UUID.');
  }
  return { eventSlugPath: { tournamentSlug: parts[0], eventSlug: parts[1] } };
}

export function createClient(apiKey, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async (service, method, body) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(850);
      let response;
      try {
        response = await fetchImpl(`https://grpcweb.parry.gg/parrygg.services.${service}/${method}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
        });
      } catch {
        if (attempt === 4) throw new Error('Parry.gg could not be reached. Try again.');
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new Error(`Parry.gg HTTP ${response.status}; no mappings were written. Try again or use a smaller event.`);
        await sleep(Math.min(30000, Math.max(1000 * 2 ** attempt, Number(response.headers.get('retry-after')) * 1000 || 0)));
        continue;
      }
      if (!response.ok) throw new Error(`Parry.gg HTTP ${response.status}. Check event access and PARRY_API_KEY if set.`);
      let data;
      try { data = await response.json(); } catch { throw new Error('Invalid Parry.gg response. No mappings were written.'); }
      if (!data || data.code || data.error) throw new Error('Incomplete Parry.gg response. No mappings were written.');
      return data;
    }
  };
}

// Parry protobuf JSON omits scalar zeros (slot, index, score). Scores are only
// evidence when the slot explicitly has normal numeric completion.
function score(slot) { return numeric(slot.state) ? (slot.score ?? 0) : null; }
function winningSlot(slots) {
  if (slots.length !== 2) return null;
  const scores = slots.map(score);
  if (!scores.every(s => Number.isFinite(s) && s >= 0) || scores[0] === scores[1]) return null;
  return slots[scores[0] > scores[1] ? 0 : 1];
}

export function adaptMatch(context, seeds) {
  const match = context.match;
  if (!match || !UUID.test(match.id)) throw new Error('Invalid Parry.gg match ID.');
  const parentSlots = match.slots ?? [];
  if (parentSlots.some(s => excluded(s.state))) return { id: match.id, state: 0 };
  if (![4, 'MATCH_STATE_COMPLETED'].includes(match.state)) return { id: match.id, state: 0 };
  if (parentSlots.length !== 2 || new Set(parentSlots.map(s => s.slot ?? 0)).size !== 2
    || parentSlots.some(s => !s.seedId || ![0, 1].includes(s.slot ?? 0))) {
    throw new Error('Incomplete Parry.gg match slots. No mappings were written.');
  }
  const slots = parentSlots.map(s => {
    const entrant = seeds.get(s.seedId)?.eventEntrant;
    const users = entrant?.entrant?.users ?? [];
    return { entrant: { id: s.seedId, name: entrant?.name,
      participants: users.map(u => ({ gamerTag: u.gamerTag, prefix: u.prefix ?? '' })) },
    standing: { stats: { score: { value: score(s) } } } };
  });
  const winner = winningSlot(parentSlots);
  const games = (match.matchGames ?? []).map(g => {
    const gameSlots = g.slots ?? [];
    // Malformed/unreported games remain unknown competitors, never fabricated evidence.
    if (![3, 'MATCH_GAME_STATE_COMPLETED'].includes(g.state) || gameSlots.length !== 2
      || new Set(gameSlots.map(s => s.slot ?? 0)).size !== 2
      || gameSlots.some(s => ![0, 1].includes(s.slot ?? 0) || !numeric(s.state))) return { orderNum: (g.index ?? 0) + 1 };
    const winnerSlot = winningSlot(gameSlots);
    return { orderNum: (g.index ?? 0) + 1,
      winnerId: winnerSlot ? parentSlots.find(s => (s.slot ?? 0) === (winnerSlot.slot ?? 0))?.seedId : null,
      stage: { id: g.stages?.length === 1 ? STAGES.get(characterKey(g.stages[0].slug || g.stages[0].name)) : null },
      selections: gameSlots.map(s => {
        const parent = parentSlots.find(p => (p.slot ?? 0) === (s.slot ?? 0));
        const user = seeds.get(parent.seedId)?.eventEntrant?.entrant?.users?.[0];
        const participant = s.participants?.length === 1 ? s.participants[0] : null;
        const character = participant?.characters?.length === 1 ? participant.characters[0] : null;
        const name = metadataCharacter(character?.slug || character?.name);
        return { entrant: { id: parent.seedId }, character: {
          name: participant?.userId === user?.id && user?.id && CHARACTERS.has(name) ? name : null,
        } };
      }),
    };
  });
  // Duplicate or invalid ordering cannot safely rule out other local sequences.
  const validOrder = games.every(g => Number.isInteger(g.orderNum) && g.orderNum > 0)
    && new Set(games.map(g => g.orderNum)).size === games.length;
  return { id: match.id, state: 3, fullRoundText: context.round?.label ?? '',
    winnerId: winner?.seedId, slots, games: validOrder ? games : [] };
}

export async function loadEvent(value, request, onProgress = () => {}) {
  const { event } = await request('EventService', 'GetEvent', { identifier: eventIdentifier(value) });
  if (!UUID.test(event?.id) || !UUID.test(event?.tournamentId)) throw new Error('Parry.gg event not found or inaccessible.');
  if (!(event.game?.id === MELEE || event.game?.slug === 'super-smash-bros-melee') || event.entrantSize !== 1) {
    throw new Error('Choose a Melee singles event.');
  }
  const { tournament } = await request('TournamentService', 'GetTournament', { id: event.tournamentId });
  if (tournament?.id !== event.tournamentId) throw new Error('Incomplete Parry.gg tournament response.');
  const { matches } = await request('MatchService', 'GetMatches', { filter: { event: { id: event.id } } });
  if (!Array.isArray(matches) || new Set(matches.map(c => c?.match?.id)).size !== matches.length) {
    throw new Error('Incomplete or duplicate Parry.gg match listing.');
  }
  const seeds = new Map();
  for (const context of matches) {
    const eventPath = context.hierarchy?.paths?.find(p => p.type === 'PATH_TYPE_EVENT' || p.type === 1);
    if (eventPath?.id !== event.id) throw new Error('Parry.gg returned a match outside the selected event.');
    for (const seed of context.seeds ?? []) {
      if (!seed.eventEntrant) continue;
      const prior = seeds.get(seed.id);
      if (prior && JSON.stringify(prior.eventEntrant) !== JSON.stringify(seed.eventEntrant)) {
        throw new Error('Parry.gg entrant data changed during download; try again after reporting is finished.');
      }
      seeds.set(seed.id, seed);
    }
  }
  const sets = matches.map(context => adaptMatch(context, seeds));
  onProgress(sets.length, sets.length);
  return { provider: 'parry', id: event.id, name: event.name,
    tournament: { id: tournament.id, name: tournament.name }, sets };
}
