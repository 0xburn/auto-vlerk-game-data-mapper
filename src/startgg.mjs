const ENDPOINT = 'https://api.start.gg/gql/alpha';
const META = 'id name videogame { id } tournament { id name }';
export const SETS_QUERY = `query MapperSets($id: ID!, $page: Int!) {
  event(id: $id) {
    sets(page: $page, perPage: 5, sortType: STANDARD) {
      pageInfo { total totalPages }
      nodes {
        id state winnerId fullRoundText
        slots {
          entrant { id name participants { gamerTag prefix } }
          standing { stats { score { value } } }
        }
        games {
          orderNum winnerId stage { id }
          selections { entrant { id } character { name } }
        }
      }
    }
  }
}`;

export function eventVariables(value) {
  if (/^[1-9]\d*$/.test(value)) return { id: value };
  const slug = value.replace(/^https?:\/\/(www\.)?start\.gg\//, '').split(/[?#]/)[0];
  const match = slug.match(/^(tournament\/[^/]+\/event\/[^/]+)(?:\/.*)?$/);
  if (!match) throw new Error('Use a Start.gg event URL, event slug, or numeric event ID.');
  return { slug: match[1] };
}

export function createClient(token, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!token) throw new Error('Set STARTGG_TOKEN to your Start.gg API token.');
  return async (query, variables) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      // Below the API request limit, including retries. No credentials in logs or reports.
      await sleep(850);
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60000),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new Error(`Start.gg HTTP ${response.status}; retry later.`);
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Math.min(30000, Math.max(1000 * 2 ** attempt, retryAfter * 1000 || 0)));
        continue;
      }
      if (!response.ok) throw new Error(`Start.gg HTTP ${response.status}. Check your token and event access.`);
      const body = await response.json();
      if (body.errors?.length || !body.data) throw new Error('Start.gg returned an incomplete query result. No mappings were written.');
      return body.data;
    }
  };
}

export async function loadEvent(value, request, onProgress = () => {}) {
  const variables = eventVariables(value);
  const field = variables.id ? 'id' : 'slug';
  const { event } = await request(`query MapperEvent($${field}: ${field === 'id' ? 'ID!' : 'String!'}) {
    event(${field}: $${field}) { ${META} }
  }`, variables);
  if (!event) throw new Error('Start.gg event not found or inaccessible.');
  if (Number(event.videogame?.id) !== 1) throw new Error('Choose a Melee singles event.');
  const sets = [];
  let total, totalPages;
  for (let page = 1; ; page++) {
    const data = await request(SETS_QUERY, { id: event.id, page });
    const result = data.event?.sets;
    if (!result || !Array.isArray(result.nodes)) throw new Error('Incomplete Start.gg set listing.');
    const info = result.pageInfo;
    if (!Number.isInteger(info?.total) || !Number.isInteger(info?.totalPages)) throw new Error('Invalid Start.gg pagination.');
    if (page === 1) ({ total, totalPages } = info);
    if (total !== info.total || totalPages !== info.totalPages) throw new Error('Event changed during download; run again when reporting is finished.');
    sets.push(...result.nodes);
    onProgress(sets.length, total);
    if (page >= totalPages) break;
    if (!result.nodes.length) throw new Error('Incomplete Start.gg set listing.');
  }
  if (sets.length !== total || new Set(sets.map(s => String(s?.id))).size !== total || sets.some(s => !s?.id)) {
    throw new Error('Incomplete or duplicate Start.gg set listing.');
  }
  return { ...event, sets };
}
