# ats-job-aggregator

Reads open engineering roles straight from companies' own applicant tracking
systems, filters them by whether you could actually take the job, and ranks
what is left against your CV.

No account, no scraping, no API key. Every source is a public endpoint a
company publishes so its jobs get syndicated.

```bash
cp profile.example.json profile.json     # who you are, and where you live
cp sources.example.json sources.json     # which companies to watch
node scripts/fetch-jobs.mjs
```

```
2126 pulled  ->  71 match filters  ->  62 after dedupe  ->  11 new
49 of 62 link straight to the employer's own application system.
```

Output is `shortlist.md`, a ranked table, plus `feed/shortlist.json` if you want
to build something on top of it.

## The idea

Most job aggregators answer "which jobs exist". The useful question is narrower:
**which jobs could I actually take.** For a lot of people that is one rule with
two halves, and it is not expressible as a list of countries:

> Remote is fine wherever the company is. An office is only acceptable at home.

The first version of this did use a country allowlist, and it was wrong in both
directions at the same time. It dropped remote roles in Bangalore that were
perfectly fine, and it kept office jobs in Amsterdam that would have meant
moving house. The list was modelling a proxy instead of the question.

`workMode()` asks the real one: does this posting require you to be somewhere,
and if so, where. That deleted the country list entirely and made the code
shorter.

## What it reads

**Company boards**, which are the employer's own application system, so a link
from here goes straight to where you apply:

| Board | Endpoint |
|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true` |
| Lever | `api.lever.co/v0/postings/<slug>?mode=json` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/<slug>` |
| Teamtailor | `<slug>.teamtailor.com/jobs.rss` |
| Recruitee | `<slug>.recruitee.com/api/offers/` |
| Workable | `apply.workable.com/api/v1/widget/accounts/<slug>` |

**Remote aggregators**: RemoteOK, Remotive, Arbeitnow, Jobicy, Himalayas. These
are useful for discovering that a company is hiring, and bad for applying,
because their links land on the aggregator rather than the employer. Postings
from them are tagged and can be filtered out.

Teamtailor is the one worth knowing about. Smaller European employers run it far
more than they run Greenhouse, and its RSS feed states `<remoteStatus>` outright
and gives a structured city and country. That is better data than most of the
JSON APIs, and it is the only route to a lot of companies.

## Things it does that are not obvious

**Reads the experience floor out of the body text.** A stated minimum never
appears in a job title. One employer here lists a "Software Engineer I" at two
years and a plain "Software Engineer" at six. The `Needs` column reads it out of
the posting, which changes the ranking more than anything else in the scorer.

**Distinguishes "remote" from "remote from where".** `Remote, Canada; Remote,
United States` is not remote. Most companies only hire where they have a legal
entity and say so by listing countries, so a location naming places is treated
as an allowlist.

**Believes the body over the location field.** A posting can say `Remote` in its
location and `we do not offer remote-only roles` three paragraphs down. The
explicit refusal wins.

**Drops aggregator duplicates.** If a company is already read from its own board,
copies of it arriving through an aggregator are discarded. That was nine
postings on a recent run, and the aggregator copy was the worse link every time.

**Fails loudly on a bad slug.** A wrong company slug returns an empty list, which
looks exactly like "no jobs today". Every source that fails is named in the
output with its error and its attempt count.

## Scripts

| Script | What it does |
|---|---|
| `fetch-jobs.mjs` | Pulls every source, filters, dedupes, scores, writes `shortlist.md` |
| `probe.mjs` | Tests whether a company slug is live before you add it |
| `add-job.mjs` | Captures a single posting from a URL into a markdown file |
| `make-pdf.mjs` | Renders a markdown CV or letter to an ATS-readable one-page A4 PDF |
| `build-page.mjs` | Builds a browsable HTML dashboard from everything you have scored |

```bash
node scripts/probe.mjs all supabase          # which board is this company on?
node scripts/fetch-jobs.mjs --keep-seen      # full list, not just what is new
node scripts/fetch-jobs.mjs --all            # ignore filters, dump everything
node scripts/add-job.mjs "<job url>"         # capture one posting
node scripts/make-pdf.mjs cv.md              # one page or it refuses to build
node scripts/build-page.mjs                  # rebuild the dashboard
```

### Scoring your own applications

`fetch-jobs.mjs`'s score is a keyword prescore. It ranks a few thousand
postings down to a shortlist; it is not a judgement about whether you should
apply. The real read is you, against the full posting, and the dashboard is
built to show that read once you have written it down.

For any posting you have looked at properly, drop a `jobs/<slug>/score.md` next
to its `jd.md` (from `add-job.mjs`, or written by hand):

```markdown
# Score: 71 / 100

**Verdict: apply.** ...your reasoning...
```

`build-page.mjs` reads the `# Score:` line and the `**Verdict:` line out of
every `jobs/*/score.md` it finds. A real score always overrides the keyword
prescore for that posting, on both a bulk-fetched role and one captured with
`add-job.mjs` from a single pasted link. A folder that never appeared in the
bulk fetch still gets a full row on the dashboard, built from what
`add-job.mjs` wrote into the `jd.md` head.

An optional `applications.md` in the same shape tracks status:

```markdown
| Date | Company | Role | Location | Score | Status | Folder | Notes |
|---|---|---|---|---|---|---|---|
| 2026-09-03 | Acme | Backend Engineer | Remote | 71 | drafted | jobs/acme-backend-engineer | |
```

Run `node scripts/build-page.mjs` and open `feed/page.html`. Neither
`jobs/` nor `applications.md` is committed; both are yours.

### The PDF renderer

Drives the Chrome already installed on the machine, so there is nothing to
install and no headless browser to download. Every layout choice is an ATS
constraint rather than a taste one: one column, real selectable text, plain
section headings, nothing in a running header, system fonts, no tables. It
counts the pages afterwards and throws if a CV came out longer than one, because
that failure is otherwise silent until a recruiter sees it.

## Rate and manners

Sources are read once per run. `add-job.mjs` takes one URL at a time and has no
search, no pagination and no loop over a list, which is the line between reading
a page you chose and automated collection.

Requests retry twice on a timeout, a 429 or a 5xx, with exponential backoff and
jitter. `Retry-After` is honoured but clamped, so a hostile or misconfigured
value cannot stall a run. A 404 fails immediately, because a dead slug will
still be dead on the third try.

RemoteOK's terms ask for a link back wherever their postings are shown:
<https://remoteok.com>.

## Requirements

Node 18 or newer, for built-in `fetch`. No dependencies. Chrome or Edge, only if
you want PDFs.

## Licence

MIT. See [CREDITS.md](CREDITS.md) for the parts adapted from other projects.
