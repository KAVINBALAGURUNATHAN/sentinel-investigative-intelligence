# SENTINEL — Investigator Interface

React 19 + Vite 8 + D3. Plain JavaScript, no TypeScript. One hand-authored
stylesheet driven by CSS custom properties — no Tailwind, no component library.

```bash
npm install
npm run dev        # http://localhost:5173
```

The backend is expected at `http://127.0.0.1:8000`. Use `localhost`, not
`127.0.0.1`, for the dev server — Vite binds `::1`.

```bash
npm run build      # production bundle
npm run lint       # oxlint
```

---

## Layout

```
src/investigator/
├── App.jsx            Shell, routing, case selection, theme
├── pages.jsx          Every page: cases, timeline, patterns, entities,
│                      evidence, ingestion, reports, validation
├── NetworkGraph.jsx   D3 force-directed graph
├── ui.jsx             Panel, Table, Tile, Empty, Async, useApi, Icon
├── api.js             Every backend call, in one place
├── labels.js          Display vocabulary and the event→domain map
├── feedback.jsx       Toasts
└── theme.css          All styling. Design tokens at the top.
```

Two rules worth knowing before editing:

- **`api.js` is the only place that talks to the backend.** A component that
  fetches directly bypasses the loading and error handling every page relies on.
- **`theme.css` defines its tokens at the top and nothing hardcodes a colour.**
  A `var(--name)` that does not resolve fails silently — the browser drops the
  declaration and the element renders unstyled, with no console error. If you
  add a token, define it in `:root` first.

---

## What the interface is careful about

This is decision-support software, so the display has obligations the data does
not.

**It never states a conclusion the analysis cannot support.** The vocabulary is
"requires investigation", "anomalous", "pattern detected" — never "criminal",
"guilty" or "proves". A statistical finding means activity is unusual for that
subject, and the wording says exactly that.

**It distinguishes a conclusion from an observation.** On the network graph,
ownership edges (`OWNS`, `USES`) are drawn dashed because they are what entity
resolution concluded; activity edges (`CALLED`, `TRANSFERRED`) are solid because
they are what the records observed. Clicking either says which it is.

**It never shows a figure it cannot source.** Counts, statistics and findings
are rendered from the API response. Where a capability is not wired up the page
says so rather than displaying a plausible-looking placeholder.

**It says when data is degraded.** If the graph was rebuilt from the event store
because the graph database was unreachable, a banner says so — a fallback
presented as the live projection would hide that the projection is stale.

**Identifiers are masked by default.** Unmasking is an authorisation decision;
the mode is set by the backend display policy, which fails safe to masked.

---

## The network graph

`NetworkGraph.jsx` is the densest file here. Three behaviours are deliberate:

- **Ownership costs no hop.** A person keeps their own phone and accounts at
  every depth. Charging a hop for "your own handset" would push a direct contact
  three rings out and draw them faded — the opposite of the truth.
- **Labels never overlap a node or each other.** They are offset perpendicular
  to the edge and slid along it until clear; any that still collide once the
  layout settles are hidden, heaviest edge first. On a dense case this hides
  roughly a third of them — two labels printed through each other are not two
  pieces of information but none. Every edge still shows its count on hover.
- **The fit transform is guarded against non-finite values.** A single node with
  an undefined coordinate would otherwise produce `translate(NaN,NaN)`, which
  throws no error and silently blanks the canvas — indistinguishable from a case
  with no data.
