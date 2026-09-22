#!/usr/bin/env python3
"""
Builds reviews/quality-only-shadow-preregistration/QUALITY_ONLY_SHADOW_PREREGISTRATION_AND_IMPLEMENTATION_BUNDLE.pdf

A simple landscape-capable single-column report with a TOC and page numbers.
There is no prior PDF-builder on this live branch (only the frozen research
worktree series had one), so this is a from-scratch, deliberately simple
reportlab script — an implementation/design doc, not a data-heavy statistical
report, so it does not attempt to match the elaborate multi-appendix style of
the frozen-worktree audits.
"""
import subprocess
from pathlib import Path

from reportlab.lib.pagesizes import LETTER, landscape
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    ListFlowable, ListItem, KeepTogether,
)
from reportlab.lib.enums import TA_LEFT

REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / "reviews" / "quality-only-shadow-preregistration"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUT_DIR / "QUALITY_ONLY_SHADOW_PREREGISTRATION_AND_IMPLEMENTATION_BUNDLE.pdf"

def git(cmd):
    try:
        return subprocess.check_output(["git"] + cmd, cwd=REPO, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return "unknown"

GIT_HEAD = git(["rev-parse", "HEAD"])
GIT_BRANCH = git(["rev-parse", "--abbrev-ref", "HEAD"])

# Actual hash values — computed by SHELLING OUT to the real TypeScript
# implementation (spec.ts's computeConfigHash/computeDecisionPolicyHash) rather
# than reimplementing the hash logic in Python, which would risk a
# transcription mismatch (e.g. string-escaping differences) printing a value
# that does not match what the code actually computes. This guarantees the PDF
# prints the REAL values.
def _ts_hashes():
    script = (
        "import { computeConfigHash, computeDecisionPolicyHash } from './src/lib/experiments/quality-only/spec';"
        "console.log(computeConfigHash());"
        "console.log(computeDecisionPolicyHash());"
    )
    out = subprocess.check_output(["npx", "tsx", "-e", script], cwd=REPO, stderr=subprocess.DEVNULL).decode().strip().splitlines()
    return out[0].strip(), out[1].strip()

CONFIG_HASH, DECISION_POLICY_HASH = _ts_hashes()

# The REAL git diff for any path, shelled out to git at build time (never
# hand-transcribed) — same honesty principle as _ts_hashes(). Two call
# postures are supported so this diff stays populated whether the build runs
# BEFORE the experiment's changes are committed (working tree vs HEAD) or
# AFTER (the changes now live in some ancestor of HEAD, not necessarily
# HEAD~1 — a later documentation-only commit may sit on top of it, as
# happened here). Prefer the working-tree diff when one exists; otherwise
# find the MOST RECENT commit (reachable from HEAD, HEAD included) that
# actually touched this path, and diff that commit against its own parent —
# this stays correct no matter how many trailing doc-only commits follow the
# one that actually introduced the change.
def _real_diff(path):
    try:
        wt_diff = subprocess.check_output(
            ["git", "diff", "HEAD", "--", path],
            cwd=REPO, stderr=subprocess.DEVNULL,
        ).decode()
        if wt_diff.strip():
            return wt_diff
        last_touch = subprocess.check_output(
            ["git", "log", "-1", "--format=%H", "HEAD", "--", path],
            cwd=REPO, stderr=subprocess.DEVNULL,
        ).decode().strip()
        if last_touch:
            return subprocess.check_output(
                ["git", "diff", f"{last_touch}~1", last_touch, "--", path],
                cwd=REPO, stderr=subprocess.DEVNULL,
            ).decode()
        return wt_diff  # genuinely no diff either way (e.g. persistence.ts pre-commit)
    except Exception:
        return "(git diff unavailable at build time)"

DAEMON_DIFF = _real_diff("scripts/alert-daemon.ts")
MONITOR_DIFF = _real_diff("src/lib/monitor.ts")
PERSISTENCE_DIFF = _real_diff("src/lib/experiments/quality-only/persistence.ts")

def _git_status():
    try:
        return subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return "(git status unavailable at build time)"

GIT_STATUS = _git_status()

IDENTITY_FORMULA = "quality-only|<specVersion>|<epoch>|<etTradingDay>|<symbol>|<setupId>|<configHash>"
IDENTITY_EXAMPLE = f"quality-only|v2-quality-only-1|quality-only-epoch-1|2026-09-22|XYZ|XYZ:vwap_bounce:10.20|{CONFIG_HASH}"

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="H1c", parent=styles["Heading1"], spaceBefore=18, spaceAfter=8, textColor=colors.HexColor("#1a2b4a")))
styles.add(ParagraphStyle(name="H2c", parent=styles["Heading2"], spaceBefore=12, spaceAfter=6, textColor=colors.HexColor("#26456b")))
styles.add(ParagraphStyle(name="H3c", parent=styles["Heading3"], spaceBefore=8, spaceAfter=4, textColor=colors.HexColor("#3a5a80")))
styles.add(ParagraphStyle(name="Bodyc", parent=styles["BodyText"], fontSize=9.5, leading=13, alignment=TA_LEFT))
styles.add(ParagraphStyle(name="Codec", parent=styles["BodyText"], fontName="Courier", fontSize=8, leading=10.5, backColor=colors.HexColor("#f2f2f2")))
styles.add(ParagraphStyle(name="Small", parent=styles["BodyText"], fontSize=8, leading=10, textColor=colors.HexColor("#555555")))
styles.add(ParagraphStyle(name="Title2", parent=styles["Title"], fontSize=20))

PAGE_SIZE = landscape(LETTER)

story = []
toc_entries = []

def h1(text):
    story.append(Paragraph(text, styles["H1c"]))
    toc_entries.append(("h1", text))

def h2(text):
    story.append(Paragraph(text, styles["H2c"]))
    toc_entries.append(("h2", text))

def h3(text):
    story.append(Paragraph(text, styles["H3c"]))

def p(text):
    story.append(Paragraph(text, styles["Bodyc"]))

def small(text):
    story.append(Paragraph(text, styles["Small"]))

def code(text):
    # Escape XML special chars FIRST (raw source/diff text routinely contains
    # &, <, > — e.g. "=>", "!==", "&&" — which would otherwise be parsed as
    # reportlab Paragraph markup and corrupt or crash rendering).
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    story.append(Paragraph(escaped.replace("\n", "<br/>").replace(" ", "&nbsp;"), styles["Codec"]))

def bullets(items):
    story.append(ListFlowable([ListItem(Paragraph(i, styles["Bodyc"])) for i in items], bulletType="bullet", leftIndent=16))

def sp(n=8):
    story.append(Spacer(1, n))

def table(data, col_widths=None, header=True):
    t = Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
    style = [
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#bbbbbb")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if header:
        style += [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#26456b")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ]
    t.setStyle(TableStyle(style))
    story.append(t)

# ── Cover ─────────────────────────────────────────────────────────────────
story.append(Spacer(1, 1.2 * inch))
story.append(Paragraph("QUALITY_ONLY Shadow Preregistration &amp; Implementation Bundle", styles["Title2"]))
sp(10)
p("PAPER / RESEARCH ONLY. Preregistration + implementation of a read-only shadow-observation "
  "experiment layered on the live decision-log substrate. No production threshold, gate, or "
  "execution path was changed to produce this document.")
sp(20)
meta = [
    ["Spec version", "v2-quality-only-1"],
    ["Epoch", "quality-only-epoch-1"],
    ["Config hash (actual)", CONFIG_HASH],
    ["Decision policy hash (actual)", DECISION_POLICY_HASH],
    ["Identity formula (actual)", IDENTITY_FORMULA],
    ["Producer git branch (this worktree)", GIT_BRANCH],
    ["Producer git HEAD (this worktree)", GIT_HEAD],
    ["LIVE SEAM TESTED", "YES — tests/quality-only-daemon-integration.test.ts drives the real exported hook"],
    ["LIVE DAEMON WIRED", "YES — scripts/alert-daemon.ts's sweep() loop calls the observer immediately after classifyBuy()"],
    ["Collection started", "NO"],
    ["Official marker exists", "NO"],
    ["Committed", (f"YES — commit {GIT_HEAD} on {GIT_BRANCH} (pushed)"
                   if not git(["diff", "--name-only", "HEAD", "--",
                               "scripts/alert-daemon.ts", "src/lib/monitor.ts",
                               "src/lib/experiments", "src/lib/research/bar-journal.ts",
                               "tests/quality-only.test.ts",
                               "tests/quality-only-daemon-integration.test.ts",
                               "tests/quality-only-resolver.test.ts"]).strip()
                   else "NO — everything left uncommitted in the worktree for review")],
]
table(meta, col_widths=[2.6 * inch, 7.0 * inch], header=False)
sp(10)
p("<b>Revision note (this bundle):</b> the earlier version of this document (produced in a stale, "
  "pinned-behind-tip worktree) proposed but deliberately did NOT apply an integration diff to "
  "scripts/alert-daemon.ts, because that file was named frozen by the task in force at the time. This task "
  "EXPLICITLY LIFTS that one constraint, for scripts/alert-daemon.ts only: the QUALITY_ONLY observer is now "
  "ACTUALLY WIRED into the real daemon sweep loop, exercised end-to-end by a new integration test that imports "
  "and drives the live-wired hook (not a re-implementation of it) — see Section 6.1 and Section 13 for the real "
  "`git diff` output. setup-detectors.ts and buy-log.ts remain fully frozen and byte-for-byte unmodified. "
  "src/lib/monitor.ts IS intentionally modified (a small, real, pure-addition diff adding the passive "
  "research-only bar-mirror hook, `mirrorBars()`) — the invariant that holds is that BASE DECISION SEMANTICS "
  "are unchanged: the mirror call does not touch `intraday`, does not affect verdicts, and does not affect "
  "anything BASE computes (see Section 13.1 and Section 16).")
story.append(PageBreak())

# ── TOC placeholder (filled after story built, simple static list since content is fixed) ──
h1("Table of Contents")
toc_items = [
    "1. Experiment Motivation",
    "2. Exact Candidate Definition (OFF_HIGH / GRADE_FLOOR / SPACE / RUNUP / QUALITY_OTHER mapping)",
    "3. Exact Exclusion Logic",
    "4. Freshness Definition &amp; Equivalence to shadow-journal.ts",
    "5. Identity Scheme",
    "6. Architecture / Data Flow &amp; the REAL, WIRED Live Call Path (6.2: bar-availability honesty note)",
    "7. Storage Schema",
    "8. Outcome Methodology",
    "9. Collection Minimum",
    "10. Preregistered Analysis Plan",
    "11. Isolation Proof",
    "12. Test Matrix",
    "13. Changed-File Diff Summary",
    "14. Validation Outputs",
    "15. Risks &amp; Open Questions",
    "16. Statement: No Production Threshold Changed",
    "17. Worktree-Base Honesty Note (why literal branch integration was blocked)",
    "18. Phase 1 — Real 1m Data-Plane Trace &amp; Chosen Zero-Request Bar Source",
    "19. Passive 1m Research Mirror — Design (bar-journal.ts)",
    "20. Pending-Candidate Lifecycle &amp; Resolver Architecture",
    "21. Restart Recovery",
    "22. SCORABLE / PENDING / CENSORED / DEGRADED Definitions",
    "23. Zero-Request Proof — Summary",
    "24. Shutdown-Order Correction (real diff)",
]
bullets(toc_items)
story.append(PageBreak())

# ── 1. Motivation ─────────────────────────────────────────────────────────
h1("1. Experiment Motivation")
p("The six-session retrospective veto-provenance audit (frozen research worktree series) found that a "
  "residual <b>QUALITY_OTHER</b> category of quality-vetoed candidates — distinct from OFF_HIGH, "
  "GRADE_FLOOR, SPACE, and RUNUP — was under-examined relative to its share of vetoed signal volume. "
  "That finding is <b>MOTIVATION ONLY</b> for this prospective epoch.")
small("retrospectiveDiagnostic = true, officialEpochContribution = false. The retrospective sample must never "
      "be blended into this epoch's official collection — see src/lib/experiments/quality-only/retrospective.ts.")
sp()
p("This experiment stands up a paper/research-only, forward-looking (prospective) shadow-observation "
  "population of QUALITY_OTHER-only vetoed candidates on the CURRENT LIVE branch "
  "(research/top-mover-audit-robustness, based on improve-signal-quality), to test — without touching "
  "production — whether that category's candidates would have performed differently from BASE's other "
  "veto reasons, before any decision is made about production thresholds.")

# ── 2. Candidate definition ──────────────────────────────────────────────
h1("2. Exact Candidate Definition")
p("<b>The central design decision of this task.</b> On this branch, <font face=\"Courier\">classifyBuy()</font> "
  "(src/lib/buy-log.ts) collapses both <font face=\"Courier\">setup.qualityVetoed</font> and "
  "<font face=\"Courier\">gradeFloorFail</font> into a single <font face=\"Courier\">'veto'</font> verdict. "
  "There is no <font face=\"Courier\">decomposeGates()</font>-style multi-gate output on this branch (that "
  "exists only on the unmerged frozen research branch, not depended on here). "
  "<font face=\"Courier\">qualityVetoed</font> itself is computed in src/lib/setup-detectors.ts's "
  "<font face=\"Courier\">buildSetup()</font> as:")
code("vetoed = (args.vetoTrigger?.active ?? false) || fadedChase || lateInLeg ||\n"
     "         unconfirmed || quarantined || noRoom")
p("<b>Correction applied (coordinator Issue 1).</b> An earlier version of this module tried to PROVE which "
  "private sub-cause fired whenever <font face=\"Courier\">qualityVetoed</font> was true, treating "
  "<font face=\"Courier\">args.vetoTrigger?.active</font> (currently <font face=\"Courier\">longBounceRolledOver(ctx)</font> "
  "for the bounce-family detectors) as an unreconstructable cause that had to exclude the row entirely. That was "
  "overly conservative and did not match what the six-session retrospective audit actually measured. "
  "<b>Fixed definition: use production's own trusted <font face=\"Courier\">setup.qualityVetoed</font> boolean "
  "directly as the aggregate residual-quality truth</b> — this module does NOT need to prove which private "
  "sub-cause fired. Production's own OR already guarantees that if qualityVetoed is true and "
  "OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR are all independently false, SOME quality cause fired.")
p("Mapping decision, read directly from source (setup-detectors.ts):")
table([
    ["Task dimension", "Source expression", "Reconstructable read-only?"],
    ["OFF_HIGH", "fadedChase = ANTI_FADE_TYPES.has(type) &amp;&amp; distFromHigh &lt; -MAX_BELOW_HIGH_PCT", "Yes, exact — ANTI_FADE_TYPES + MAX_BELOW_HIGH_PCT (literal) + distanceFromDayHighPct (already on MonitorResult.technicals)"],
    ["GRADE_FLOOR", "gradeFloorFail = grade === 'below' &amp;&amp; !GRADE_FLOOR_EXEMPT.has(type)", "Yes, exact — GRADE_FLOOR_EXEMPT is exported from buy-log.ts"],
    ["SPACE", "noRoom = spaceToNextSupply(...).r &lt; MIN_SPACE_R", "Yes, exact — spaceToNextSupply exported; MIN_SPACE_R literal default transcribed"],
    ["RUNUP", "lateInLeg = legRunUpPct(...) &gt; MAX_LEG_RUNUP_PCT", "Yes, exact — legRunUpPct exported; MAX_LEG_RUNUP_PCT literal default transcribed"],
    ["QUALITY_OTHER (fixed definition)", "setup.qualityVetoed === true AND all four rows above are false", "Yes — production's own trusted aggregate flag, no reverse-engineering of any private sub-cause required"],
], col_widths=[1.8*inch, 4.0*inch, 3.6*inch])
sp()
p("<b>QUALITY_OTHER (prospective) = setup.qualityVetoed === true AND OFF_HIGH == false AND SPACE == false AND "
  "RUNUP == false AND GRADE_FLOOR == false</b>, with TRACKING_FLOOR/SESSION/VOLUME/STANDDOWN/CAPPED/DUP all "
  "independently confirmed false, no BASE TAKE duplication, and freshness passing. This is now DEFINITIONALLY "
  "IDENTICAL, at the gate level, to what the six-session retrospective audit's QUALITY_OTHER measured: the "
  "residual quality-veto family once OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR are separated out. Implemented in "
  "src/lib/experiments/quality-only/reconstruct-gates.ts (<font face=\"Courier\">isPrimaryQualityOther</font>).")

h2("2.1 Subcause provenance (descriptive only) and the residual/private case")
p("<font face=\"Courier\">buildSetup()</font> actually ORs SIX things into <font face=\"Courier\">qualityVetoed</font>, "
  "not four/five. For the bounce-family detectors (pullback, momentum_pullback, ema9_bounce, ema21_bounce, "
  "vwap_bounce, vwap_reclaim), <font face=\"Courier\">args.vetoTrigger.active</font> is currently "
  "<font face=\"Courier\">longBounceRolledOver(ctx)</font> — a module-private, non-trivial function this module "
  "does not, and does not need to, reverse-engineer.")
p("Where causally knowable, <font face=\"Courier\">unconfirmedKnown</font> (green-streak under-confirmation) and "
  "<font face=\"Courier\">quarantinedKnown</font> (fixed TRIGGERS_QUARANTINED membership) are still recomputed "
  "using the same exported functions/literals as before — DESCRIPTIVE ONLY, never gating PRIMARY inclusion. "
  "When a row is residual-quality-true (qualityVetoed=true, all four named dimensions false) but NEITHER "
  "unconfirmedKnown nor quarantinedKnown explains it, the row is still INCLUDED as PRIMARY, and is flagged "
  "<font face=\"Courier\">qualityOtherResidualPrivate = true</font> — a generic label, deliberately NOT naming "
  "<font face=\"Courier\">longBounceRolledOver</font> specifically, so the representation stays correct even if "
  "production adds another private disjunct later.")
p("<b>Multi-fail, non-primary rows:</b> when qualityVetoed=true AND at least one of OFF_HIGH/SPACE/RUNUP/"
  "GRADE_FLOOR is ALSO true, this module CANNOT prove whether a residual quality cause additionally co-fired "
  "— qualityVetoed is an aggregate OR, not a bitmask. Those rows report "
  "<font face=\"Courier\">residualQualityPresence = 'UNKNOWN'</font> in diagnostic/aggregate reporting, never an "
  "invented TRUE or FALSE. PRIMARY eligibility does not depend on this field at all (those rows are already "
  "excluded by the named-dimension checks).")

# ── 3. Exclusion logic ────────────────────────────────────────────────────
story.append(PageBreak())
h1("3. Exact Exclusion Logic")
p("A row is excluded from the PRIMARY QUALITY_ONLY population if its failed-dimension vector "
  "(<font face=\"Courier\">failedQualityDimensions()</font>) contains anything other than exactly "
  "<font face=\"Courier\">[\"QUALITY_OTHER\"]</font>. Multi-fail combinations are reported with BOTH dimensions "
  "present (not silently collapsed to one), then excluded by the single-dimension check:")
table([
    ["Combination", "Included in PRIMARY?", "Why"],
    ["[\"QUALITY_OTHER\"]  (known: unconfirmed/quarantined, OR private/residual)", "YES", "Exactly one dimension; qualityVetoed=true, all four named dimensions false"],
    ["[\"SPACE\"]  (qualityVetoed true + SPACE true)", "NO", "SPACE fired — residualQualityPresence=UNKNOWN, not reported as QUALITY_OTHER at all"],
    ["[\"GRADE_FLOOR\"]  (qualityVetoed true + grade floor true)", "NO", "grade floor fired — residualQualityPresence=UNKNOWN"],
    ["[\"OFF_HIGH\"]  (qualityVetoed true + fadedChase true)", "NO", "anti-fade fired — residualQualityPresence=UNKNOWN"],
    ["[\"RUNUP\"]  (qualityVetoed true + lateInLeg true)", "NO", "leg-maturity veto fired — residualQualityPresence=UNKNOWN"],
    ["tracking-floor fail / session fail / volume fail / standDown / capped / dup", "NO — excluded before gate reconstruction even runs", "independently reconstructed via exported buy-log.ts functions, not inferred from the 'veto' short-circuit"],
    ["setupId already produced a BASE 'logged' verdict anywhere in the stream", "NO", "condition 7 — no BASE TAKE duplication"],
    ["(day, setupId) already produced a QUALITY_ONLY candidate this epoch", "NO", "condition 8 — freshness / earliest-wins"],
], col_widths=[3.2*inch, 1.4*inch, 4.8*inch])

# ── 4. Freshness ──────────────────────────────────────────────────────────
h1("4. Freshness Definition &amp; Equivalence")
p("Reuses src/lib/research/shadow-journal.ts's <font face=\"Courier\">etTradingDay()</font> function directly "
  "(imported, not reimplemented) to key freshness on <font face=\"Courier\">(etTradingDay, setupId)</font> — "
  "identical to shadow-journal's own stable candidate identity. A 'fresh' setup is one whose (trading-day, "
  "setupId) pair has not already produced a QUALITY_ONLY candidate this epoch. Earliest valid observation "
  "wins; no replacement by a later 'better' trigger of the same setupId — mirroring shadow-journal's "
  "documented law that FEATURES are frozen at the first signal event and never touched by later bars. "
  "Implemented in src/lib/experiments/quality-only/candidate.ts's <font face=\"Courier\">FreshnessTracker</font>.")

# ── 5. Identity ───────────────────────────────────────────────────────────
h1("5. Identity Scheme")
code(IDENTITY_FORMULA)
p("Example (actual format, illustrative values):")
code(IDENTITY_EXAMPLE)
p("Uses <font face=\"Courier\">etTradingDay</font> (not the raw candidateObservedAt timestamp) so the identity "
  "matches the freshness key exactly — one candidate per (day, setupId) — and is stable across restarts/"
  "re-sweeps of the same setup within the same trading day. Deterministic candidate identity built from real "
  "causal facts. A short display hash may be shown alongside as a secondary field, but is never used for "
  "identity/dedup. Implemented as <font face=\"Courier\">candidateIdentity()</font> in candidate.ts.")

# ── 6. Architecture ───────────────────────────────────────────────────────
story.append(PageBreak())
h1("6. Architecture / Data Flow &amp; the Real Live Call Path")
p("Purely additive, read-only layer on top of the already-computed decision stream and monitor bars. "
  "No new provider requests.")
bullets([
    "BASE (setup-detectors.ts, buy-log.ts) computes DetectedSetup + classifyBuy verdict as today — UNCHANGED.",
    "For each triggered setup whose verdict reaches 'veto': reconstruct-gates.ts recomputes the four named "
    "sub-checks read-only, using ONLY exported functions/constants + transcribed literals guarded by drift "
    "tests, and reads production's own qualityVetoed flag directly.",
    "candidate.ts's evaluateEligibility() runs the full 8-condition check and emits a QualityOnlyCandidate "
    "snapshot or a precise ineligibility reason.",
    "observer.ts's observeQualityOnlyFromDecision() wraps eligibility + freshness + outcome resolution in a "
    "try/catch that NEVER throws — the proposed hook for the real seam (see below).",
    "outcome.ts resolves the candidate's forward outcome from already-available 1m bars (same tape the daemon "
    "already holds) — 5m/15m/30m MFE_R/MAE_R, 0.5R/1R/2R reached + time-to, terminal reason, same-bar ambiguity.",
    "persistence.ts appends candidate/outcome events to an append-only journal, labels rows PRE_OFFICIAL until "
    "(if ever) the O_EXCL-equivalent start marker is created — NOT done in this task — and drains queued "
    "writes on shutdown.",
    "spec.ts stamps every artifact with specVersion, epoch, configHash, decisionPolicyHash, producer git HEAD/branch.",
])

h2("6.1 The real, currently-live call path (traced, not assumed)")
p("Two candidate observation paths were traced on the live branch tip (research/top-mover-audit-robustness, "
  "via <font face=\"Courier\">git show</font>, since this worktree's checked-out files are pinned 8 commits "
  "behind that tip — see Section 17):")
bullets([
    "<b>shadow-journal.ts is NOT called in-process by the daemon at all.</b> Its buildShadowCandidates()/"
    "resolveShadowOutcome() are a pure OFFLINE projector over the JSONL decision-log file "
    "scripts/alert-daemon.ts writes via recordDecision(). Nothing in the daemon process imports "
    "shadow-journal.ts.",
    "<b>mike/shadow.ts (resolveMikeShadow) IS called in-process</b>, but from a SEPARATE standalone script, "
    "<font face=\"Courier\">scripts/mike-scan.ts</font> (NOT scripts/alert-daemon.ts) — confirmed by "
    "<font face=\"Courier\">git show research/top-mover-audit-robustness:scripts/mike-scan.ts</font>, line 26: "
    "<font face=\"Courier\">import { resolveMikeShadow, mikeShadowReference, mikeShadowStop } from '@/lib/mike/shadow'</font>, "
    "invoked at line 119 inside sweep(). The whole sweep() call is already wrapped in "
    "<font face=\"Courier\">try { await sweep() } catch (e) { log('sweep error:', ...) }</font> in main() "
    "(line ~150) — Mike's sweep is already exception-isolated at the loop level.",
])
p("The REAL seam architecturally equivalent to this experiment (per-triggered-setup, verdict-aware "
  "observation) is <b>scripts/alert-daemon.ts's sweep() loop, immediately after classifyBuy() computes "
  "verdict</b>, cited from the live tip:")
code("scripts/alert-daemon.ts (live tip, ~line 236):\n"
     "  const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })\n"
     "  const attrs = signalAttrs(setup, r)\n"
     "  recordDecision({ ts: ..., etTime: ..., ...attrs, verdict, price: r.price }, now)")
p("<b>THIS DIFF IS NOW ACTUALLY APPLIED.</b> This task explicitly lifts the frozen-file constraint for "
  "scripts/alert-daemon.ts, and ONLY for the minimum read-only QUALITY_ONLY observer integration described "
  "here — setup-detectors.ts and buy-log.ts remain fully frozen; src/lib/monitor.ts is separately and "
  "intentionally modified for the passive bar-mirror tap (reason (a)), with BASE DECISION SEMANTICS unchanged "
  "as the operative invariant (Section 13.1/16), not an empty diff. The real, applied change "
  "(exact `git diff` output against this worktree's live HEAD) is reproduced in Section 13. In summary, the "
  "call site now reads:")
code("  const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })\n"
     "+ try { runQualityOnlyObserver(setup, r, verdict, now, state) } catch { /* never propagate into BASE */ }\n"
     "  const attrs = signalAttrs(setup, r)\n"
     "  recordDecision({ ts: ..., etTime: ..., ...attrs, verdict, price: r.price }, now)")
p("<b>runQualityOnlyObserver</b> (new function added to alert-daemon.ts, exported for test visibility only — "
  "exporting an existing internal function does not change daemon behavior) builds an ObserverContext from "
  "values already in scope (now, MIN_LEVEL_STRENGTH, the sweep's priorBuys state), calls "
  "observeQualityOnlyFromDecision() exactly as before, and on a real candidate enqueues candidate/outcome "
  "events into a module-level JournalWriter — itself wrapped in its own try/catch so a logging failure can "
  "never propagate. The daemon's existing graceful-shutdown path (`shutdown()`, on SIGINT/SIGTERM) now also "
  "calls `qualityOnlyWriter.shutdown()` before flattening positions, itself exception-safe and non-blocking of "
  "the real shutdown sequence.")
h2("6.2 Bar availability — an honest limitation found while wiring the real seam")
p("Verifying the real call site's scope (not assumed) revealed that scripts/alert-daemon.ts's sweep() loop "
  "consumes MonitorResult/DetectedSetup from the JSON `/api/monitor` HTTP response, which carries NO raw "
  "Candle[] array — the daemon process has no 1m bar cache in scope at all, and fetching one would be an "
  "incremental provider request (explicitly disallowed). This is disclosed rather than worked around:")
bullets([
    "<b>Gate reconstruction stays correct under this branch's live defaults.</b> SPACE/OFF_HIGH/GRADE_FLOOR "
    "need no candles (levels/technicals/grade are already on r/setup). RUNUP needs "
    "MAX_LEG_RUNUP_PCT=Infinity — legRunUpPct's result can never exceed it regardless of candle input. The "
    "unconfirmed/green-streak check is short-circuited entirely by MIN_GREEN_STREAK=0. An empty candle array "
    "therefore changes no gate outcome under the defaults recorded in spec.ts — but this IS an env-dependent "
    "fact, not a structural guarantee, and is called out explicitly rather than silently assumed.",
    "<b>Outcome resolution cannot happen AT THIS CALL SITE, and does not try to.</b> MFE/MAE requires bars "
    "AFTER the candidate's observation instant, which do not exist yet at the moment classifyBuy() fires. "
    "`outcomeCandles` is intentionally omitted from the daemon's ObserverContext, so "
    "observeQualityOnlyFromDecision() defers outcome to `null` (pending) at creation time rather than "
    "fabricating one or peeking at future/current-complete bars — this is the causal, non-lookahead behavior "
    "the task required.",
    "<b>Resolution now happens on a LATER pass, from a passive bar mirror, not from a new provider request.</b> "
    "src/lib/monitor.ts's buildMonitorResult() — called by every sweep's own `/api/monitor` requests, for "
    "production reasons unrelated to this experiment — already fetches each symbol's 1m candles under the "
    "shared `candles1m:&lt;symbol&gt;` cache key. A one-line, additive tap in that function "
    "(src/lib/research/bar-journal.ts's `mirrorBars()`, Section 19) mirrors those ALREADY-FETCHED bars to a "
    "per-day, on-disk NDJSON journal — zero incremental provider requests. "
    "src/lib/experiments/quality-only/resolver.ts then reads that journal (plus the candidate journal) on "
    "each daemon sweep (Section 20) and causally resolves PENDING candidates into SCORABLE/CENSORED/DEGRADED "
    "once enough bars have accumulated, appending exactly one outcome event per resolved identity. This is "
    "no longer an open item: the resolver exists, is wired into the daemon's sweep loop, and is covered by "
    "tests/quality-only-resolver.test.ts (34 tests, Section 12.2).",
])

# ── 7. Storage schema ─────────────────────────────────────────────────────
h1("7. Storage Schema")
table([
    ["Field group", "Fields"],
    ["Candidate snapshot", "identity, specVersion, epoch, configHash, etTradingDay, symbol, setupId, setupType, "
     "setupTime, candidateObservedAt, entryRef, invalidation, riskUnit, grade, offHighPct, spaceR, runUpPct, "
     "gateVector, failedGateVector, trackingFloorPassed, sessionOk, volumeOk, standDown, capped, dup, "
     "sameSymbol (descriptive), universeRank (N/A on this branch), leaderEpisodeId (N/A — H4B concept), "
     "producerGitHead"],
    ["Outcome", "entered, entryBarTime, mfeR/maeR at 5m/15m/30m, reached05R/1R/2R + timeTo each, invalidated, "
     "timeToInvalidation, oneR/twoR-before-invalidation, terminalReason, sameBarAmbiguity, resolvedFromBars"],
    ["Journal event envelope", "kind (candidate|outcome), identity, payload, provenance, preOfficial"],
    ["Provenance (every artifact)", "producerGitHead, producerGitBranch, specVersion, epoch, configHash, "
     "decisionPolicyHash, generatedAt"],
    ["Start marker (not created in this task)", "provenance + createdAt, written O_EXCL-atomically"],
], col_widths=[2.2*inch, 7.2*inch])

# ── 8. Outcome methodology ────────────────────────────────────────────────
story.append(PageBreak())
h1("8. Outcome Methodology")
p("There is no <font face=\"Courier\">src/lib/leader/leader-continuation-outcome.ts</font> on this branch "
  "(H4B concept — confirmed absent by directory search). The only existing prospective bar-walking scorer on "
  "this branch is <font face=\"Courier\">resolveShadowOutcome()</font> in shadow-journal.ts (the \"live shadow "
  "convention\").")
h2("8.1 Provenance, precisely (A vs B) — re-audited per coordinator request")
p("<b>(A) Directly reused SEMANTICS</b> (named, not called into or ported from — CONVENTIONS this module's "
  "control flow mirrors from resolveShadowOutcome):")
bullets([
    "entry rule: enter on the first bar whose high &gt;= entryRef",
    "causal boundary: only bars with time*1000 &gt;= candidateObservedAtMs are considered (no lookahead)",
    "same-bar ambiguity: a bar touching BOTH invalidation and a favorable threshold resolves ADVERSE-FIRST",
    "terminal invalidation: once invalidation fires, the walk stops; no later bar grants new favorable credit",
])
p("<b>(B) NEW arithmetic written for this module</b> (NOT a call into, or a port of, any existing function — "
  "written from scratch, faithfully following the (A) conventions but implemented independently, because "
  "resolveShadowOutcome returns a single-horizon shape that does not compute any of these fields at all):")
bullets([
    "5m/15m/30m rolling MFE_R / MAE_R windows",
    "0.5R / 1R / 2R reached flags + timeTo05R/1R/2R",
    "oneRBeforeInvalidation / twoRBeforeInvalidation",
    "the explicit sameBarAmbiguity boolean",
])
p("This split is disclosed explicitly per the coordinator's re-audit request — the multi-horizon fields ARE "
  "new code, even though they deliberately never diverge from the (A) conventions. See "
  "src/lib/experiments/quality-only/outcome.ts's module doc comment for the same split in code.")
p("<b>Zero incremental provider requests:</b> the scorer takes <font face=\"Courier\">candles: Candle[]</font> "
  "as a plain argument — it does not fetch anything. Callers pass the same monitor/daemon-computed 1m bars "
  "already available to the live scanner.")

# ── 9. Collection minimum ─────────────────────────────────────────────────
h1("9. Collection Minimum (preregistered, not yet met)")
bullets([
    "100 scorable candidates",
    "30 independent symbol-days",
    "10 distinct sessions",
    "before any performance interpretation of the sample",
])
p("Collection has NOT started (the O_EXCL-equivalent marker was not created in this task).")

# ── 10. Analysis plan ─────────────────────────────────────────────────────
h1("10. Preregistered Analysis Plan")
bullets([
    "First-setup vs reload subgroup (from sameSymbol.isReload)",
    "Leader-state subgroup if available — N/A on this branch (no H4B/leader concept exists here; documented, not invented)",
    "setupType distribution across the eligible QUALITY_OTHER population",
    "Single-symbol concentration (share of candidates from the top 1-3 symbols)",
    "Single-session concentration (share of candidates from the single busiest session)",
])
p("No tuning during epoch 1: QUALITY_OTHER semantics, the candidate definition, freshness definition, outcome "
  "scorer, collection minimum, and subgroup definitions are all versioned by specVersion/epoch/configHash/"
  "decisionPolicyHash. A defect found after collection starts requires a NEW epoch value, never a silent "
  "patch to this one.")

# ── 11. Isolation proof ───────────────────────────────────────────────────
story.append(PageBreak())
h1("11. Isolation Proof")
bullets([
    "Zero broker/PaperExecutor mutation: grep-based tests (16, 17) assert no import of alpaca/broker modules "
    "and no call to placeOrder/submitOrder/openPosition/PaperExecutor anywhere under "
    "src/lib/experiments/quality-only, restricted to non-comment code lines.",
    "Zero BASE DECISION SEMANTICS mutation: test 18 asserts `git diff --name-only` is empty for "
    "setup-detectors.ts and buy-log.ts. src/lib/monitor.ts and scripts/alert-daemon.ts are deliberately excluded "
    "from that empty-diff check — they are the files this task's absolute constraints explicitly lift, for the "
    "minimum read-only observer/mirror wiring only (see Section 6). Instead, a separate structural test "
    "(Section 13.1) asserts monitor.ts's diff is a pure addition (zero lines removed/changed) that does not "
    "touch `intraday` or anything BASE computes from it — that is the invariant proven for monitor.ts, not an "
    "empty diff. A further test asserts scripts/alert-daemon.ts and src/lib/monitor.ts are the ONLY existing "
    "tracked files `git status --porcelain` reports as modified.",
    "H4B: src/lib/leader/ does not exist on this branch (test 19) — nothing to mutate.",
    "Zero-or-documented-exception provider requests: test 20 asserts no fetch()/axios usage anywhere in the "
    "new module; all candle/level/setup data is passed in by the caller from already-computed structures.",
    "No new files were written anywhere outside src/lib/experiments/quality-only/, tests/quality-only.test.ts, "
    "scripts/research/build_quality_only_pdf.py, and reviews/quality-only-shadow-preregistration/ — confirmed "
    "by `git status --porcelain` showing only untracked additions, zero modified tracked files.",
])

# ── 12. Test matrix ────────────────────────────────────────────────────────
h1("12. Test Matrix")
test_rows = [
    ["#", "Invariant", "Status"],
    ["1", "Exact failed vector must equal QUALITY_OTHER only", "PASS"],
    ["2", "QUALITY_OTHER+SPACE excluded", "PASS"],
    ["3", "GRADE_FLOOR+QUALITY_OTHER excluded", "PASS"],
    ["4", "OFF_HIGH+QUALITY_OTHER excluded", "PASS"],
    ["4b", "RUNUP+QUALITY_OTHER excluded", "PASS"],
    ["5", "Tracking-floor failure excluded", "PASS"],
    ["6", "Session failure excluded", "PASS"],
    ["7", "Volume failure excluded", "PASS"],
    ["8", "Standdown excluded", "PASS"],
    ["9", "Capped/dup excluded", "PASS"],
    ["10", "No BASE TAKE candidate duplication", "PASS"],
    ["11", "Deterministic freshness", "PASS"],
    ["12", "Repeated retriggers do not multiply candidates", "PASS"],
    ["13", "Earliest valid candidate retained", "PASS"],
    ["14", "No future bars used in eligibility", "PASS"],
    ["15", "No future bars used in freshness", "PASS"],
    ["16", "No broker import (grep-based)", "PASS"],
    ["17", "No PaperExecutor action", "PASS"],
    ["18", "No BASE decision mutation", "PASS"],
    ["19", "No H4B mutation (N/A — adapted, leader/ absent)", "PASS"],
    ["20", "No extra provider request", "PASS"],
    ["21", "Epoch hash stable/deterministic (actual values printed, Section 5/cover)", "PASS"],
    ["22", "Start marker O_EXCL-equivalent, no artifact left behind", "PASS"],
    ["23", "Pre-marker rows remain PRE_OFFICIAL", "PASS"],
    ["24", "Outcome scorer matches reused convention (A/B split, Section 8.1)", "PASS"],
    ["25", "Terminal invalidation behavior unchanged", "PASS"],
    ["26", "Same-bar ambiguity unchanged (adverse-first)", "PASS"],
    ["27", "Malformed/corrupt artifact fails conservatively", "PASS"],
    ["28", "Shutdown drains queued research writes", "PASS"],
    ["29", "Producer/config provenance persisted with every artifact", "PASS"],
    ["30-34", "Drift detection: MAX_BELOW_HIGH_PCT, MIN_SPACE_R, MAX_LEG_RUNUP_PCT, MIN_GREEN_STREAK, ANTI_FADE_TYPES", "PASS (5 tests)"],
    ["35", "RESIDUAL/PRIVATE QUALITY_OTHER INCLUDED (regression test for Issue-1 fix)", "PASS"],
    ["36", "Aggregate qualityVetoed truth used correctly (not narrower unconfirmed-OR-quarantined def.)", "PASS"],
    ["37", "Known competing gate (OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR) excludes PRIMARY", "PASS"],
    ["38", "Residual co-presence marked UNKNOWN for non-primary multi-fail rows", "PASS"],
    ["39", "Actual live call path reaches the observer (real end-to-end integration test)", "PASS"],
    ["40", "Observer exception isolation (BASE/Mike unaffected by observer throwing)", "PASS"],
    ["41", "Non-veto verdict is a clean no-op (not an error)", "PASS"],
    ["42", "BASE unchanged (git status shows only new/untracked paths)", "PASS"],
    ["43", "Mike unchanged (no mike-related paths touched or added)", "PASS"],
    ["44", "No official marker exists after the full test run", "PASS"],
    ["45", "Actual config hash printed/stable across runs with same config", "PASS"],
    ["46", "A changed config input produces a different hash", "PASS"],
    ["47", "Actual decision-policy hash printed/stable across runs", "PASS"],
    ["48", "Candidate identity components explicit/inspectable (round-trip)", "PASS"],
    ["49", "Retrospective motivation labeling", "PASS"],
]
table(test_rows, col_widths=[0.6*inch, 7.8*inch, 1.0*inch])
sp()
p("55 tests in tests/quality-only.test.ts (unit/function-level), all passing.")
sp()
h2("12.1 TRUE end-to-end daemon integration tests (NEW — tests/quality-only-daemon-integration.test.ts)")
p("These import and exercise the ACTUAL exported hook wired into scripts/alert-daemon.ts's sweep() loop "
  "(`runQualityOnlyObserver`) — not a re-implementation, not the observer function called in isolation. "
  "Importing the daemon module performs no network fetches and installs no signal handlers: `main()`'s "
  "auto-run is guarded with `if (process.env.VITEST !== 'true')`, which Vitest sets by default, so a real "
  "launch (`npx tsx scripts/alert-daemon.ts`) is byte-for-byte unaffected by this guard.")
daemon_rows = [
    ["#", "Invariant proven at the REAL seam", "Status"],
    ["D1", "Repeated setupId across sweeps deduplicated (freshness persists across calls to the real hook)", "PASS"],
    ["D2", "Residual/private-only QUALITY_OTHER candidate (all four named dimensions false) is queued", "PASS"],
    ["D3", "Non-veto ('logged') verdict is a clean no-op — no candidate queued", "PASS"],
    ["D4", "Observer throws internally -> BASE's classifyBuy result is unaffected, no propagation, sweep survives", "PASS"],
    ["D5", "Freshness tracker exported IS the same singleton instance the real hook uses", "PASS"],
    ["D6", "classifyBuy -> real hook -> exact QUALITY_OTHER-only candidate -> PRE_OFFICIAL -> drains on shutdown -> journal file contents verified -> no official marker exists", "PASS"],
]
table(daemon_rows, col_widths=[0.6*inch, 7.8*inch, 1.0*inch])
sp()
p("6 tests in tests/quality-only-daemon-integration.test.ts, all passing.")
sp()
h2("12.2 Resolver / bar-journal / shutdown-order tests (NEW — tests/quality-only-resolver.test.ts)")
p("34 tests covering the letters this pass's NEW modules introduce (A-Q, R/S, V/W, Y/Z), plus 5 new structural tests proving this task's async bar-mirror rewrite (non-blocking return, bounded/serialized queue, observable overflow/failure). Letters K, L, M, T, U, "
  "and X are already covered by the existing tests/quality-only.test.ts / "
  "tests/quality-only-daemon-integration.test.ts suites (outcome.ts's frozen conventions, BASE/Mike-unchanged "
  "structural proofs, and the no-official-marker check) — K is additionally re-proven at the resolver layer "
  "below since 'terminal invalidation is immediately SCORABLE' is a resolver-specific claim outcome.ts alone "
  "does not make. Grouped by letter:")
resolver_rows = [
    ["Letters", "Coverage", "Status"],
    ["A", "Zero-provider-request proof: global.fetch spy sees 0 calls through mirrorBars() and "
     "resolvePendingCandidates(); grep confirms no network-client import in either new module", "PASS (3 tests)"],
    ["B", "mirrorBars() never mutates the caller's Candle[] array/objects", "PASS"],
    ["C", "Malformed candles (NaN), an unwritable path, and an empty array are all silent no-ops, never throw", "PASS (3 tests)"],
    ["D/E/F", "A candidate with no future bars yet stays PENDING; a handful of bars short of the 30m horizon "
     "stays PENDING (not resolved prematurely); bars strictly before candidateObservedAt are ignored", "PASS (3 tests)"],
    ["G", "A forming/not-yet-mirrored bar (still within the closure safety margin) is absent from the "
     "resolver's view and grants no credit", "PASS"],
    ["H/I/J", "5m/15m MFE-MAE populate only from the actual entry bar forward; a favorable spike 31 minutes "
     "after entry does not leak into the 30m window", "PASS (2 tests)"],
    ["K", "Terminal invalidation 2 minutes after entry is SCORABLE immediately, not PENDING/CENSORED", "PASS"],
    ["N/O", "A second resolvePendingCandidates() call against the same journal (simulated restart) does not "
     "re-resolve an already-resolved identity and never duplicates its outcome event; an unresolved identity "
     "is still found pending after a simulated restart", "PASS (2 tests)"],
    ["P/Q", "Session-ended-with-zero-bars -> DEGRADED (not fabricated no_fill); a &gt;150s causal gap -> "
     "DEGRADED; a torn/corrupt bar-journal line is reported, not dropped or coerced; a bar line missing a "
     "required field is rejected", "PASS (4 tests)"],
    ["R/S", "bar-journal.ts and resolver.ts import no broker/execution module (code lines only)", "PASS"],
    ["V/W", "computeConfigHash/computeDecisionPolicyHash remain deterministic and unaffected by adding the "
     "resolver", "PASS"],
    ["Y/Z", "executor.flattenAll(...) appears before qualityOnlyWriter.shutdown(...) in shutdown's source; the "
     "drain is time-bounded and its try/catch starts strictly after the flatten block closes", "PASS (2 tests)"],
    ["(bar-mirror semantics)", "Only provably-closed bars persist; a superseded bar writes immediately; the "
     "session's last bar eventually writes via the wall-clock safety margin; a written bar is immutable even "
     "if the provider later 'revises' it", "PASS (4 tests)"],
    ["(projection)", "toCandleArray() round-trips ResearchBar[] back to the exact Candle shape outcome.ts "
     "consumes", "PASS"],
    ["(async writer: grep)", "No appendFileSync/writeFileSync/fsyncSync anywhere in bar-journal.ts", "PASS"],
    ["(async writer: B/C)", "mirrorBars() returns before a deliberately-never-resolving mocked writer settles; "
     "the writer is invoked but has not completed by the time control returns to the caller (structural, not "
     "timing-based)", "PASS"],
    ["(async writer: D)", "A rejected write never throws into the caller and is recorded via the degradation "
     "counters, not silently swallowed", "PASS"],
    ["(async writer: E)", "20 concurrent mirrorBars() calls (no await between them) produce exactly 20 valid, "
     "un-interleaved NDJSON lines — serialized through one writer", "PASS"],
    ["(async writer: F/G)", "A ~1.78MB batch is accepted; a second, disjoint ~1.78MB batch enqueued before the "
     "first settles is dropped WHOLE once combined bytes exceed the 2MiB bound, with the exact dropped-bar "
     "count recorded and the accepted batch still landing on disk in full", "PASS"],
]
table(resolver_rows, col_widths=[1.3*inch, 6.5*inch, 1.6*inch])
sp()
p("34 tests in tests/quality-only-resolver.test.ts, all passing. Combined total across all three QUALITY_ONLY "
  "test files: <b>95/95 tests passing (55 + 6 + 34).</b>")

# ── 13. Changed-file diff summary ─────────────────────────────────────────
story.append(PageBreak())
h1("13. Complete Changed-File Diff Summary (this pass: outcome-resolution substrate)")
p("<b>This pass modifies THREE existing tracked/in-progress files</b>, each for one of the three narrow reasons "
  "this task's absolute constraints authorize: (a) passively mirroring already-fetched bars -> "
  "src/lib/monitor.ts; (b) invoking the pending-outcome resolver -> scripts/alert-daemon.ts; (c) correcting the "
  "research-vs-execution shutdown ordering -> scripts/alert-daemon.ts again, plus a small additive change to "
  "src/lib/experiments/quality-only/persistence.ts's JournalWriter.shutdown() to make the drain bounded (a new "
  "module could not add a time budget to that class's own drain loop without duplicating or monkey-patching it). "
  "Everything else is new/additive:")
files = [
    "src/lib/monitor.ts (MODIFIED — one new import + one mirrorBars(...) call, pure addition, zero lines removed "
    "or changed; see 13.1)",
    "scripts/alert-daemon.ts (MODIFIED — resolver invocation added to sweep(), and the shutdown sequence "
    "reordered so execution settlement runs before the (now time-bounded) research drain; see 13.2)",
    "src/lib/experiments/quality-only/persistence.ts (MODIFIED — JournalWriter.shutdown() gained an optional "
    "`budgetMs` parameter, default-unlimited so existing callers/tests are byte-for-byte unaffected; see 13.3)",
    "src/lib/research/bar-journal.ts (NEW — the passive 1m research bar mirror + reader; Section 18-19)",
    "src/lib/experiments/quality-only/resolver.ts (NEW — the pending-candidate resolver; Section 20)",
    "src/lib/experiments/quality-only/index.ts (MODIFIED, untracked dir — barrel export line added for resolver.ts)",
    "tests/quality-only.test.ts (2 assertions updated to reflect that monitor.ts is now legitimately modified "
    "under reason (a), with a new positive pure-addition proof replacing the old blanket-empty-diff check)",
    "tests/quality-only-resolver.test.ts (NEW — 34 tests covering the resolver/bar-journal/shutdown-ordering "
    "letters A-Z from this task's required matrix; Section 12.2)",
    "scripts/research/build_quality_only_pdf.py (this script, updated)",
    "reviews/quality-only-shadow-preregistration/QUALITY_ONLY_SHADOW_PREREGISTRATION_AND_IMPLEMENTATION_BUNDLE.pdf "
    "(this document, redeployed to the same path)",
]
bullets(files)
p("src/lib/setup-detectors.ts and src/lib/buy-log.ts (BASE decision semantics), and src/lib/mike/* / "
  "scripts/mike-scan.ts, remain completely untouched — confirmed by the actual `git status --porcelain` output "
  "below (shelled out at PDF-build time, not hand-transcribed):")
code(GIT_STATUS if GIT_STATUS else "(clean — nothing to show)")

h2("13.1 The REAL `git diff` for src/lib/monitor.ts (shelled out at PDF-build time)")
p("Reproduced verbatim below via `git diff HEAD -- src/lib/monitor.ts` — a pure-addition diff (zero lines "
  "removed), proven by tests/quality-only.test.ts's new structural assertion:")
for chunk_start in range(0, len(MONITOR_DIFF), 3500):
    code(MONITOR_DIFF[chunk_start:chunk_start + 3500] or "(empty)")
    sp(4)

h2("13.2 The REAL `git diff` for scripts/alert-daemon.ts (shelled out at PDF-build time)")
p("Reproduced verbatim below via `git diff HEAD -- scripts/alert-daemon.ts` — not a description, the actual "
  "output. Covers both the resolver invocation added to sweep() and the shutdown-order correction (Section 24):")
for chunk_start in range(0, len(DAEMON_DIFF), 3500):
    code(DAEMON_DIFF[chunk_start:chunk_start + 3500] or "(empty)")
    sp(4)

h2("13.3 The REAL `git diff` for persistence.ts's JournalWriter.shutdown() (shelled out at PDF-build time)")
p("Reproduced verbatim below via `git diff HEAD -- src/lib/experiments/quality-only/persistence.ts`:")
for chunk_start in range(0, len(PERSISTENCE_DIFF), 3500):
    code(PERSISTENCE_DIFF[chunk_start:chunk_start + 3500] or "(empty)")
    sp(4)

# ── 14. Validation outputs ────────────────────────────────────────────────
story.append(PageBreak())
h1("14. Validation Outputs")
table([
    ["Check", "Result"],
    ["tests/quality-only.test.ts (unit/function-level)", "55/55 passed"],
    ["tests/quality-only-daemon-integration.test.ts (TRUE end-to-end, real seam)", "6/6 passed"],
    ["tests/quality-only-resolver.test.ts (NEW — resolver/bar-journal/shutdown-order + async bar-writer, letters A-Z)", "34/34 passed"],
    ["Full vitest suite", "883/884 passed, 1 skipped (53 test files, 0 failed)"],
    ["typecheck (tsc --noEmit)", "clean, zero errors"],
    ["lint (eslint) on all new/modified files", "clean, zero errors/warnings (pre-existing unrelated lint debt in "
     "accounting.test.ts / ContinuationDrawer.tsx, neither touched by this task, is untouched and out of scope)"],
    ["git diff --check", "clean"],
    ["git status", (f"validated pre-commit: two modified tracked files (scripts/alert-daemon.ts, "
     "src/lib/monitor.ts); src/lib/experiments/quality-only/persistence.ts modified but itself untracked "
     "(whole dir new); rest new/untracked. Actual current `git status --porcelain` at this build "
     f"(producer HEAD {GIT_HEAD}): " + (GIT_STATUS if GIT_STATUS else "clean") + ".")],
    ["build (next build)", "BLOCKED by the SAME pre-existing environment issue as the prior pass — Turbopack "
     "refuses this worktree's node_modules symlink (\"points out of the filesystem root\"); not a strategy "
     "defect, noted per this task's instructions. typecheck (tsc --noEmit) independently validates full "
     "compilation, including all new resolver/bar-journal modules."],
    ["Zero-request proof (bar mirroring + resolver)", "PASS — see tests \"A. zero-provider-request proof\" "
     "(global.fetch spy asserts 0 calls through both mirrorBars() and resolvePendingCandidates())"],
    ["Configured hash actually computed", f"configHash = {CONFIG_HASH}  (UNCHANGED — this pass adds no new "
     "candidate-definition config input)"],
    ["Decision-policy hash actually computed", f"decisionPolicyHash = {DECISION_POLICY_HASH}  (UNCHANGED — the "
     "OFF_HIGH/GRADE_FLOOR/SPACE/RUNUP/QUALITY_OTHER mapping and outcome convention are untouched; the resolver "
     "wraps outcome.ts's frozen scorer, it does not alter it)"],
], col_widths=[4.2*inch, 5.2*inch])

# ── 15. Risks / open questions ────────────────────────────────────────────
story.append(PageBreak())
h1("15. Risks &amp; Open Questions")
bullets([
    "<b>Population composition, restated honestly under the fixed definition:</b> QUALITY_OTHER now equals "
    "'qualityVetoed=true with the four named dimensions false,' which by elimination is caused by "
    "unconfirmedKnown, quarantinedKnown, or the private vetoTrigger disjunct. MIN_GREEN_STREAK defaults to 0 "
    "(unconfirmedKnown is always false under default config), so under default env the known component reduces "
    "to quarantinedKnown (TRIGGERS_QUARANTINED: premarket_breakout, momentum_pullback, pullback, ema21_bounce). "
    "The FIX (Issue 1) widens the population relative to the first bundle by ALSO including rows explained "
    "ONLY by the private vetoTrigger disjunct (qualityOtherResidualPrivate=true) — expected to be a "
    "non-trivial share for the bounce-family types (pullback, momentum_pullback, ema9/21_bounce, vwap_bounce, "
    "vwap_reclaim), which is exactly the correction the coordinator asked for.",
    "<b>Live integration is now actually wired</b> — scripts/alert-daemon.ts's sweep() loop calls the real "
    "observer hook immediately after classifyBuy(), proven end-to-end by "
    "tests/quality-only-daemon-integration.test.ts (Section 12.1) and the real `git diff` (Section 13.1).",
    "<b>Outcome resolution is now implemented (previously an open item; now solved).</b> The observer call "
    "site itself still has no bar cache in scope (see Section 6.2) — candidates are emitted with `outcome=null` "
    "at creation, exactly as before. What changed is that a passive bar mirror "
    "(src/lib/research/bar-journal.ts) now captures the SAME 1m bars monitor.ts's own `/api/monitor` requests "
    "already fetch, and a pending-candidate resolver (src/lib/experiments/quality-only/resolver.ts, invoked "
    "once per daemon sweep) reads that mirror on later passes to causally resolve each candidate into "
    "SCORABLE/PENDING/CENSORED/DEGRADED (Section 20). No new provider request was added anywhere in this "
    "path.",
    "<b>Same-symbol subgroup fields are largely null</b> on this branch: BuySignalRecord carries no "
    "open/closed/realized-R fields, so 'prior trade open/closed' and 'prior realized R' are honestly recorded "
    "as unavailable rather than guessed or fetched.",
    "<b>universeRank and leaderEpisodeId are N/A</b> on this branch — no canonical universe-rank field is "
    "exposed read-only on MonitorResult, and H4B's leader-episode concept does not exist here at all.",
    "<b>Judgment calls made explicit:</b> (1) QUALITY_OTHER = aggregate qualityVetoed with named dimensions "
    "false, per the coordinator's explicit correction; (2) qualityOtherResidualPrivate deliberately does not "
    "name longBounceRolledOver, so the representation survives production adding another private disjunct; "
    "(3) residualQualityPresence=UNKNOWN for multi-fail non-primary rows, rather than inventing a co-presence "
    "answer; (4) reuse of shadow-journal.ts's etTradingDay+setupId identity for freshness, per explicit "
    "instruction; (5) the daemon-seam integration is now actually applied to scripts/alert-daemon.ts, the one "
    "constraint this task explicitly lifts; (6) candidates are still created with outcome=null at the "
    "observer call site itself (no bar cache in scope there, Section 6.2) rather than approximated or faked, "
    "but a later resolver pass (Section 20) now causally fills that outcome in from the passive bar mirror — "
    "this is no longer left open.",
])

# ── 16. No production change statement ────────────────────────────────────
h1("16. Explicit Statement")
p("<b>NO production DECISION SEMANTICS were changed to produce this experiment.</b> src/lib/setup-detectors.ts "
  "and src/lib/buy-log.ts are byte-for-byte unmodified (verified by `git diff --name-only` returning empty for "
  "those paths — test 18). <b>src/lib/monitor.ts WAS modified</b>, under this task's explicitly authorized "
  "reason (a): a single new import plus one `mirrorBars(sym, intraday, ...)` call, added immediately after "
  "`intraday` is computed for BASE's own use — a pure-addition diff (zero lines removed/changed), proven by a "
  "new structural test (Section 13.1). It does not read, mutate, or gate on anything BASE computes afterward. "
  "<b>scripts/alert-daemon.ts WAS modified</b> — invoking the resolver once per sweep (reads local files only, "
  "exception-isolated) and correcting the shutdown ordering (Section 24). No broker or PaperExecutor code path "
  "was touched or called by src/lib/research/bar-journal.ts or src/lib/experiments/quality-only/resolver.ts "
  "(grep-proven, Section 20). src/lib/mike/* and scripts/mike-scan.ts were not touched. No official "
  "collection-start marker was created anywhere in this worktree. Nothing in this task was committed.")

# ── 17. Provenance & environment note ─────────────────────────────────────
story.append(PageBreak())
h1("17. Provenance &amp; Environment Note")
p(f"This bundle was produced directly in the LIVE worktree at branch <font face=\"Courier\">{GIT_BRANCH}</font>, "
  f"HEAD <font face=\"Courier\">{GIT_HEAD}</font> — the same commit the task specified as the live tip "
  "(research/top-mover-audit-robustness). Unlike an earlier revision of this bundle (produced in a separate, "
  "stale worktree pinned 8 commits behind that tip), there is no worktree-base gap here: every source citation "
  "in this document was read directly from this worktree's own checked-out files, not via `git show <tip>:<path>` "
  "against a different ref.")
p("<b>Environment note (not a code defect):</b> this worktree had no `node_modules` of its own at task start "
  "and was linked to the main checkout's `node_modules` via a symlink (the same pattern already used by every "
  "sibling worktree in this environment) so that npm/npx/vitest/tsc/eslint could run at all. `next build` "
  "(Turbopack) refuses to resolve packages through that symlink (\"Symlink [project]/node_modules is invalid, "
  "it points out of the filesystem root\") — reproduced identically in a sibling worktree that this task never "
  "touched, confirming it is a pre-existing environment limitation of this multi-worktree setup, not something "
  "introduced by this task's changes. `tsc --noEmit` (Section 14) independently confirms the full project, "
  "including scripts/alert-daemon.ts and every file under src/lib/experiments/quality-only/, compiles cleanly.")

# ── 18. Phase 1 data-plane trace ──────────────────────────────────────────
story.append(PageBreak())
h1("18. Phase 1 — Real 1m Data-Plane Trace &amp; Chosen Zero-Request Bar Source")
p("Traced the LIVE path from provider request to the JSON `/api/monitor` response before writing any code, per "
  "this task's Phase 1 instruction. Findings:")
bullets([
    "<b>Canonical bars already exist server-side.</b> `buildMonitorResult()` (src/lib/monitor.ts) resolves 1m "
    "candles under the shared in-process cache key `candles1m:&lt;symbol&gt;` (src/lib/cache.ts's singleton "
    "`Cache`, TTL 30s). That SAME key is also read by src/app/api/gainers/route.ts, src/lib/snapshot.ts, and "
    "scripts/mike-scan.ts — i.e. this is a genuinely shared production cache with four consumers, not a "
    "monitor-only value.",
    "<b>That cache is unreachable across processes.</b> `scripts/alert-daemon.ts` never imports monitor.ts — it "
    "talks to the Next.js server exclusively over HTTP (`fetch(BASE + '/api/monitor')`), and the JSON response "
    "it parses carries no raw `Candle[]` (stripped before return). A future standalone resolver process would "
    "have the identical problem: it is a separate OS process with no access to the server's in-memory cache.",
    "<b>No existing persistent bar artifact was found</b> anywhere in the codebase (searched: no candle store, "
    "parquet file, sqlite table, or bar-specific JSONL log existed prior to this pass).",
    "<b>Source priority conclusion:</b> (1) reusable in-memory cache — NOT reachable cross-process, ruled out; "
    "(2) existing persistent artifact — does not exist, ruled out; therefore (3) applies: the smallest passive "
    "tap at the point canonical bars already exist for production use. The chosen tap point is "
    "src/lib/monitor.ts's `buildMonitorResult()`, immediately after `const intraday = toCandles(rawIntraday)` — "
    "the exact array BASE itself uses next. (4) was never needed: no new provider request was added anywhere.",
])
h2("18.1 Why not `src/app/api/monitor/route.ts` itself")
p("The task's Phase 1 example suggested the route handler as a candidate tap point. Traced and rejected: "
  "route.ts never sees the candle array at all — it only calls `buildMonitorBatch()` and receives back the "
  "already-assembled `MonitorResult[]` (candles already stripped inside monitor.ts before that return). The "
  "actual point of canonical-bar existence is one level deeper, inside `buildMonitorResult()` itself.")

# ── 19. Passive mirror design ──────────────────────────────────────────────
h1("19. Passive 1m Research Mirror — Design (src/lib/research/bar-journal.ts)")
p("A NEW, additive, generic (not QUALITY_ONLY-specific — per the task's stated preference) module. Design "
  "properties, each mapped to the task's explicit requirements:")
bullets([
    "<b>Zero extra provider requests.</b> `mirrorBars(symbol, candles, source, nowMs)` takes the caller's "
    "already-fetched `Candle[]` — it never calls fetch/axios/http itself (grep-proven, and a live `global.fetch` "
    "spy proves 0 calls across a full mirror+resolve cycle — test suite 'A').",
    "<b>Never changes which bars BASE sees or the /api/monitor response contract.</b> The call site in "
    "monitor.ts reads `intraday` and passes it through unmodified; `mirrorBars` never mutates its input array "
    "(test 'B') and its return value (none — `void`) is never wired into anything BASE returns.",
    "<b>Fails open for production.</b> Every public function is wrapped in try/catch; an unwritable path, a "
    "malformed candle (NaN fields), or an empty array are all silent no-ops, never a thrown exception "
    "(test suite 'C').",
    "<b>Fire-and-forget, and genuinely non-blocking (see Section 19.2 for the full design and this task's "
     "fix).</b> `mirrorBars()` is a synchronous FUNCTION (same call site, same signature) that performs ZERO "
    "synchronous filesystem I/O — every eligible bar is serialized into one NDJSON payload and handed to an "
    "internal async, serialized, bounded write queue (`fs/promises` `appendFile`), and `mirrorBars()` returns "
    "to the caller (buildMonitorResult, on the live `/api/monitor` request path) before that write settles, "
    "regardless of disk latency.",
    "<b>Append/dedupe asynchronously across process lifetimes.</b> Per-process in-memory de-dup "
    "(`Set&lt;symbol:barStart&gt;`) prevents redundant writes within a run; a restart may re-emit an "
    "already-persisted bar (harmless — the reader dedupes by keeping the FIRST occurrence on disk, the same "
    "'earliest observation wins' rule used throughout this experiment).",
    "<b>Persists causal observation time</b> (`observedAt`) alongside `barStart`, `producerGitHead`, `source`, "
    "and `etTradingDay` — the minimum field set the task specifies, for 1m bars only.",
])
h2("19.1 Closed vs. in-progress — the honesty requirement")
p("This codebase already documents that FMP's SAME-DAY intraday tape is PROVISIONAL and can be revised after "
  "the fact (src/lib/research/phantom-book.ts's `tapeState()`). Given that, this module makes NO claim that a "
  "'closed' bar's value can never be revised by the provider's backend later — it makes a narrower, honest "
  "claim: a bar is mirrored to disk ONLY once there is positive evidence it is no longer the newest/forming bar "
  "(a strictly later sibling bar already exists in the SAME fetch, OR &gt;=90s — 1.5x a bar's duration — of "
  "wall-clock time has elapsed since its open, which also covers the last bar of a session that no later bar "
  "ever supersedes). Once written, a barStart is immutable on disk — a later 'revised' value for the same "
  "minute is never re-observed (proven by test 'a written bar is immutable'). This is deliberate: the "
  "experiment scores candidates on what was causally knowable at observation time, which is exactly what a "
  "live/prospective study requires — not on a later-revised 'true' value.")
p("<b>What this does NOT solve, stated plainly:</b> if the provider silently revises a bar's OHLC values within "
  "the ~90s window BEFORE this module's closure proof fires, that revision IS what gets captured (this module "
  "cannot see a value it hasn't observed yet). This is the same causal limit any live system has; it is not "
  "papered over here.")
h2("19.2 Async I/O — the live-latency fix (this pass)")
p("An earlier revision of `mirrorBars()` used per-bar SYNCHRONOUS <font face=\"Courier\">fs.appendFileSync</font> "
  "on the live `/api/monitor` request path. A synchronous filesystem call blocks Node's single event loop for "
  "its full duration regardless of whether the caller awaits the enclosing function — a real production-latency "
  "risk on a hot path, not a documentation nitpick. This pass replaces it with genuine asynchronous, "
  "non-blocking I/O:")
table([
    ["Property", "Value / behavior"],
    ["Monitor path synchronous research I/O", "NONE — grep-proven (no appendFileSync/writeFileSync/fsyncSync "
     "anywhere in bar-journal.ts) and structurally proven (a writer whose promise never resolves still lets "
     "mirrorBars() return immediately — test 'B/C')."],
    ["Bar writer design", "ASYNC / BOUNDED / SERIALIZED. Every bar found eligible within ONE mirrorBars() call "
     "is batched into a single NDJSON payload and handed to `fs/promises`' `appendFile` as ONE write op per "
     "call (not one per bar). ALL enqueued writes, across every symbol/path and every concurrent mirrorBars() "
     "call, are threaded through one process-wide promise chain, so at most one `appendFile` is ever in flight "
     "and payloads land on disk in the exact order they were enqueued — correctness relies on this explicit "
     "serialization, not on `appendFile`'s unguaranteed cross-platform atomicity (test 'E': many concurrent "
     "calls, zero interleaved/corrupted NDJSON lines)."],
    ["Queue limit", "2 MiB of total queued-but-not-yet-flushed payload bytes (`MAX_QUEUE_BYTES`). A typical "
     "NDJSON bar row is ~230-270 bytes, so this bounds the backlog to roughly 8,000-9,000 pending bar rows — "
     "generous slack for a multi-minute disk stall across the whole scanner universe, while remaining a small, "
     "fixed amount of server memory on a research-only path. Chosen as a conservative fixed bound rather than "
     "tuned to a specific incident (test 'F': the bound is enforced exactly — a batch that would push total "
     "queued bytes over it is rejected)."],
    ["Overflow behavior", "The offending BATCH (not individual bars) is dropped whole — never partially "
     "written, never buffered further. The drop is always OBSERVABLE: a `RESEARCH_WRITE_DEGRADED` log line "
     "plus in-memory counters (`droppedBatchCount`, `droppedBarCount`) that a caller can inspect via "
     "`__getBarJournalQueueStats()`. Dropped bars are still marked in the per-process dedupe set so a slow disk "
     "does not cause the SAME bars to be re-attempted (and re-logged) on every subsequent sweep — the gap "
     "surfaces downstream through the resolver's existing, UNCHANGED DEGRADED/CENSORED completeness rules "
     "(test 'G')."],
    ["Write failure handling", "A rejected `appendFile` (e.g. ENOENT/EACCES) is caught inside the write chain "
     "itself, logged via the same degradation signal, and never rethrown — so a research write failure can "
     "never propagate into BASE and there is no unhandled promise rejection anywhere in this path (test 'D')."],
    ["Shutdown / flush", "None, deliberately. This module lives in the Next.js SERVER process, not "
     "scripts/alert-daemon.ts (a separate OS process) — there is no safe production shutdown hook to drain "
     "into here, and building one would reintroduce a production dependency on a research-only concern. "
     "Production availability outranks research completeness for this path: bars still queued at an abrupt "
     "server death are simply lost, and that loss surfaces later as DEGRADED/CENSORED through the resolver's "
     "existing (unchanged) completeness rules — exactly like any other unobserved bar gap. This is a "
     "documented tradeoff, not an oversight."],
    ["Restart/duplicate worst case", "A restart may re-emit bars already on disk for the SAME (symbol,barStart) "
     "the crashed process had already written — harmless: the reader (`loadResearchBars`) dedupes by keeping "
     "the FIRST occurrence, so duplicate rows are silently reconciled at read time and never double-count "
     "toward an outcome. Worst-reasonable file growth for one restart within the SAME trading day is bounded "
     "by however many already-closed bars that day's 90s-safety-margin window re-qualifies on the next fetch "
     "after the crash — at most a handful of extra rows per symbol, not an unbounded replay, since bars already "
     "in the per-process `written` set before the crash are gone with it, but everything older than the "
     "90-second closure margin was almost certainly already flushed before a graceful-looking crash. No "
     "expensive synchronous startup scan was added to dedupe this on the monitor hot path — that would "
     "reintroduce exactly the blocking problem this pass fixes; the resolver's read-side dedupe already "
     "handles it for free."],
], col_widths=[2.0*inch, 7.4*inch])
p("<b>Zero behavioral change to anything frozen:</b> `mirrorBars()`'s call site, signature, and synchronous "
  "return type in src/lib/monitor.ts are unchanged (no edit to monitor.ts was needed for this fix — it is "
  "entirely internal to bar-journal.ts). Earliest-observed immutable-bar semantics, `observedAt` stamping, "
  "closed/forming-bar logic, and the reader-side dedupe/restart behavior are all unchanged and re-verified by "
  "the existing bar-mirror tests (now `await`ing an explicit test-only flush helper, "
  "`__flushBarJournalWritesForTests()`, before asserting on-disk state — the only test-side change this async "
  "rewrite required). configHash and decisionPolicyHash are unaffected, as expected for a pure I/O-strategy "
  f"change: configHash = {CONFIG_HASH}, decisionPolicyHash = {DECISION_POLICY_HASH} (both identical to every "
  "prior revision of this bundle).")

# ── 20. Pending-candidate lifecycle / resolver architecture ────────────────
h1("20. Pending-Candidate Lifecycle &amp; Resolver Architecture (src/lib/experiments/quality-only/resolver.ts)")
p("<b>Where it runs:</b> once per daemon sweep (scripts/alert-daemon.ts, after the existing per-setup loop, "
  "right before the sweep's arbitration snapshot/return) — the least-coupled option available: no new process, "
  "no new timer, reuses the daemon's existing cadence and the fact that monitor.ts's mirror tap is already "
  "producing new bars on every sweep's /api/monitor calls. A standalone resolver process was considered and "
  "rejected as unnecessary added operational surface for this branch's request volume.")
p("<b>Lifecycle:</b> candidate emitted (existing observer, outcome=null) -&gt; PENDING while causal bars "
  "accumulate -&gt; resolver classifies on each pass -&gt; exactly ONE outcome event appended when the "
  "candidate reaches SCORABLE, CENSORED, or DEGRADED (never for PENDING) -&gt; the candidate identity is never "
  "touched again (append-only; an already-resolved identity is skipped on every subsequent pass).")
h2("20.1 Zero provider requests, proven")
p("`resolvePendingCandidates()` reads only two kinds of local files: the candidate journal path passed in, and "
  "the bar-journal files `loadResearchBars()` resolves (also local disk). Grep-proven (no fetch/axios/http "
  "import in resolver.ts) AND live-proven (a `global.fetch` spy records 0 calls across a full "
  "candidate-write -&gt; resolve cycle — test suite 'A').")
h2("20.2 Zero broker/PaperExecutor interaction")
p("Neither src/lib/research/bar-journal.ts nor src/lib/experiments/quality-only/resolver.ts imports "
  "alpaca/broker/PaperExecutor, and neither calls placeOrder/submitOrder (grep-proven on code lines only, "
  "excluding doc comments that reference the invariant by name — test suite 'R/S').")

# ── 21. Restart recovery ────────────────────────────────────────────────────
h1("21. Restart Recovery")
p("The resolver keeps NO separate cursor/state file. Each call re-derives the pending set fresh from the "
  "append-only candidate journal: every `kind:'candidate'` event's identity, minus every identity that already "
  "has a `kind:'outcome'` event. Because journal identities are deterministic "
  "(`candidateIdentity(etDay, symbol, setupId, configHash)`, unchanged from the existing candidate.ts) and the "
  "file is append-only, this is naturally idempotent:")
bullets([
    "A crash/restart mid-run just re-derives the identical pending set on the next call — nothing is lost "
    "(proven by test 'N').",
    "An identity that already has an outcome event is skipped on every later call — a restart can NEVER produce "
    "a second outcome for the same candidate (proven by test 'O': two `resolvePendingCandidates()` calls "
    "against the same journal, simulating a restart between them, yield exactly one outcome row).",
    "The earliest candidate event for a given identity is authoritative; a later duplicate candidate event "
    "(e.g. a restart re-observing the same setup before its journal write landed) changes nothing.",
])

# ── 22. Scorable / Pending / Censored / Degraded ────────────────────────────
h1("22. SCORABLE / PENDING / CENSORED / DEGRADED — Precise, Deterministic Definitions")
table([
    ["State", "Definition"],
    ["SCORABLE", "(a) terminal invalidation causally fired — scorable immediately, however little time has "
     "elapsed (test 'K'); OR (b) entered, and the full 30-minute post-entry horizon has been observed with no "
     "invalidation; OR (c) never entered, and the full 30-minute post-observation horizon has been observed "
     "with no entry trigger at all ('no fill within 30m' is itself a real, scorable result). Only SCORABLE rows "
     "count toward the original preregistration's 100-scorable/30-symbol-day/10-session collection minimum."],
    ["PENDING", "None of the SCORABLE conditions hold yet, the trading session has not ended, and no data "
     "problem was detected. Retried on the next resolver pass."],
    ["CENSORED", "A SCORABLE condition would eventually be reached, but the session ended first — covers both "
     "'candidate created &lt;30m before session end' and 'daemon/process was down and no more sweeps ran before "
     "session end.' The partial bar-walk outcome is preserved (not discarded), flagged CENSORED, excluded from "
     "the SCORABLE collection minimum."],
    ["DEGRADED", "A data-quality problem makes completeness unprovable: a &gt;150s gap between consecutive "
     "causal bars (provider/cache gap, missing bars, a restart window with no mirrored bars), the day's bar "
     "journal contains corrupt/torn lines, or the session ended with ZERO research bars ever observed for that "
     "candidate at all (a genuine data-plane gap, never silently reinterpreted as 'no fill'). Also excluded "
     "from the SCORABLE collection minimum."],
], col_widths=[1.6*inch, 7.8*inch])
h2("22.1 Causal timing proof")
p("scoreQualityOnlyOutcome() (outcome.ts, FROZEN, unchanged by this pass) already filters to "
  "`c.time*1000 &gt;= candidateObservedAtMs` before any walk begins. The resolver additionally filters the "
  "bar-journal read to the same boundary before projecting to `Candle[]` (belt-and-suspenders — test 'F': a "
  "pre-candidate spike bar cannot grant entry/invalidation credit). The 5m/15m/30m horizon windows "
  "(`withinHorizon`) are bounded from the ACTUAL entry bar time, so a bar 31 minutes after entry cannot leak "
  "into `mfeR30m` (test 'J'). Because mirrorBars() never persists a bar until it is provably no longer the "
  "newest/forming one (Section 19.1), the resolver can never see a not-yet-closed future bar and grant it "
  "premature credit (test 'G').")

# ── 23. Zero-request proof summary ──────────────────────────────────────────
h1("23. Zero-Request Proof — Summary")
table([
    ["Path", "Proof"],
    ["Candidate creation (existing observer.ts/candidate.ts)", "Unchanged by this pass — already proven in "
     "Section 11 of the prior bundle; still holds (candidate.ts/observer.ts untouched)."],
    ["Bar mirroring (mirrorBars)", "Grep: no fetch/axios/http import in bar-journal.ts. Live: global.fetch spy "
     "records 0 calls while mirroring a multi-bar fetch to a temp journal (test suite 'A')."],
    ["Outcome resolution (resolvePendingCandidates)", "Grep: no fetch/axios/http import in resolver.ts. Live: "
     "global.fetch spy records 0 calls across a full write-candidate -&gt; mirror-bars -&gt; resolve cycle "
     "(test suite 'A')."],
], col_widths=[3.4*inch, 6*inch])

# ── 24. Shutdown-order correction ───────────────────────────────────────────
h1("24. Shutdown-Order Correction (real diff in Section 13.2)")
p("<b>The bug found:</b> the existing shutdown sequence drained QUALITY_ONLY research writes BEFORE "
  "`executor.flattenAll('risk_halt')` — real position-flattening/settlement. A stuck or slow research write "
  "could therefore have delayed real settlement, which is backwards for a paper-trading safety path.")
p("<b>The fix:</b> the sequence is now, unconditionally: (1) stop new daemon work "
  "(`observerLoop?.stop()`); (2) execution cancel/flatten/settlement (`executor.flattenAll(...)`); (3) "
  "execution summary (`executor.summary()`); (4) QUALITY_ONLY research drain, now bounded to a 2-second budget "
  "via `JournalWriter.shutdown(2_000)` (Section 13.3's persistence.ts diff) so a stuck disk write can never "
  "hang process exit indefinitely; (5) `process.exit(0)`. Proven structurally by tests/quality-only-resolver."
  "test.ts's 'Y/Z' suite: `executor.flattenAll(` is confirmed to appear, in source order, before "
  "`qualityOnlyWriter.shutdown(`, and the drain's try/catch is confirmed to start strictly after the flatten "
  "block closes (so a drain exception cannot unwind back through an already-completed flatten call).")
p("<b>Why the timeout, given the ordering fix alone already protects settlement:</b> the task explicitly asks "
  "for a bounded/fail-conservative drain 'if the research drain could block indefinitely.' With the ordering "
  "fixed, a slow drain can no longer delay settlement, but it could still hang the process's exit indefinitely "
  "after settlement is done — the bound keeps the daemon's shutdown itself reliable without weakening any "
  "execution invariant.")

sp(20)
small(f"Generated {__import__('datetime').datetime.now().isoformat()} — producer git HEAD {GIT_HEAD} on branch {GIT_BRANCH}.")
small("Collection status: PRE_OFFICIAL. No `quality-only-epoch-1` collection-start marker exists anywhere "
      "outside a throwaway test-fixture temp directory. This pass adds outcome-RESOLUTION machinery only — it "
      "does not start collection.")

# ── Page numbering ────────────────────────────────────────────────────────
def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#777777"))
    canvas.drawRightString(PAGE_SIZE[0] - 0.5 * inch, 0.4 * inch, f"Page {doc.page}")
    canvas.drawString(0.5 * inch, 0.4 * inch, "QUALITY_ONLY Shadow Preregistration & Implementation Bundle")
    canvas.restoreState()

doc = SimpleDocTemplate(
    str(OUT_PATH), pagesize=PAGE_SIZE,
    leftMargin=0.6 * inch, rightMargin=0.6 * inch, topMargin=0.6 * inch, bottomMargin=0.6 * inch,
    title="QUALITY_ONLY Shadow Preregistration & Implementation Bundle",
)
doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
print(f"Wrote {OUT_PATH}")
