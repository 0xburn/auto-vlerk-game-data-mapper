# Auto Vlerk Game Data Mapper

A standalone command-line tool that maps Melee `.slp` game data to completed
Start.gg or Parry.gg sets and creates a `context.json` for each accepted set. Runs locally
with Node.js. Start.gg requires an API token; Parry.gg public reads do not.

## What the data needs

**Tournament character records:** both players' character picks must be reported
for every game in the set. A player's main, a set score, or character picks for
only some games are not enough. Each game also needs its stage and winner.
Missing records on another set can leave the mapping ambiguous.

**Game-file timing:** files need valid recorded start times, a consistent console
clock, and a separate folder for each recording setup. Games are ordered by those
timestamps. Overlapping times, unknown timestamps, or more than 15 minutes between
the end of one game and the start of the next prevent a sequence from matching.
Keep controller ports stable throughout each set.

The tournament's reported set times and the recording console's clock can differ.
This version uses file timestamps for order and continuity; it does **not** match
against the tournament's set times or estimate clock offsets. It cannot repair a bad
console clock. The character, stage, and winner sequence establishes the match.

## Install

Requires Node.js 22 or newer.

```sh
git clone https://github.com/0xburn/auto-vlerk-game-data-mapper.git
cd auto-vlerk-game-data-mapper
npm ci
node cli.mjs --help
```

For Start.gg, create a personal API token in [Start.gg developer settings](https://www.start.gg/admin/profile/developer).
Set it in your shell (PowerShell: `$env:STARTGG_TOKEN = 'your-token'`):

```sh
export STARTGG_TOKEN='your-token'
```

## Map an event

Use a Start.gg event URL or numeric ID, or a Parry.gg event URL or UUID. Extract any input
archives first. Put each recording setup's files in its own folder; the tool
searches subfolders recursively and orders games by their recorded timestamps.
Supply tournament game data from **one event only**, after results are finalized.

Preview:

```sh
node cli.mjs --event 'https://www.start.gg/tournament/example/event/melee-singles' \
  --dir '/path/to/game-data' --out '/path/to/preview'
```

Create the matched set folders:

```sh
node cli.mjs --event 'https://www.start.gg/tournament/example/event/melee-singles' \
  --dir '/path/to/game-data' --out '/path/to/mapped' --write
```

For Parry.gg, use the same command with its event URL:

```sh
node cli.mjs --event 'https://parry.gg/example/melee-singles' \
  --dir '/path/to/game-data' --out '/path/to/mapped' --write
```

The URL must identify an event, not just its tournament. Event UUIDs are also
accepted. `PARRY_API_KEY` is optional; `STARTGG_TOKEN` is not needed for Parry.gg.
Parry.gg records must include completed games with numeric slot scores, one
character per player, and a supported stage. Set scores alone cannot establish
a mapping. Missing game records remain unknown evidence and can block other matches.

The output folder must be new, outside the input tree, with an existing parent.
Each accepted set contains numbered `.slp` copies and `context.json` with tournament
IDs, names, ports, score progression, and final score. Original files are unchanged.
For Parry.gg, contexts follow the existing game-data manager format:
`startgg.set.id` is null and `startgg.set.internalId` contains the Parry match
UUID. The event and tournament IDs are Parry UUIDs. This is compatible with
Lucky Stats' Parry game-data importer. Output folders use `set-<UUID>`.

`report.json` lists accepted mappings, unassigned files, and skipped files.
Folders already containing `context.json` are skipped, including their children.

## Acceptance rules

Only best-of-three and best-of-five human singles sets are supported. A mapping
requires:

- A complete ordered tournament game record: both characters, stage, and winner for
  every game, agreeing with the final set score and winner.
- A consecutive local sequence with exactly those characters, stages, winners,
  and score, using stable controller ports and valid timestamps.
- Exactly one matching completed, non-DQ set and one player-to-port orientation.
  Incomplete records on competing sets count as unknown evidence and can block a match.
- No competing local sequence for that set and no overlapping plausible matches,
  including longer or shorter sequences that fit incomplete official records.

There is no fuzzy-name matching, player history, clock-offset estimation, confidence
threshold, or override. Unfinished games, quits, games under 30 seconds, uncertain
winners, duplicate files, unsupported stages, and changed ports prevent matching.
Skipped games remain barriers; the tool does not splice games across them. A folder
containing an unreadable file or a missing timestamp is left unassigned because its
game order cannot be established. Gaps longer than 15 minutes also prevent matching.

“Exact” means unique under the available records, **not proof of player identity**.
A friendly can reproduce a tournament sequence; incorrect tournament records or files
from another event can mislead any fingerprint mapper. Supply tournament-only data
from the selected event after results are finalized. Unreported sets, byes, and DQs
are outside the matching population. Events without detailed game reporting may
produce no mappings. Review the report before using the generated contexts.

The Start.gg client fetches all pages; Parry.gg returns its event matches in one
response. Both clients pace requests, retry throttling/server errors, and stop
on incomplete responses. If Parry.gg rejects an oversized event response, the
run stops without writing output; binary transport is not supported. Credentials
are sent only to their respective providers and are not included in reports. API shapes follow the official
[event sets](https://developer.start.gg/docs/examples/queries/sets-in-event/) and
[game data](https://developer.start.gg/docs/examples/queries/set-game-data/) queries.
Parry.gg shapes follow the official [API schemas](https://github.com/parry-gg/protos)
and [game metadata](https://github.com/parry-gg/game-metadata).

## Distribute and test

```sh
npm test
npm pack
```

Share the resulting `auto-vlerk-game-data-mapper-0.2.0.tgz`. Recipients can install it:

```sh
npm install -g ./auto-vlerk-game-data-mapper-0.2.0.tgz
auto-vlerk-game-data-mapper --help
```

The npm package includes only this tool's source and instructions. Users supply
their own game data and a token when using Start.gg. To distribute source instead, share this
folder including `package-lock.json` and `test/`, excluding `node_modules/` and
generated archives. No compilation step is required.
