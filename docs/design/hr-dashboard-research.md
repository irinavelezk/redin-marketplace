# HR dashboard — design brief (synthesized)

**Date:** 2026-05-09 · **Scope:** `/hr/*` polish round, friction-driven.

The HR dashboard is a **triage worklist**, not a recruiting CRM. One person clears
a queue, makes binary calls, and moves on. Closer in spirit to Linear triage or
Intercom inbox than to Greenhouse. Optimize for **time-to-decision per
candidate**, **scannability**, and **zero ambiguity about what each click does**.

This brief synthesizes three parallel research passes (worklist density,
detail-on-the-side, single-document workflow) into the decisions we are
applying now and the decisions we are explicitly parking for v2.

---

## Worklist density (qualification queue)

**Industry pattern:** Dense rows with a fixed-position decision-driver beat
free-form cards for triage (Linear, Front, Stripe Radar, GitHub issue list).
Cards work when items are heterogeneous; rows win when all items carry the
same six-to-eight facts. Reviewers consistently choose compact density.

**Visual hierarchy:** A single strong signal per row. The recommendation badge
is the decision-driver here; everything else is supporting context. Avoid
row-background tinting (motion-sickness in scrolling lists, accessibility
contrast issues) — use a `border-l-4` accent in the same color family as the
badge instead.

**Color discipline:** Four to five semantic colors maximum. Reserve red for
hard blockers (gaps like "no certificación de alturas"); use neutral outlined
chips for everything else. Confidence renders as a small number plus a thin
3px bar — never as a row tint.

**Applied now:**

- Keep the card layout (the friction list explicitly requires per-card
  animation on approve, and the existing structure already groups the
  decision form on the right). Tighten internal spacing toward row-density.
- Add `border-l-4` recommendation accent: `border-l-emerald-500` (approve),
  `border-l-rose-500` (reject), `border-l-amber-500` (call), `border-l-violet-500`
  (needs_call state).
- Render confidence as `<span class="tabular-nums">0.92</span>` plus a 3px
  inline bar (no separate component — inline `<div>` with width style).
- Prominent live count badge in the header; decrements visibly on approve/reject.
- Specialty tags stay neutral; gap items keep the existing `list-disc` block.

**Parked for v2:**

- Switch from cards to dense rows wholesale (out of polish scope).
- J/K/A/R keyboard nav (zero existing client-component infrastructure for
  global keybindings; deserves its own design pass).
- Celebratory empty state — keep the existing one-liner.

---

## Detail-on-the-side (full dossier without leaving the queue)

**Industry pattern:** Side panel (Linear, Front) preserves queue position best
when reviewing 50+ items. Inline expand (Gmail) works only for small detail.
Modal blocks context; full-page navigation destroys queue position.

**Implementation:** Right-side `Sheet` at fixed 480px width. URL-driven
selection (`?peek=<id>`) survives revalidation, hard refresh, and the back
button. Single-expand discipline: peek answers ONE question; full record
remains at the existing detail route.

**Parked for v2 — explicitly out of scope for this PR.** None of the six
friction items requires it. Friction #2 (shortlist links to detail) is solved
by linking to the existing full-page route. A side panel would force adding
Radix Dialog (~12kb) and a new client-component pattern; that crosses the
"polish, not redesign" line. Revisit when the queue routinely runs >30 items
or when keyboard nav lands.

---

## Single-document workflow (contracts)

**Industry pattern:** When 95% of documents share a template, signer, and
channel, collapse the wizard to a one-click action (PandaDoc "Send from
template", Stripe Invoicing "Send"). DocuSign's full wizard exists only
because their median customer ships a different shape every time — that is
not Redin's reality.

**State machine:** Pilot scale (10s/month) needs only `borrador → enviado →
firmado` plus `cancelado` as an escape hatch. Skip `viewed` (WhatsApp doesn't
give us a reliable signal anyway), skip `expired` (paper signing has no
client-side timeout), skip signature staging (one delivery event is enough).
Existing schema already matches.

**File upload:** Native `<input type="file">` styled as a label-dropzone is
the industry default — building a separate drag-only zone doubles test
surface for marginal gain. For files >1MB on Next.js + Railway, the right
pattern is a Supabase signed upload URL; client uploads direct to bucket,
server records the path. This sidesteps both the 1MB server-action body
limit AND the Railway proxy layer.

**Confirmation:** Modals on every send fatigue users within a week (NN/g).
For pilot scale we accept the irreversibility — the action label says exactly
what happens, and the sent/firmado state on the contract page is the receipt.

**Applied now:**

- Replace 3 buttons (Descargar / Enviar / Marcar como enviado) with one
  **"Generar y enviar"** server action. Generates PDF, uploads to
  `contratos` bucket, enqueues WhatsApp document, flips state to `enviado` —
  one transaction, one click. Keep "Descargar borrador" as a small ghost link
  for HR's own preview only.
- Replace the text-input storage-path field with a **real `<input
  type="file">`** wrapped in a label styled as a button. Client uploads via
  `uploadToSignedUrl` against `contratos` bucket, server records the path
  and flips state to `firmado` — one click for HR after the file is picked.
- New **`/hr/contratos`** index: status chips (Todos / Borrador / Enviado /
  Firmado / Cancelado) with counts, fuzzy search by worker name + cédula,
  default sort by latest activity (`coalesce(signed_at, sent_at, created_at)`).

**Parked for v2:**

- 5-second toast + undo on send (requires an undo-window flag on
  outbound_messages and a drainer that respects it; deserves its own pass).
- `cancelar` action on contracts (state exists in schema; UI deferred).

---

## Friction map → applied changes

| # | Friction | Applied |
|---|---|---|
| 1 | UUIDs render as primary text | Pull `nombre` + OT description; UUIDs only in subtitles |
| 2 | Shortlist cards dead-end | Wrap worker name in `<Link>` to detail page |
| 3 | 5-button contract flow | Two actions: Generar y enviar + Subir firmado (file picker) |
| 4 | No contracts index | New `/hr/contratos` route with chips + search |
| 5 | "¿Por qué? (opcional)" label | "Notas de decisión (opcional)" with help text |
| 6 | Silent state changes | Card fades + count decrements via client wrapper |

## Hard exclusions for this PR

- No new heavyweight deps (no Radix, no Headless UI, no shadcn CLI install).
- No keyboard navigation system.
- No side-panel detail surface.
- No agentic UI on the HR side (locked decision per CLAUDE.md memory).
- No changes outside `dashboard/` and Supabase Storage.

Re-research only when one of these hard exclusions starts blocking the
metric (time-to-decision per candidate exceeds ~30s on real data).
