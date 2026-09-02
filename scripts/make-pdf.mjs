#!/usr/bin/env node
// Renders a markdown resume or cover letter to an ATS-readable A4 PDF, using
// the headless Chrome already installed on this machine. No npm dependencies,
// nothing to install.
//
// Usage:
//   node scripts/make-pdf.mjs jobs/<slug>/resume-tailored.md
//   node scripts/make-pdf.mjs jobs/<slug>/cover-letter.md
//   node scripts/make-pdf.mjs jobs/<slug>            both, if present
//
// ATS notes, which drive every layout decision below:
//   - One column. Multi-column resumes get read out of order or interleaved.
//   - Real selectable text, never an image, and no icon fonts for content.
//   - Section headings in plain words a parser recognises: EXPERIENCE,
//     EDUCATION, SKILLS. Clever names cost you the section.
//   - Nothing important in a page header or footer, which parsers often drop.
//   - System fonts only, so rendering never depends on a network fetch.
//   - No tables for layout. A parser reads a table cell by cell.

import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Only used for the PDF document title. Absent is fine.
let profile = {};
try { profile = JSON.parse(readFileSync(join(ROOT, 'profile.json'), 'utf8')); } catch { /* optional */ }

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (p && existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

// ------------------------------------------------------------- markdown

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline formatting only. Escaping happens first so posting text can never
// inject markup into the document.
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// The source files are hard wrapped at about 80 characters for readability in
// an editor. Those wraps are not paragraph breaks, so consecutive non-blank
// lines are joined into one block. Treating each source line as its own
// paragraph produced loose spacing and, worse, left a bullet's continuation
// text sitting outside its own <li>, where a parser cannot tell the bullet
// ended.
function mdToHtml(md) {
  const out = [];
  let inList = false;
  let buf = [];
  let mode = null; // 'p' or 'li'

  const flush = () => {
    if (!buf.length) return;
    const text = inline(buf.join(' ').replace(/\s+/g, ' ').trim());
    if (mode === 'li') {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + text + '</li>');
    } else {
      out.push('<p>' + text + '</p>');
    }
    buf = [];
    mode = null;
  };
  const closeList = () => { flush(); if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');

    // Blockquotes carry notes to yourself, never content meant for an employer.
    if (/^>/.test(line)) { flush(); continue; }
    if (/^---+$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flush();
      mode = 'li';
      buf.push(li[1]);
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    // A non-blank, non-bullet line continues whatever block is open. Inside a
    // list that means it belongs to the current bullet, not to a new paragraph.
    if (mode) { buf.push(line.trim()); continue; }
    if (inList) { mode = 'li'; buf.push(line.trim()); continue; }
    mode = 'p';
    buf.push(line.trim());
  }
  closeList();
  return out.join('\n');
}

// A CV heading is usually shouted in capitals. That is fine on the page but
// wrong in a window title bar, so it gets normalised for the document title.
function titleCase(s) {
  if (!/[a-z]/.test(s)) {
    return s.toLowerCase().replace(/(^|[\s-])(\S)/g, (_, a, b) => a + b.toUpperCase());
  }
  return s;
}

// ------------------------------------------------------------- page

function wrap(bodyHtml, title) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  /* A4, sized so a full CV fits on one page: 9.4pt type, tight leading, 11mm
     margins. A CV must never run to two pages, so the layout is built for one
     and render() throws if it does not. */
  @page { size: A4; margin: 11mm 13mm 11mm 13mm; }

  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Calibri", "Carlito", "Segoe UI", Arial, sans-serif;
    font-size: 9.4pt;
    line-height: 1.34;
    color: #16191c;
    /* Calibri renders "ffi" as one glyph and a PDF text extractor then reads
       the email address wrong. Same fix as in cv.html. */
    font-variant-ligatures: none;
    font-feature-settings: "liga" 0, "clig" 0;
  }

  h1 {
    font-size: 17pt;
    letter-spacing: -.15pt;
    margin: 0 0 1pt;
    font-weight: 700;
  }
  /* The contact line: the first paragraph after the name. */
  h1 + p {
    margin: 0 0 6pt;
    font-size: 8.8pt;
    color: #3b4147;
  }

  h2 {
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: .08em;
    font-weight: 700;
    margin: 8pt 0 3pt;
    padding-bottom: 1.5pt;
    border-bottom: 1px solid #b9c0c6;
    /* Never orphan a heading at the foot of a page. */
    break-after: avoid;
    page-break-after: avoid;
  }

  h3 {
    font-size: 9.6pt;
    font-weight: 700;
    margin: 6pt 0 0;
    break-after: avoid;
    page-break-after: avoid;
  }

  p { margin: 0 0 3pt; }
  hr { display: none; }

  ul { margin: 2pt 0 4pt; padding-left: 12pt; }
  li {
    margin: 0 0 1.5pt;
    /* Keep a bullet whole rather than split across the page break. */
    break-inside: avoid;
    page-break-inside: avoid;
  }

  strong { font-weight: 700; }
  code { font-family: inherit; }
  a { color: inherit; text-decoration: none; }
</style></head>
<body>
${bodyHtml}
</body></html>`;
}

// Counts page objects in the PDF. Crude, but it only has to distinguish one
// page from more than one.
function countPages(pdfPath) {
  const buf = readFileSync(pdfPath).toString('latin1');
  const m = buf.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 1;
}

// ------------------------------------------------------------- render

function render(mdPath, chrome) {
  let md = readFileSync(mdPath, 'utf8');
  const stem = basename(mdPath, '.md');
  const isLetter = /cover-letter/i.test(stem);

  // The document title shows in a PDF viewer's window bar and in the file's
  // properties. A filename like "resume-tailored" there reads as an internal
  // artefact, so the title is built from your name instead.
  //
  // A CV's first heading is the name. A cover letter's first heading is a
  // filing label ("Cover letter, Acme, Backend Engineer"), so that one comes
  // from profile.json rather than from the document.
  const cvName = (md.match(/^\s*#\s+(.+?)\s*$/m) || [])[1];
  const name = (profile.name || (isLetter ? null : cvName) || 'Curriculum Vitae')
    .replace(/\*\*/g, '').trim();
  const docTitle = titleCase(name) + (isLetter ? ' Cover Letter' : ' CV');

  // A resume's first heading is the candidate's name and must stay. A cover
  // letter's is a filing label for this workspace, and printing it above
  // "Dear ..." makes the letter look like an internal document.
  if (isLetter) md = md.replace(/^\s*#\s+.*$/m, '');

  const html = wrap(mdToHtml(md), docTitle);

  const htmlPath = mdPath.replace(/\.md$/, '.print.html');
  const pdfPath = mdPath.replace(/\.md$/, '.pdf');
  writeFileSync(htmlPath, html);

  execFileSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--print-to-pdf=' + resolve(pdfPath),
    pathToFileURL(resolve(htmlPath)).href
  ], { stdio: 'pipe', timeout: 60000 });

  if (!existsSync(pdfPath)) throw new Error('Chrome produced no PDF for ' + mdPath);
  // The intermediate HTML has served its purpose.
  try { unlinkSync(htmlPath); } catch { /* harmless */ }

  const bytes = statSync(pdfPath).size;
  const pages = countPages(pdfPath);

  // House rule: a tailored CV is one page. Enforced here rather than left to
  // whoever is generating it to remember, because the failure is silent
  // otherwise: a two page CV still looks fine until a recruiter sees it.
  if (!isLetter && pages > 1) {
    throw new Error('CV ran to ' + pages + ' pages. It must be one. Cut content in ' +
      basename(mdPath) + ' and regenerate.');
  }
  return { pdfPath, bytes, pages };
}

// ------------------------------------------------------------- main

const chrome = findChrome();
if (!chrome) {
  console.log('No Chrome or Edge found. Checked:');
  for (const p of CHROME_CANDIDATES) if (p) console.log('  ' + p);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.log('usage: node scripts/make-pdf.mjs <file.md | jobs/slug>');
  process.exit(1);
}

const target = resolve(ROOT, arg);
let files = [];
if (existsSync(target) && statSync(target).isDirectory()) {
  for (const n of ['resume-tailored.md', 'cover-letter.md']) {
    const p = join(target, n);
    if (existsSync(p)) files.push(p);
  }
  if (!files.length) { console.log('no resume-tailored.md or cover-letter.md in ' + arg); process.exit(1); }
} else if (existsSync(target)) {
  files = [target];
} else {
  console.log('not found: ' + arg);
  process.exit(1);
}

console.log('using ' + basename(chrome) + '\n');
for (const f of files) {
  try {
    const { pdfPath, bytes, pages } = render(f, chrome);
    console.log('  ' + basename(pdfPath).padEnd(28) +
      (bytes / 1024).toFixed(1).padStart(6) + ' KB   ' + pages + ' page' + (pages > 1 ? 's' : ''));
  } catch (e) {
    console.log('  FAILED ' + basename(f) + ': ' + e.message.split('\n')[0]);
  }
}
