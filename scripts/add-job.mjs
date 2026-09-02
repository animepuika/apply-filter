#!/usr/bin/env node
// Turns a single job URL you paste into a jobs/<slug>/jd.md, ready for the
// runbook.md scoring pass.
//
// Usage:
//   node scripts/add-job.mjs "https://www.linkedin.com/jobs/view/4395235579"
//   node scripts/add-job.mjs "https://boards.greenhouse.io/acme/jobs/123"
//   node scripts/add-job.mjs --paste          then paste the text, Ctrl+Z, Enter
//
// One URL per invocation, on a link you chose. This is deliberately not a
// crawler: there is no search, no pagination, and no loop over a list. For
// LinkedIn that distinction is the whole point, since their User Agreement is
// aimed at automated collection rather than at reading a page you opened.
//
// If a fetch ever comes back thin or walled, use --paste. Pasting the text
// makes zero requests and always works.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// Keeps list and paragraph breaks, because a jd.md is read by a person and the
// shape of the requirements list is most of its meaning.
function toText(html) {
  const once = decodeEntities(String(html).replace(HTML_MEDIA_RE, ' '));
  return decodeEntities(
    once
      .replace(HTML_MEDIA_RE, ' ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|h[1-6]|ul|ol|li)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(HTML_TAG_RE, '')
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const slugify = s => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// LinkedIn's guest job endpoint serves the posting body without a login. Used
// only for a URL handed in on the command line.
function linkedinGuestUrl(url) {
  const m = String(url).match(/linkedin\.com\/jobs\/view\/(?:[^/]*-)?(\d{6,})/) ||
            String(url).match(/currentJobId=(\d{6,})/);
  return m ? 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + m[1] : null;
}

function parse(html, url) {
  const pick = (...res) => {
    for (const re of res) {
      const m = html.match(re);
      if (m && m[1] && m[1].trim()) return decodeEntities(m[1]).trim();
    }
    return '';
  };

  const title = pick(
    /top-card-layout__title[^>]*>\s*([^<]+)/,
    /"title"\s*:\s*"([^"]{3,120})"/,
    /<h1[^>]*>\s*([^<]+)/,
    /<title>([^<|]+)/
  );
  const company = pick(
    /topcard__org-name-link[^>]*>\s*([^<]+)/,
    /topcard__flavor[^>]*>\s*([^<]+)/,
    /"hiringOrganization"[\s\S]{0,120}?"name"\s*:\s*"([^"]+)"/
  );
  const location = pick(
    /topcard__flavor--bullet[^>]*>\s*([^<]+)/,
    /"addressLocality"\s*:\s*"([^"]+)"/,
    /job-search-card__location[^>]*>\s*([^<]+)/
  );

  const bodyMatch = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/) ||
                    html.match(/description__text[^>]*>([\s\S]*?)<\/section>/) ||
                    html.match(/"description"\s*:\s*"([\s\S]{200,}?)"\s*,/);
  const body = bodyMatch ? toText(bodyMatch[1]) : toText(html);

  return { title, company, location, body, url };
}

// ---------------------------------------------------------------- main

const arg = process.argv[2];
if (!arg) {
  console.log('usage: node scripts/add-job.mjs <job url>');
  console.log('   or: node scripts/add-job.mjs --paste   (then paste, Ctrl+Z, Enter)');
  process.exit(1);
}

let parsed;

if (arg === '--paste') {
  console.log('Paste the posting, then Ctrl+Z and Enter on Windows.\n');
  const text = await readStdin();
  if (!text.trim()) { console.log('nothing pasted'); process.exit(1); }
  parsed = {
    title: (text.split('\n').find(l => l.trim()) || 'pasted role').trim().slice(0, 90),
    company: '', location: '', body: text.trim(), url: 'pasted by hand'
  };
} else {
  const target = linkedinGuestUrl(arg) || arg;
  if (target !== arg) console.log('LinkedIn detected, using the guest posting endpoint.');
  const res = await fetch(target, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', accept: 'text/html,application/json' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) { console.log('HTTP ' + res.status + '. Try --paste instead.'); process.exit(1); }
  parsed = parse(await res.text(), arg);
  if (parsed.body.length < 300) {
    console.log('Only ' + parsed.body.length + ' characters came back, which usually means a');
    console.log('login wall. Open the page yourself and rerun with --paste.');
    process.exit(1);
  }
}

const slug = slugify([parsed.company, parsed.title].filter(Boolean).join(' ')) || 'job-' + Date.now();
const dir = join(ROOT, 'jobs', slug);
if (existsSync(join(dir, 'jd.md'))) {
  console.log('already captured: jobs/' + slug + '/jd.md');
  process.exit(0);
}
mkdirSync(dir, { recursive: true });

const head = [
  'Company: ' + (parsed.company || 'TODO, not found in the page'),
  'Role: ' + (parsed.title || 'TODO'),
  'Location: ' + (parsed.location || 'TODO, not stated in the page'),
  'On-site / hybrid / remote: TODO, read it off the posting',
  'Source URL: ' + parsed.url,
  'Date seen: ' + new Date().toISOString().slice(0, 10),
  ''
].join('\n');

writeFileSync(join(dir, 'jd.md'), head + '\n' + parsed.body + '\n');

console.log('\nwrote jobs/' + slug + '/jd.md');
console.log('  company : ' + (parsed.company || '(not found)'));
console.log('  role    : ' + (parsed.title || '(not found)'));
console.log('  location: ' + (parsed.location || '(not found)'));
console.log('  body    : ' + parsed.body.length + ' characters');
console.log('\nNow ask the agent: score jobs/' + slug);
