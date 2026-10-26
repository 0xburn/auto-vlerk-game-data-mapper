import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SlippiGame } from '@slippi/slippi-js/node';
import { UUID } from './parry.mjs';
import { characterKey, buildContext } from './match.mjs';

const CHARACTERS = ['Captain Falcon', 'Donkey Kong', 'Fox', 'Mr. Game & Watch', 'Kirby', 'Bowser',
  'Link', 'Luigi', 'Mario', 'Marth', 'Mewtwo', 'Ness', 'Peach', 'Pikachu', 'Ice Climbers',
  'Jigglypuff', 'Samus', 'Yoshi', 'Zelda', 'Sheik', 'Falco', 'Young Link', 'Dr. Mario', 'Roy', 'Pichu', 'Ganondorf'];
const STAGES = new Map([[2, 11], [3, 15], [8, 5], [28, 25], [31, 19], [32, 20]]);
export const digest = buffer => createHash('sha256').update(buffer).digest('hex');

export function readGame(file) {
  const buffer = fs.readFileSync(file);
  const sha256 = digest(buffer);
  const game = new SlippiGame(buffer);
  const settings = game.getSettings();
  const metadata = game.getMetadata();
  const end = game.getGameEnd();
  const frame = game.getLatestFrame();
  const base = { file, sha256, startMs: Date.parse(metadata?.startAt) };
  const reject = error => ({ ...base, error });
  if (settings?.isTeams || settings?.players?.length !== 2 || settings.players.some(p => p.type !== 0)) return reject('Not human singles');
  if (![1, 2, 3].includes(end?.gameEndMethod)) return reject('Unfinished game or no contest');
  const durationMs = ((frame?.frame + 123) / 60) * 1000;
  if (!Number.isFinite(base.startMs) || !Number.isFinite(durationMs) || durationMs < 30000) return reject('Missing timestamp or incomplete game');
  const stage = STAGES.get(settings.stageId);
  if (!stage) return reject('Unsupported stage');
  const players = settings.players.map(p => ({ ...p,
    characterName: CHARACTERS[p.characterId], character: characterKey(CHARACTERS[p.characterId]),
  }));
  if (players.some(p => !p.character || !Number.isInteger(p.port)) || players[0].port === players[1].port) return reject('Invalid player data');
  const first = (end.placements ?? []).filter(p => p.position === 0 && players.some(pl => pl.playerIndex === p.playerIndex));
  let winnerPort = first.length === 1 ? players.find(p => p.playerIndex === first[0].playerIndex).port : null;
  // Older files have no placements. Only an actual stock-out decides those games.
  if (winnerPort == null && end.gameEndMethod === 2) {
    const stocks = players.map(p => frame?.players?.[p.playerIndex]?.post?.stocksRemaining);
    if (stocks[0] === 0 && stocks[1] > 0) winnerPort = players[1].port;
    if (stocks[1] === 0 && stocks[0] > 0) winnerPort = players[0].port;
  }
  if (winnerPort == null) return reject('Winner not established');
  return { ...base, stage, players, winnerPort, durationMs };
}

export function scanDirectory(root) {
  const streams = [], skipped = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.some(e => e.name.toLowerCase() === 'context.json')) {
      skipped.push({ file: dir, error: 'Already has context.json' });
      return;
    }
    const records = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.slp$/i.test(entry.name)) {
        try { records.push(readGame(file)); }
        catch { records.push({ file, error: 'Cannot parse game data' }); }
      }
    }
    // A file with unknown chronology could fall anywhere: do not join across it.
    if (records.some(g => !Number.isFinite(g.startMs))) {
      skipped.push(...records.map(g => ({ file: g.file, error: g.error ?? 'Folder contains a game with unknown chronology' })));
    } else if (records.length) {
      records.sort((a, b) => a.startMs - b.startMs || a.file.localeCompare(b.file));
      streams.push(records);
    }
  }
  walk(root);
  // Identical copies cannot create artificial uniqueness in separate folders.
  const counts = new Map();
  for (const game of streams.flat()) counts.set(game.sha256, (counts.get(game.sha256) ?? 0) + 1);
  for (const game of streams.flat()) {
    if (counts.get(game.sha256) > 1) game.error = 'Duplicate game data';
    if (game.error) skipped.push({ file: game.file, error: game.error });
  }
  return { streams, skipped };
}

export function writeOutput(out, event, results, report, { write = false } = {}) {
  // Reserve a new output directory; never merge with an earlier run.
  fs.mkdirSync(out, { recursive: false });
  const reportPath = path.join(out, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  if (!write) return;
  for (const match of results.accepted) {
    if (!(event.provider === 'parry' ? UUID.test(match.set.id) : /^\d+$/.test(match.set.id))) {
      throw new Error('Invalid set ID.');
    }
    const temp = fs.mkdtempSync(path.join(out, '.pending-'));
    try {
      for (const [index, game] of match.games.entries()) {
        const buffer = fs.readFileSync(game.file);
        if (digest(buffer) !== game.sha256) throw new Error('Game data changed while mapping; run again.');
        fs.writeFileSync(path.join(temp, `${String(index + 1).padStart(2, '0')}.slp`), buffer, { flag: 'wx' });
      }
      fs.writeFileSync(path.join(temp, 'context.json'), JSON.stringify(buildContext(event, match), null, 2), { flag: 'wx' });
      fs.renameSync(temp, path.join(out, `set-${match.set.id}`));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}
