#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClient, loadEvent } from './src/startgg.mjs';
import { scanDirectory, writeOutput } from './src/files.mjs';
import { matchGames } from './src/match.mjs';

try {
  const { values } = parseArgs({ options: {
    event: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' },
    write: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(`Auto Vlerk Game Data Mapper

Usage: node cli.mjs --event <Start.gg event URL or ID> --dir <game-data-folder> --out <new-folder> [--write]

Set STARTGG_TOKEN to your Start.gg API token.
Requires complete per-game Start.gg character, stage, and winner records.
Game files need reliable timestamps and one recording setup per folder.
Timing establishes game order; Start.gg clock offsets are not estimated.
Default: write a mapping report. Add --write to copy matched games with context.json.
Use a separate new output folder for each run. Requires Node.js 22 or newer.`);
  } else {
    if (!values.event || !values.dir || !values.out) throw new Error('Required: --event, --dir, --out. See --help.');
    const root = fs.realpathSync(values.dir);
    if (!fs.statSync(root).isDirectory()) throw new Error('--dir must be a directory.');
    const requested = path.resolve(values.out);
    const out = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
    const relative = path.relative(root, out);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Choose an output folder outside the input folder.');
    }
    if (fs.existsSync(out)) throw new Error('Output folder already exists. Choose a new folder.');
    console.log('Reading Start.gg event data…');
    const event = await loadEvent(values.event, createClient(process.env.STARTGG_TOKEN), (loaded, total) => {
      if (loaded % 100 === 0 || loaded === total) console.log(`Read ${loaded} of ${total} sets.`);
    });
    if (event.sets.some(s => s.slots?.some(slot => slot.entrant?.participants?.length > 1))) {
      throw new Error('Choose a singles event.');
    }
    console.log(`Scanning game data against ${event.sets.length} sets…`);
    const { streams, skipped } = scanDirectory(root);
    const results = matchGames(streams, event.sets);
    const used = new Set(results.accepted.flatMap(m => m.games.map(g => g.file)));
    const report = {
      version: 1, generatedAt: new Date().toISOString(), mode: values.write ? 'write' : 'preview',
      event: { id: event.id, name: event.name, tournament: event.tournament },
      summary: { matchedSets: results.accepted.length, completeSets: results.completeSets,
        eligibleSets: results.totalSets, ambiguousWindows: results.ambiguousWindows,
        conflictingCandidates: results.conflictingCandidates },
      matches: results.accepted.map(m => ({ setId: m.set.id, round: m.set.round,
        entrants: m.set.entrants, files: m.games.map(g => g.file),
        evidence: 'Exact characters, stages, winners and score; unique among completed non-DQ sets' })),
      skipped,
      unassigned: streams.flat().filter(g => !used.has(g.file)).map(g => ({ file: g.file, reason: g.error ?? 'No unique complete match' })),
    };
    writeOutput(out, event, results, report, { write: values.write });
    console.log(`${results.accepted.length} sets ${values.write ? 'written' : 'matched'}. Report: ${path.join(out, 'report.json')}`);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
