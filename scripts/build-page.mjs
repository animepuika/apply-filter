#!/usr/bin/env node
// Builds the browsable page from feed/shortlist.json, merging in what
// applications.md and the jobs/ folders already know.
//
// Without this, the page and the tracker were two separate worlds: a role could
// have a finished cover letter and a real score sitting on disk while the page
// still showed only its keyword prescore, with no sign that any work had been
// done on it.
//
// Usage: node scripts/build-page.mjs [path/to/template.html]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.argv[2] || join(ROOT, 'page-template.html');
const OUT = join(ROOT, 'feed', 'page.html');

const data = JSON.parse(readFileSync(join(ROOT, 'feed', 'shortlist.json'), 'utf8'));

// ---------------------------------------------------- read the jobs/ folders

// A folder counts as worked on once it has a score.md. What else it holds tells
// you how far the application got.
function readFolders() {
  const dir = join(ROOT, 'jobs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name);
    const jd = join(folder, 'jd.md');
    if (!existsSync(jd)) continue;

    const jdText = readFileSync(jd, 'utf8');
    const urlMatch = jdText.match(/^Source URL:\s*(\S+)/m);
    const url = urlMatch ? urlMatch[1] : null;
    if (!url || !/^https?:/.test(url)) continue;

    // Everything add-job.mjs writes into a jd.md head, so a folder captured
    // from a single pasted link (LinkedIn, mostly) can become a full row even
    // when it never appeared in a bulk company-board fetch.
    const head = (label) => {
      const m = jdText.match(new RegExp('^' + label + ':\\s*(.+)$', 'm'));
      return m ? m[1].trim() : '';
    };
    const company = head('Company');
    const title = head('Role');
    const location = head('Location');
    const modeLine = head('On-site / hybrid / remote').toLowerCase();

    const files = readdirSync(folder);
    const scorePath = join(folder, 'score.md');
    let realScore = null;
    let verdict = null;
    if (existsSync(scorePath)) {
      const t = readFileSync(scorePath, 'utf8');
      const m = t.match(/^#\s*Score:\s*(\d+)\s*\/\s*100/m);
      if (m) realScore = Number(m[1]);
      const v = t.match(/\*\*Verdict:\s*([^.*]+)/);
      if (v) verdict = v[1].trim();
    }

    // A best-effort mode guess for the pill and the filter chip. The real
    // answer lives in score.md's prose; this only has to avoid showing
    // "unknown" for the common case where the JD head line was filled in.
    let mode = 'unknown';
    if (/remote/.test(modeLine)) mode = 'remote';
    else if (/hybrid/.test(modeLine)) mode = 'hybrid';
    else if (/on-?site/.test(modeLine)) mode = 'onsite';
    else if (/\bremote\b/i.test(location)) mode = 'remote';

    out.push({
      folder: name,
      url,
      company,
      title,
      location,
      mode,
      realScore,
      verdict,
      hasScore: files.includes('score.md'),
      hasResume: files.includes('resume-tailored.md'),
      hasLetter: files.includes('cover-letter.md'),
      hasAnswers: files.includes('answers.md')
    });
  }
  return out;
}

// ---------------------------------------------------- read applications.md

// Status column of the tracker, keyed by folder. The tracker is the durable
// record; the page only mirrors it.
function readTracker() {
  const p = join(ROOT, 'applications.md');
  if (!existsSync(p)) return new Map();
  const byFolder = new Map();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    // | Date | Company | Role | Location | Score | Status | Folder | Notes |
    if (cells.length < 9) continue;
    const [, date, company, role, , , status, folder] = cells;
    if (!folder || folder === 'Folder' || /^-+$/.test(date)) continue;
    byFolder.set(folder.replace(/^jobs\//, ''), { date, company, role, status });
  }
  return byFolder;
}

// ---------------------------------------------------- merge

const folders = readFolders();
const tracker = readTracker();
const byUrl = new Map(folders.map(f => [f.url, f]));

// A real 100 point score always outranks the keyword prescore once it exists,
// on both a bulk-fetched role and one captured from a single pasted link.
function attach(job, f) {
  job.folder = f.folder;
  job.realScore = f.realScore;
  job.verdict = f.verdict;
  if (f.realScore !== null) job.score = f.realScore;
  if (f.mode && f.mode !== 'unknown') job.mode = f.mode;
  job.status = (tracker.get(f.folder) || {}).status || 'scored';
  job.draft = { resume: f.hasResume, letter: f.hasLetter, answers: f.hasAnswers };
}

let merged = 0;
for (const job of data.jobs) {
  const f = byUrl.get(job.url);
  if (!f) continue;
  merged++;
  attach(job, f);
}

// A folder never in the bulk fetch (every job captured from a single pasted
// link, which today is most of them) used to fall into a side "orphaned"
// list with four stripped fields the page template cannot render at all.
// It now becomes a full row instead, built straight from what add-job.mjs
// wrote into the jd.md head plus whatever score.md decided.
const withoutFolder = f => !data.jobs.some(j => j.url === f.url);
for (const f of folders.filter(withoutFolder)) {
  const job = {
    score: f.realScore ?? 0,
    mode: f.mode,
    floor: null,
    company: f.company || '(unknown company)',
    title: f.title || f.folder,
    location: f.location || '',
    url: f.url,
    why: f.verdict || 'scored outside the bulk fetch, see score.md',
    posted: '',
    via: null,
    direct: true
  };
  attach(job, f);
  data.jobs.push(job);
}

data.worked = { total: folders.length, onShortlist: merged };

// ---------------------------------------------------- write

const tpl = readFileSync(TEMPLATE, 'utf8');
if (!tpl.includes('/*__JOBS__*/')) throw new Error('template has no /*__JOBS__*/ placeholder');
writeFileSync(OUT, tpl.replace('/*__JOBS__*/', JSON.stringify(data, null, 2)));

console.log('roles on page          : ' + data.jobs.length);
console.log('folders with a jd      : ' + folders.length);
console.log('matched onto bulk fetch: ' + merged);
console.log('added from a solo link : ' + (folders.length - merged));
console.log();
for (const j of data.jobs.filter(j => j.status).sort((a, b) => (b.realScore ?? -1) - (a.realScore ?? -1))) {
  console.log('  ' + j.status.padEnd(9) + (j.realScore === null ? '  -' : String(j.realScore).padStart(3)) +
    '  ' + j.company + ' / ' + j.title.slice(0, 44));
}
console.log('wrote ' + OUT);
