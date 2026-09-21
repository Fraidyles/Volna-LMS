---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

## Scope

Primary target: `public/index.html` (the whole SPA — врач dashboard, course/lesson viewer,
quiz, calendar, messages, certificate — plus curator/admin/super_admin dashboard, students,
team, audit-log views rendered by `public/app.js`). Visitor mode: **Operate** throughout.

## Direction contract (v2 — supersedes the "Rounds Board" contract below)

**THESIS:** A dark-first, single-voice modern EdTech interface — the opposite of a
"whiteboard/ledger" metaphor. Status is a small circular dot + plain text, never a colored
block, a tinted pill, or capitalized tracked label. One typeface (IBM Plex Sans) carries every
role through weight alone.

**Why this replaced v1:** the user was shown the built "Rounds Board" direction and rejected it
outright as looking dated ("как из 2011 года"), providing concrete reference screenshots
(Yandex Practicum's course UI: dark theme, clean sans, soft rounded cards, thin segmented
progress, minimal chrome, friendly illustration). Per the skill's own rule, a user-provided
reference beats any prior roll or direction, always. V1's board/magnet/hand-ruled-grid identity
is fully retired, not blended.

**OWN-WORLD:** Dark base (`#121214` bg / `#1B1B1F` surface) as the true default (stored
explicitly, not just `prefers-color-scheme`), light theme as an equally complete alternate via
toggle. Single sans family, sentence case throughout, no letter-spacing tricks. Soft large radii
(10/16/24px). Hairline borders (`rgba(255,255,255,.07)`) instead of visible rules. Status dots
are circles (7px), not squares — reads as a software status indicator, not a physical token.

**STORY:** Same product truth as before (врач progress/streams/certificate/messages; staff
dashboard/roster/audit-log/calendar) — only the visual skin changed, twice now.

**FIRST VIEWPORT:** Same layout skeleton as v1 (topbar → tabs → course-hero with segmented
progress → 3-tile board-strip), restyled: thin 5px progress segments (not thick blocks), quiet
dot-status tiles, soft cards with hairline borders instead of shadows-plus-borders.

**FORM:** No dice/concept-seed ritual this round — the user supplied a concrete pinned
reference (Yandex Practicum screenshots), which per the skill's own rule overrides any
roll-based exploration. Two confirming questions were asked (dark-only vs. dark-default+toggle;
illustrations now vs. later) before building.

**Signature interaction:** a quiet `fadeUp` (opacity + 4px translateY, ease-out-expo, ~250ms)
on status dots and the certificate badge — replacing v1's rotation/overshoot "magnet snap"
entirely, consistent with the calmer world.

**FINISH:** unreviewed and undocumented is unfinished — DESIGN.md rewritten from the built v2
world (the v1 DESIGN.md content is fully superseded, not merged).

## Real bugs fixed while touching this code (not visual, discovered via testing)

1. **Event-listener accumulation**: `render()` calls `wireEvents(app)` on every re-render, and
   `#app` is never replaced (only `.innerHTML` cleared), so every one of the 5 delegated
   listeners (click/submit/change/input/keydown) was being re-attached on top of the previous
   ones on every render — after N renders, one click fired the shared handler N times. This is
   why the theme toggle appeared to silently do nothing (dark→light→dark canceled out) and would
   have caused duplicate form submissions elsewhere too. Fixed with a one-line `root.__wired`
   guard at the top of `wireEvents`. Verified: toggled 5 times then confirmed a single tab-switch
   click landed on the correct tab, not bounced back.
2. Two smaller ones from v1's review carried forward unchanged (see prior brief content below):
   student-schedule classifying a live-in-progress stream as "past", and the month calendar
   leaving trailing grid cells undrawn.

## WCAG contrast

`impeccable detect` flagged `--muted-2` at 3.6:1 against the dark background (needs 4.5:1).
Fixed: dark `--muted-2` raised to `#86868F` (5.19:1); light `--muted-2` raised to `#6E6E76`
(4.68:1) since it had the same problem un-flagged at 2.53:1. Also caught and fixed one literal
hardcoded hex in `index.html`'s pre-JS loading fallback that the CSS variable change didn't
reach. Re-verified: zero warning/slop findings remain.

## Open follow-up (not built)

Illustrations (the reference's hand-drawn character art) are out of scope for this session: no
image-generation tool or configured Stitch MCP is available here (checked directly, twice).
Documented in DESIGN.md's "Open follow-up" section rather than faked with SVG sketch art, which
craft-floor explicitly bans as reading amateur.

---

## v1 record (superseded, kept for history)



## Scope

Primary target: `public/index.html` (the whole SPA — врач dashboard, course/lesson viewer,
quiz, calendar, messages, certificate — plus curator/admin/super_admin dashboard, students,
team, audit-log views rendered by `public/app.js`). Visitor mode: **Operate** throughout
(no Persuade/Read/Experience surface in this product — врач is completing tasks, not being sold to).

Audience, job, constraints: see PRODUCT.md — practicing врач on desktop and mobile equally;
curator/admin/super_admin on primarily desktop but not exclusively. Preserve every role's
existing actions, data, and permission boundaries (who can revert, hide, block, certify)
literally; only the visual language changes.

## Direction contract

**THESIS:** The platform is a **ward census board**, not a SaaS card dashboard. Every person's
status is visible in one glance via color-coded status blocks and a hand-ruled grid — never
buried in a tinted badge on a white card. Refuses the category default this exact codebase
already ships: clean white cards, soft shadows, a single muted accent.

**OWN-WORLD:** Warm off-white "whiteboard" ground (not sterile white). Thick black hand-ruled
grid lines as the recurring divider motif. Status is carried exclusively by a solid-color
**magnet-dot token** (small rounded-square, never a border-left/border-right accent — that
exact pattern is craft-floor's flagged "side-tab" AI tell, deliberately avoided): grass green
(on track), marigold amber (attention/due soon), clay red (blocked/overdue), deep indigo
(completed/certified), and a pulsing hot-magenta "STAT" marker reserved only for "live right
now" (a stream in progress). One shape, used everywhere, functional not decorative.
Type: bold tracked-tight all-caps grotesque for status tags and section labels (the "marker"
voice); Source Serif 4 for lesson body copy (kept from the incumbent brand — reads as case-note
text); IBM Plex Sans for standard UI/forms/numbers (kept from the incumbent brand). Corners
crisp (4–6px), not soft-bubble; color lives in stripes and blocks, never whole-card tints.

**STORY:** Врач opens the platform and sees their own row on the board first — course progress
as a sequential status track, next lesson, next live stream, certificate state — nothing to dig
for. Curator/admin see the same board scaled to many rows: one врач per row, color instantly
flagging who needs attention. Audit log becomes "board history," each entry tagged with a small
magnet matching its action type. A live stream gets the magenta STAT flag wherever it appears
(dashboard, calendar) — unmistakable, felt as "happening now," carrying the "living cohort"
positioning.

**FIRST VIEWPORT** (врач dashboard, the surface a врач lands on after login):
Slim header (wordmark, name, theme toggle) → tracked all-caps index tabs with a thick
magenta underline on the active tab (shipped in place of the originally-sketched side rail —
a full sidebar restructure across both shells wasn't warranted by the core "board" identity,
which lives in the magnet/status-track language, not the nav chrome; documented here rather
than silently dropped) → full-width "Моя строка": the врач's own progress rendered as a
segmented horizontal status track (done=indigo, current=pulsing green with a ring, locked=pale
outline slot) with the primary "Продолжить" action sitting directly under the track, not in a
separate hero block → a 3-up board strip below (Ближайший эфир with STAT magnet if live,
Сертификат status, Куратор contact), each tile a different internal layout, never a repeated
icon+heading+text template.

**FORM:** Rounds Board / Ward Census — the user's own top-ranked candidate from a 7-direction
grounded list (Rounds Board, Live Conference Poster-Session, ECG Monitor Strip, Apothecary
Ledger, Anatomical Atlas Plate, Journal Typesetting, Surgical Instrument Tray), offered as the
IMPECCABLE'S PICK card alongside the dice-assigned direction (Surgical Instrument Tray, index 7)
after `concept-seed --scope direction --mode operate` ran degraded (seed key `bf029530`; network
to the roll service blocked by this sandbox's egress allowlist, confirmed by direct curl — no
challengers this run). The user locked the pick card over the assigned direction, which the
protocol treats as a valid, equal-salience choice.

**Signature interaction (code-led, no image generation available):** the "magnet snap" — on
mount, a status token (magnet dot, current status-track slot, certificate seal) plays a brief
scale/rotation settle built from keyframe steps, timed with `cubic-bezier(.16,1,.3,1)`
(exponential ease-out, not spring/elastic — the mechanical detector flagged an earlier
overshoot-bezier pass as a bounce-easing tell, and it was corrected project-wide), 380–500ms,
`transform`/`opacity` only, `prefers-reduced-motion` swaps instantly with no motion. One motion
language across the whole surface (per the emilkowalski-motion skill already installed in this
project).

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Unresolved decisions

- Whether the STAT magenta marker also drives a sound/toast for "stream starting" — out of scope
  for the visual redesign; note for a future product decision, not decided here.
- The originally-sketched side-rail navigation was not built (see FIRST VIEWPORT); revisit only
  if the user asks for it specifically, not as an unprompted follow-up.

## Build record

Exact hex values, full token set, and component-level rules are carbonized in `DESIGN.md` at
the project root (written at finish, from the built world, per this reference's own instruction
not to write DESIGN.md before the build). Verified with `.agents/skills/impeccable/scripts/impeccable
detect` (bounce-easing and a dead-code layout-width-transition finding fixed; the side-tab
border-right and repeating-gradient-stripes findings are kept as deliberate, motivated choices
documented in DESIGN.md's Do's and Don'ts). Verified visually across врач/curator/admin roles,
desktop (1440) and mobile (390) widths, and light/dark themes using a real seeded database
(Playwright + the pre-installed Chromium) — screenshots at
`/tmp/shots/before/` and `/tmp/shots/after/` for this session's reference.
