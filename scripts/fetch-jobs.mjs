#!/usr/bin/env node
// Pulls open postings from the public job boards listed in sources.json,
// filters them, drops anything already seen, prescores the survivors and
// writes shortlist.md.
//
// The prescore is deliberately dumb keyword matching. Its only job is to get
// several hundred postings down to a readable handful. The real 100 point
// score in runbook.md is done by the agent, on the shortlist, afterwards.
//
// Usage: node scripts/fetch-jobs.mjs [--all] [--keep-seen]
//   --all         ignore the title and location filters, dump everything
//   --keep-seen   do not skip postings already in feed/seen.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const SHOW_ALL = args.has('--all');
const KEEP_SEEN = args.has('--keep-seen');

const cfg = JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8'));

// Who is looking, and from where. Copy profile.example.json to profile.json.
const profilePath = join(ROOT, 'profile.json');
if (!existsSync(profilePath)) {
  console.error('No profile.json found. Copy profile.example.json to profile.json and edit it.');
  process.exit(1);
}
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

// The resume is read only to check which skills named in a job title you
// actually have, so a missing one is a warning rather than a failure.
const resumePath = join(ROOT, profile.resume || 'resume.md');
const resume = existsSync(resumePath) ? readFileSync(resumePath, 'utf8').toLowerCase() : '';
if (!resume) {
  console.warn('No resume at ' + (profile.resume || 'resume.md') +
    '. Stack matching is off; everything else still works.\n');
}

// Anything a user typed into profile.json is escaped before it reaches a RegExp.
const rx = terms => new RegExp(terms
  .map(t => String(t).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .filter(Boolean).join('|'), 'i');

// Home: the places where going into an office is acceptable.
const HOME = rx(profile.home && profile.home.aliases && profile.home.aliases.length
  ? profile.home.aliases : ['~no-home-configured~']);
const HOME_LABEL = (profile.home && profile.home.country) || 'home';

// Region words that include home. An aggregator saying "Europe" covers someone
// in Latvia; one saying "United States" does not. Configure it in profile.json.
const COVERS_HOME = rx([
  ...((profile.home && profile.home.aliases) || []),
  ...((profile.home && profile.home.covered_by) || []),
  'worldwide', 'anywhere', 'global', 'any country', 'fully distributed'
]);

// ---------------------------------------------------------------- adapters
// Each returns a normalised { company, title, location, url, posted }.
// An adapter with `raw: 'text'` is handed the response body as a string
// instead of parsed JSON, for the XML feeds.

// RSS wraps some fields in CDATA. Unwrapping is separate from entity decoding
// because bodies must stay escaped until plain() runs its own ordered passes.
const unwrapCdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

// For short plain-text fields such as <title>, where there is no markup to
// strip and the entities are simply text.
const decodeXml = s => decodeEntities(unwrapCdata(s));

const ADAPTERS = {
  greenhouse: {
    // content=true returns the full posting body in the same request, which is
    // the only place the years-of-experience floor is ever stated.
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
    parse: (d, c) => (d.jobs || []).map(j => ({
      company: c,
      title: j.title || '',
      location: (j.location && j.location.name) || '',
      url: j.absolute_url || '',
      posted: j.updated_at || '',
      body: j.content || ''
    }))
  },
  lever: {
    url: s => `https://api.lever.co/v0/postings/${s}?mode=json`,
    parse: (d, c) => (Array.isArray(d) ? d : []).map(j => ({
      company: c,
      title: j.text || '',
      location: (j.categories && j.categories.location) || '',
      url: j.hostedUrl || '',
      posted: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      body: j.descriptionPlain || j.description || ''
    }))
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    parse: (d, c) => (d.jobs || []).map(j => ({
      company: c,
      title: j.title || '',
      location: j.location || '',
      url: j.jobUrl || '',
      posted: j.publishedAt || '',
      body: j.descriptionPlain || j.descriptionHtml || ''
    }))
  },
  recruitee: {
    url: s => `https://${s}.recruitee.com/api/offers/`,
    parse: (d, c) => (d.offers || []).map(j => ({
      company: c,
      title: j.title || '',
      location: [j.city, j.country].filter(Boolean).join(', '),
      url: j.careers_url || '',
      posted: j.published_at || ''
    }))
  },
  workable: {
    url: s => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    parse: (d, c) => (d.jobs || []).map(j => ({
      company: c,
      title: j.title || '',
      location: [j.city, j.country].filter(Boolean).join(', '),
      url: j.url || j.application_url || '',
      posted: j.published_on || ''
    }))
  },

  // Teamtailor exposes a zero-auth RSS feed at <slug>.teamtailor.com/jobs.rss.
  // Endpoint learned from the career-ops project (MIT), providers/teamtailor.mjs.
  // An earlier attempt at /jobs.json returned HTML, which is why this was
  // written off as unreachable the first time round.
  //
  // The feed beats most JSON sources here: it states <remoteStatus> outright
  // and gives a structured city and country, so no work-mode sniffing is
  // needed. It is often the only route to smaller European employers, who run
  // Teamtailor far more than they run Greenhouse.
  teamtailor: {
    url: s => `https://${s}.teamtailor.com/jobs.rss`,
    raw: 'text',
    parse: (xml, c) => {
      const items = String(xml).split('<item>').slice(1);
      const tag = (s, t) => {
        const m = s.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>'));
        return m ? m[1].trim() : '';
      };
      return items.map(it => {
        const city = tag(it, 'tt:city') || tag(it, 'tt:name');
        const country = tag(it, 'tt:country');
        const remote = tag(it, 'remoteStatus').toLowerCase();
        const place = [city, country].filter(Boolean).join(', ');
        return {
          company: c,
          title: decodeXml(tag(it, 'title')),
          // remoteStatus is authoritative, so it is folded into the location
          // string that workMode() and remoteOpenToHome() already read.
          location: remote === 'fully'
            ? 'Remote' + (place ? ', ' + place : '')
            : (place || ''),
          url: tag(it, 'link'),
          posted: tag(it, 'pubDate'),
          // Left entity-escaped on purpose. plain() does the strip-then-decode
          // double pass itself, and decoding here first would be the exact
          // ordering bug its comment warns about.
          body: unwrapCdata(tag(it, 'description')),
          remoteStatus: remote
        };
      }).filter(j => j.title && j.url);
    }
  },

  // ---- aggregators -------------------------------------------------------
  // These list many employers rather than one, so `company` comes from the
  // posting and the source name is only a label. Everything they carry is
  // remote by definition, so `location` here means "remote from where", which
  // is exactly what remoteOpenToHome() needs to read.

  remoteok: {
    url: () => 'https://remoteok.com/api',
    // The first array entry is a legal notice, not a job. Their terms ask for
    // a link back to remoteok.com wherever these postings are shown.
    parse: d => (Array.isArray(d) ? d.slice(1) : []).map(j => ({
      company: j.company || 'unknown',
      title: j.position || '',
      location: j.location || '',
      url: j.apply_url || j.url || '',
      posted: j.date || '',
      body: j.description || '',
      via: 'RemoteOK'
    }))
  },
  remotive: {
    url: () => 'https://remotive.com/api/remote-jobs',
    parse: d => (d.jobs || []).map(j => ({
      company: j.company_name || 'unknown',
      title: j.title || '',
      location: j.candidate_required_location || '',
      url: j.url || '',
      posted: j.publication_date || '',
      body: j.description || '',
      via: 'Remotive'
    }))
  },
  arbeitnow: {
    url: () => 'https://www.arbeitnow.com/api/job-board-api',
    parse: d => (d.data || []).map(j => ({
      company: j.company_name || 'unknown',
      title: j.title || '',
      // Their `remote` boolean is more reliable than the city string. Arbeitnow
      // is a European board, so a remote listing there is Europe-eligible; the
      // city is kept for display but does not narrow it.
      location: j.remote
        ? ('Remote, Europe' + (j.location ? ' (' + j.location + ')' : ''))
        : (j.location || ''),
      url: j.url || '',
      posted: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
      body: j.description || '',
      via: 'Arbeitnow'
    }))
  },
  jobicy: {
    // The only aggregator here that honours filter params, so the narrowing
    // happens server side instead of pulling a random slice and binning 95%.
    // geo=europe still includes postings marked "Anywhere".
    url: () => 'https://jobicy.com/api/v2/remote-jobs?count=50&geo=europe&industry=engineering',
    parse: d => (d.jobs || []).map(j => ({
      company: j.companyName || 'unknown',
      title: j.jobTitle || '',
      location: Array.isArray(j.jobGeo) ? j.jobGeo.join(', ') : (j.jobGeo || ''),
      url: j.url || '',
      posted: j.pubDate || '',
      body: [j.jobExcerpt, j.jobDescription, (j.jobLevel || '')].join(' '),
      via: 'Jobicy'
    }))
  },
  himalayas: {
    url: () => 'https://himalayas.app/jobs/api?limit=100',
    parse: d => (d.jobs || d.data || []).map(j => ({
      company: j.companyName || 'unknown',
      title: j.title || '',
      location: Array.isArray(j.locationRestrictions)
        ? j.locationRestrictions.join(', ') : (j.locationRestrictions || ''),
      url: j.applicationLink || j.guid || '',
      posted: j.pubDate || '',
      body: [j.excerpt, j.description, (j.seniority || '')].join(' '),
      via: 'Himalayas'
    }))
  }
};

// Aggregators carry only remote work, so their postings skip the work-mode
// sniffing that company boards need.
const REMOTE_BOARDS = new Set(['remoteok', 'remotive', 'arbeitnow', 'jobicy', 'himalayas']);

// ---------------------------------------------------------------- fetching
//
// Retry policy adapted from the career-ops project, providers/_http.mjs
// (MIT, Copyright (c) 2026 Santiago Fernandez de Valderrama).
// https://github.com/career-ops-hq/career-ops
//
// Added because Spotify and Vercel both timed out on real runs and silently
// vanished from the shortlist. A source that fails should be retried, and if
// it still fails, said so loudly with the number of attempts.

const RETRY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8000 };
const JITTER_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Milliseconds from a Retry-After header, in either permitted form: delta
// seconds, or an HTTP date. Null when absent or unparseable.
function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

// Worth retrying: 429, any 5xx, or a transport error with no status at all
// (timeout, abort, DNS). Any other 4xx is the server saying the request itself
// is wrong, and repeating it just burns time. A dead slug should fail fast.
function isRetryable(err) {
  const status = err && err.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return status === undefined;
}

async function withRetry(request) {
  const { retries, baseDelayMs, maxDelayMs } = RETRY;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request();
    } catch (err) {
      lastErr = err;
      // Assigning to a primitive rejection throws in strict mode, which would
      // replace the real error with an unrelated TypeError right here.
      if (err !== null && (typeof err === 'object' || typeof err === 'function')) {
        err.attempts = attempt + 1;
      }
      if (attempt === retries || !isRetryable(err)) throw err;

      // Cap the backoff at maxDelay MINUS the jitter, so the jittered total
      // still honours the limit. Clamping the sum instead would erase the
      // jitter exactly at the cap, where de-synchronising retries matters most.
      const jitterMs = Math.min(JITTER_MS, Math.max(0, maxDelayMs));
      const ceiling = Math.max(0, maxDelayMs - jitterMs);
      const backoff = Math.min(baseDelayMs * 2 ** attempt, ceiling);
      const retryAfterMs = parseRetryAfterMs(err && err.retryAfter);
      // Retry-After is honoured but clamped, so a hostile or misconfigured
      // "Retry-After: 86400" cannot stall the whole run.
      const delayMs = retryAfterMs !== null
        ? Math.min(retryAfterMs, maxDelayMs * 4)
        : backoff + Math.random() * jitterMs;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function pull(entry) {
  const a = ADAPTERS[entry.board];
  if (!a) return { entry, error: 'unknown board type: ' + entry.board };
  try {
    const jobs = await withRetry(async () => {
      const res = await fetch(a.url(entry.slug), {
        headers: { accept: 'application/json, application/rss+xml, application/xml;q=0.9' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        err.retryAfter = res.headers.get('retry-after');
        throw err;
      }
      const body = a.raw === 'text' ? await res.text() : await res.json();
      return a.parse(body, entry.name);
    });
    for (const j of jobs) j.board = entry.board;
    return { entry, jobs };
  } catch (e) {
    const what = e && e.name === 'TimeoutError' ? 'timed out' : (e && e.message) || String(e);
    const tries = e && e.attempts ? ' after ' + e.attempts + ' attempts' : '';
    return { entry, error: what + tries };
  }
}

// ---------------------------------------------------------------- filtering

// Needles containing punctuation or spaces (c++, ci/cd, "full stack") match as
// plain substrings. Bare single words match on word boundaries, so "intern"
// does not eat "International" and "lead" does not eat "Leadership". That bug
// cost 351 of 352 postings on the first live run.
function matches(hay, needle) {
  if (!/^[a-z0-9]+$/.test(needle)) return hay.includes(needle);
  return new RegExp('\\b' + needle + '\\b').test(hay);
}

const has = (hay, needles) => needles.some(n => matches(hay, n));
const f = cfg.filters;

// The rule this filter exists to express: remote is fine wherever the company
// is, but going into an office is only acceptable at home. So the question is
// never "which country is this in", it is "does this require being somewhere,
// and if so, where".

// This started life as a list of acceptable countries and was wrong in both
// directions at once: it dropped remote roles in India that were perfectly
// fine, and kept office jobs in Amsterdam that would have meant relocating.
// Modelling the proxy instead of the question.
function workMode(job) {
  // Aggregators only carry remote work, so their own listing is the answer.
  if (REMOTE_BOARDS.has(job.board)) return 'remote';

  const l = job.location.toLowerCase();
  const b = plain(job.body).toLowerCase();

  // An explicit refusal of remote beats a location string that says "Remote".
  // Adyen's postings are the case that motivated this: they list an office
  // city and then say "we do not offer remote-only roles".
  if (/we do not offer remote|not offer remote.only|office.first|on.?site only|onsite only|fully in.office|100% (?:in|from) (?:the )?office/.test(b)) {
    return 'onsite';
  }
  if (/\bremote\b|anywhere|distributed/.test(l)) return 'remote';
  // Body phrases must be specific. An earlier "remote (" pattern tagged a
  // Helsinki office role as remote because the words appeared in a benefits
  // paragraph.
  if (/fully remote|remote.first company|work from anywhere|100% remote/.test(b)) return 'remote';
  if (/hybrid/.test(l) || /\bhybrid\b/.test(b)) return 'hybrid';
  if (l === '') return 'unknown';
  return 'onsite';
}

const inHome = s => HOME.test(String(s).toLowerCase());

// "Remote" rarely means remote from anywhere. Most companies only hire where
// they have a legal entity, and they say so by listing countries:
// "Remote, Canada; Remote, United States" is remote FROM Canada or the US.
// Returns true (open to home), false (closed), or null (cannot tell).
// Aggregators state eligibility as a region list ("LATAM, Europe, USA, Canada,
// APAC"), so a region covering home appearing anywhere in it is a yes.
function remoteOpenToHome(job) {
  const l = job.location.toLowerCase();
  if (inHome(l)) return true;
  if (COVERS_HOME.test(l)) return true;

  // A bare "Remote" names no restriction at all, so it is open until the
  // posting says otherwise. Checked before the allowlist test below, which
  // would otherwise read the word "remote" as a place name.
  if (/^\s*remote\s*$/.test(l.trim())) return true;

  // A location naming specific places is an allowlist, and nothing covering
  // home was on it or the checks above would have caught it. True for both
  // "Remote, Canada; Remote, United States" and a bare "United States".
  if (l.trim() !== '') return false;

  const b = plain(job.body).toLowerCase();
  if (inHome(b)) return true;
  if (/anywhere in the world|from any country|fully distributed|hire globally/.test(b)) return true;
  return null;
}

function keep(job) {
  if (SHOW_ALL) return true;
  const t = job.title.toLowerCase();
  if (has(t, f.title_exclude)) return false;
  if (!has(t, f.title_include)) return false;

  const mode = workMode(job);
  job.mode = mode;

  // Remote is fine wherever the company is, as long as they can actually hire
  // someone sitting at home. Unknown is kept so a vague posting gets a look
  // rather than being silently binned.
  if (mode === 'remote') {
    const open = remoteOpenToHome(job);
    job.remoteOpen = open;
    return open !== false;
  }
  if (mode === 'unknown') return true;

  // On-site and hybrid both mean showing up, so both are home only.
  return inHome(job.location) || inHome(plain(job.body).slice(0, 4000));
}

// ---------------------------------------------------------------- prescore

// Skills pulled straight from resume.md so this never drifts from the source.
const SKILLS = ['javascript', 'typescript', 'python', 'c++', 'php', 'sql', 'go',
  'java', 'react', 'svelte', 'unreal', 'django', 'laravel', 'fastapi', 'spring',
  'node', 'azure', 'docker', 'github actions', 'ci/cd', 'git', 'machine learning',
  'rest', 'microservices', 'testing', 'html', 'css', 'maplibre', 'htmx'];

// Anywhere outside the EU, EEA and Switzerland. "Remote, Bangalore" is not a
// job he can take, and the word "Remote" should not earn it points.
const NON_EU = /united states|u\.s\.|\busa\b|canada|india|bangalore|bengaluru|pune|hyderabad|singapore|australia|japan|brazil|mexico|argentina|philippines|united kingdom|\buk\b|london|manchester|dubai|emirates|\buae\b|israel|turkey|egypt|nigeria|kenya|south africa|china|hong kong|korea|taiwan|vietnam|thailand|indonesia|malaysia|new zealand/;

// HTML to plain text, so the body can be pattern matched.
// Adapted from the career-ops project, providers/_html-to-text.mjs
// (MIT, Copyright (c) 2026 Santiago Fernandez de Valderrama).
//
// Three things the naive version here got wrong, all of which corrupted the
// text that experienceFloor() and workMode() read:
//
//  1. `<[^>]+>` stops at the first `>`, including one inside a quoted
//     attribute value, spilling the rest of the attributes out as body text.
//  2. Stripping <script> and <style> tags but not their contents left
//     JavaScript and CSS in the text being keyword matched.
//  3. Decoding entities before stripping markup turns quote entities inside
//     an attribute into real delimiters, which then break the tag matcher.
//     Strip first, then decode.

const HTML_MEDIA_RE = /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;
const HTML_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')+>/g;

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

const stripMarkup = s => String(s).replace(HTML_MEDIA_RE, ' ').replace(HTML_TAG_RE, ' ');

function plain(html) {
  if (typeof html !== 'string' || !html) return '';
  // Double pass: the payload often carries entity-escaped tags (&lt;p&gt;), so
  // the first decode reveals real tags for the second strip to remove.
  const once = decodeEntities(stripMarkup(html));
  return decodeEntities(stripMarkup(once)).replace(/\s+/g, ' ').trim();
}

// The years-of-experience floor is stated in the body, never in the title.
// Without this, a 6+ year role and a graduate role rank identically. Returns
// the minimum years demanded, or null when the posting does not say.
function experienceFloor(body) {
  const txt = plain(body);
  let floor = null;
  // U+2012 to U+2015 are the figure, en, em and horizontal bar dashes.
  // Postings write experience ranges with all of them. Written as escapes
  // rather than literal characters, so no such character sits in this
  // workspace, which is a house rule here.
  const DASH = '(?:\\+|to|-|[\\u2012-\\u2015])';
  const patterns = [
    new RegExp('(\\d+)\\s*' + DASH + '\\s*(?:\\d+)?\\s*years?\\s+(?:of\\s+)?' +
      '(?:relevant\\s+|professional\\s+|hands.on\\s+|industry\\s+)?experience', 'gi'),
    /(?:at least|minimum(?: of)?|min\.?)\s*(\d+)\s*years?/gi,
    /(\d+)\+\s*years?/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(txt)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 20) floor = floor === null ? n : Math.min(floor, n);
    }
  }
  return floor;
}

// Years of professional experience, from profile.json. Used to judge how far
// out of reach a stated experience floor is.
const MY_YEARS = Number(profile.years_experience || 0);

function prescore(job) {
  const t = job.title.toLowerCase();
  const l = job.location.toLowerCase();
  let s = 0;
  const why = [];

  // Is this an engineering role at all? Everything else is secondary. Without
  // this gate a "Junior Customer Experience Consultant" outranks a Java role,
  // purely on the word "junior".
  const isEng = /\b(engineer|developer|programmer)\b/.test(t);
  if (isEng) { s += 20; }
  else { why.push('not an engineering title'); }

  const hits = SKILLS.filter(k => t.includes(k) && resume.includes(k));
  if (hits.length) {
    s += Math.min(hits.length * 14, 40);
    why.push('stack: ' + hits.join(', '));
  }

  if (/junior|graduate|trainee|entry.level|\bi\b|\b1\b/.test(t)) {
    s += 25;
    why.push('junior level');
  } else if (/senior|staff|principal|\blead\b|\biii\b|\biv\b/.test(t)) {
    s -= 50;
    why.push('too senior');
  }

  // What he actually wants to build, in his own order: fullstack, frontend, web.
  if (/full.?stack|front.?end|\bweb\b|react|javascript|typescript|\bui\b/.test(t)) {
    s += 15; why.push('fullstack/frontend');
  }

  // Location. Anything on-site away from home was already dropped by keep(),
  // so what reaches here is remote, at home, or unstated.
  const mode = job.mode || workMode(job);
  if (mode === 'remote') {
    const open = job.remoteOpen === undefined ? remoteOpenToHome(job) : job.remoteOpen;
    if (open === true) { s += 25; why.push('remote, open to you'); }
    else { s += 8; why.push('remote, but confirm they can hire where you live'); }
    if (NON_EU.test(l)) why.push('non-EU employer');
  } else if (inHome(l) || inHome(plain(job.body).slice(0, 4000))) {
    s += 25; why.push(HOME_LABEL + ', ' + mode);
  } else {
    s += 5; why.push('work mode unclear, check the posting');
  }

  // Experience floor, read from the body. This is the single biggest correction
  // the prescore makes, because a "Software Engineer I" can still demand 5 years.
  const floor = experienceFloor(job.body);
  if (floor === null) {
    s += 10;
    why.push('no experience floor stated');
  } else {
    const gap = floor - MY_YEARS;
    if (gap <= 0) { s += 12; why.push('needs ' + floor + 'y, you have ' + MY_YEARS + 'y'); }
    else if (gap <= 1) { s -= 5; why.push('needs ' + floor + 'y, close'); }
    else if (gap <= 2) { s -= 25; why.push('needs ' + floor + 'y, a stretch'); }
    else { s -= 60; why.push('needs ' + floor + 'y, out of range'); }
  }

  // A non-engineering title cannot rank above the weakest real engineering role,
  // however many other boxes it ticks.
  if (!isEng) s = Math.min(s, 25);

  return {
    score: Math.max(0, Math.min(100, s)),
    floor,
    why: why.join('; ') || 'title match only'
  };
}

// ---------------------------------------------------------------- main

const seenPath = join(ROOT, 'feed', 'seen.json');
const seen = existsSync(seenPath)
  ? new Set(JSON.parse(readFileSync(seenPath, 'utf8')))
  : new Set();

console.log('Pulling ' + cfg.companies.length + ' sources...\n');
const results = await Promise.all(cfg.companies.map(pull));

const failures = results.filter(r => r.error);
const all = results.filter(r => r.jobs).flatMap(r => r.jobs);

for (const r of results) {
  const label = r.entry.name + ' (' + r.entry.board + '/' + r.entry.slug + ')';
  console.log(r.error
    ? '  FAIL  ' + label + ': ' + r.error
    : '  ok    ' + label + ': ' + r.jobs.length + ' postings');
}

// A link is "direct" when it lands on the employer's own applicant tracking
// system, which is where the application actually gets submitted. Aggregator
// links were checked and do NOT redirect through to the employer: they stay on
// jobicy.com or arbeitnow.com, where applying needs an account on their site.
// So aggregators are a discovery signal, not an application route.
const DIRECT_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|teamtailor\.com|recruitee\.com|workable\.com|myworkdayjobs\.com|smartrecruiters\.com)$/i;

function isDirect(job) {
  if (job.via) return false;
  try { return DIRECT_HOSTS.test(new URL(job.url).hostname) || !job.via; }
  catch { return false; }
}

for (const j of all) j.direct = isDirect(j);

const filtered = all.filter(keep);

// If a company is already read from its own board, drop the aggregator copies
// of it. Eight Canonical roles were arriving twice, and the second copy was
// always the worse door.
const directCompanies = new Set(
  filtered.filter(j => j.direct).map(j => j.company.toLowerCase())
);
const deduped = filtered.filter(j => j.direct || !directCompanies.has(j.company.toLowerCase()));
const droppedDupes = filtered.length - deduped.length;

const fresh = KEEP_SEEN ? deduped : deduped.filter(j => !seen.has(j.url));
const scored = fresh.map(j => Object.assign({}, j, prescore(j)))
  .sort((a, b) => b.score - a.score);

console.log('\n' + all.length + ' pulled  ->  ' + filtered.length +
  ' match filters  ->  ' + fresh.length + ' new');

mkdirSync(join(ROOT, 'feed'), { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
// Drop the bodies before archiving. Keeping ~1000 full HTML postings would turn
// a useful debugging artefact into a 30 MB file nobody opens.
writeFileSync(join(ROOT, 'feed', 'raw-' + stamp + '.json'),
  JSON.stringify(all.map(({ body, ...rest }) => rest), null, 2));

const lines = [
  '# Shortlist, ' + stamp,
  '',
  all.length + ' postings pulled from ' + cfg.companies.length + ' sources. ' +
  filtered.length + ' passed the filters. ' + fresh.length + ' are new since the last run.',
  '',
  'Prescore is keyword matching only, meant to rank what is worth your attention.',
  'Ask the agent to properly score anything here before applying: it runs the',
  '100 point rubric in `runbook.md` against the full description.',
  ''
];

if (!scored.length) {
  lines.push('Nothing new today.', '',
    'If that keeps happening, check the FAIL lines above for a bad slug, or widen',
    '`filters.title_include` in `sources.json`.');
} else {
  lines.push('| Score | Mode | Needs | Company | Role | Location |',
    '|---:|:--:|:--:|---|---|---|');
  const cell = s => String(s).replace(/\|/g, '/').slice(0, 70);
  for (const j of scored) {
    const floor = j.floor === null ? '-' : j.floor + 'y';
    lines.push('| ' + j.score + ' | ' + (j.mode || '?') + ' | ' + floor + ' | ' +
      cell(j.company) + ' | [' + cell(j.title) + '](' + j.url + ') | ' +
      (cell(j.location) || 'not stated') + ' |');
  }
  lines.push('',
    '`Mode` is remote, hybrid, onsite or unknown. On-site and hybrid roles away ' +
    'from home are dropped entirely, since those would mean relocating.',
    '',
    '`Needs` is the years of experience the posting demands, read out of the body ' +
    'text. A dash means the posting does not say, which is usually good news. The ' +
    'title never tells you this: Adyen list a "Software Engineer I" at 2 years and ' +
    'a plain "Software Engineer" at 6.');
}

if (failures.length) {
  lines.push('', '## Sources that failed', '',
    'A wrong slug fails loudly on purpose. Fix it in `sources.json` or remove the entry.',
    '');
  for (const x of failures) {
    lines.push('- **' + x.entry.name + '** (' + x.entry.board + '/' + x.entry.slug +
      '): ' + x.error);
  }
}

writeFileSync(join(ROOT, 'shortlist.md'), lines.join('\n') + '\n');

// Structured copy of the same shortlist, for the browsable page.
writeFileSync(join(ROOT, 'feed', 'shortlist.json'), JSON.stringify({
  generated: new Date().toISOString(),
  pulled: all.length,
  sources: cfg.companies.length,
  jobs: scored.map(j => ({
    score: j.score,
    mode: j.mode || 'unknown',
    floor: j.floor,
    company: j.company,
    title: j.title.trim(),
    location: j.location,
    url: j.url,
    why: j.why,
    posted: j.posted,
    via: j.via || null,
    direct: j.direct === true
  }))
}, null, 2));

if (!KEEP_SEEN) {
  for (const j of fresh) seen.add(j.url);
  writeFileSync(seenPath, JSON.stringify([...seen], null, 2));
}

console.log('\nWrote shortlist.md' +
  (failures.length ? '  (' + failures.length + ' sources failed, listed at the bottom)' : ''));
