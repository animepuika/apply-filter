#!/usr/bin/env node
// Tests whether a company slug is live on a given job board before you add it
// to sources.json. A wrong slug is the most common reason the shortlist comes
// back empty, so check here first.
//
// Usage:
//   node scripts/probe.mjs greenhouse lokalise
//   node scripts/probe.mjs all printful          test every board for one slug

const BOARDS = {
  greenhouse: s => 'https://boards-api.greenhouse.io/v1/boards/' + s + '/jobs',
  lever: s => 'https://api.lever.co/v0/postings/' + s + '?mode=json',
  ashby: s => 'https://api.ashbyhq.com/posting-api/job-board/' + s,
  recruitee: s => 'https://' + s + '.recruitee.com/api/offers/',
  workable: s => 'https://apply.workable.com/api/v1/widget/accounts/' + s + '?details=true'
};

const count = d => {
  if (Array.isArray(d)) return d.length;
  for (const k of ['jobs', 'offers', 'results', 'data']) {
    if (Array.isArray(d[k])) return d[k].length;
  }
  return null;
};

const firstTitle = d => {
  const arr = Array.isArray(d) ? d : (d.jobs || d.offers || d.results || []);
  const j = arr[0];
  return j ? (j.title || j.text || j.name || '') : '';
};

async function probe(board, slug) {
  const label = (board + '/' + slug).padEnd(28);
  try {
    const res = await fetch(BOARDS[board](slug), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return console.log('  ' + label + ' HTTP ' + res.status);
    const body = await res.json();
    const n = count(body);
    if (n === null) return console.log('  ' + label + ' 200, unexpected shape');
    if (n === 0) return console.log('  ' + label + ' 200, but 0 postings');
    console.log('  ' + label + ' OK  ' + n + ' postings, e.g. "' +
      firstTitle(body).slice(0, 44) + '"');
  } catch (e) {
    console.log('  ' + label + ' ' + (e.name === 'TimeoutError' ? 'timed out' : e.message));
  }
}

const [board, slug] = process.argv.slice(2);
if (!board || !slug) {
  console.log('usage: node scripts/probe.mjs <board|all> <slug>');
  console.log('boards: ' + Object.keys(BOARDS).join(', '));
  process.exit(1);
}

const boards = board === 'all' ? Object.keys(BOARDS) : [board];
if (!boards.every(b => BOARDS[b])) {
  console.log('unknown board: ' + board);
  process.exit(1);
}
await Promise.all(boards.map(b => probe(b, slug)));
