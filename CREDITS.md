# Credits

## career-ops

Three things here are adapted from
[career-ops](https://github.com/career-ops-hq/career-ops) (MIT), and are marked
in the source where they appear.

**The Teamtailor endpoint**, from their `providers/teamtailor.mjs`: every
Teamtailor career site exposes a zero-auth RSS feed at
`https://<slug>.teamtailor.com/jobs.rss`. An earlier attempt here used
`/jobs.json`, got HTML back, and wrote the whole platform off as unreachable.
That one path is the only route to a large number of smaller European employers.

**The retry policy**, from their `providers/_http.mjs`, including the two
details worth keeping: backoff is capped at the maximum delay minus the jitter
so the jittered total still honours the limit, and `Retry-After` is honoured but
clamped so a hostile value cannot stall a sweep.

**The HTML to text pipeline**, from their `providers/_html-to-text.mjs`. The
naive version it replaced had three bugs: it stopped at the first `>` even
inside a quoted attribute, it left `<script>` and `<style>` contents in the text
being keyword matched, and it decoded entities before stripping markup rather
than after.

career-ops is a much larger system than this one and worth using directly if you
want the whole job-search pipeline rather than just the aggregation.

```
MIT License

Copyright (c) 2026 Santiago Fernandez de Valderrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Job sources

Postings come from public company job boards and five remote aggregators.
Remote OK asks for a link back wherever their postings are shown:
<https://remoteok.com>.
