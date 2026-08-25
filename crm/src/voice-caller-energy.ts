// CallerEnergyEvidence — Fix A (2026-08-24): energy becomes SECONDARY caller evidence.
//
// THE CALL THIS FIXES (fix-25, room call-97e26350): the owner was TALKING — the meter
// measured him at rms 0.0511 (w188, clear) inside answer window 3 and 0.0905/0.0516
// (w237 playout 0.73 / w238 clear) inside answer window 4 — and Gemini returned ZERO
// `transcript-in` for any of it. Both windows expired `countedSilence:true`, hit
// MAX_CONSECUTIVE_SILENCES, and the system hung up on a caller mid-sentence at 2
// answers of 10, with ~35s of the 87s call spent as dead air. The instrument that
// could decide "was he speaking?" (AudioEnergyMeter, shipped 5dee188) was running the
// whole time — observation-only, consulted by nothing. This module is the decision it
// was built to inform.
//
// THE RULE, live-calibrated (n=2 calls, one callee, one trunk): a window QUALIFIES
// when rms >= 0.02 AND !duringPlayout; evidence fires when 2 CONSECUTIVE qualifying
// windows close. Basis: caller speech measured 0.034–0.172 rms on this trunk (fix-25:
// 0.0511/0.0905/0.0516; an earlier greeting: 0.076/0.172/0.034), quiet floor <=0.0017,
// during-playout echo <=0.0008 — 0.02 sits ~12x above the floor and ~1.7x below the
// softest observed speech. Confidence is HIGH on this trunk and MODERATE across
// carriers (trunk-side loss/AGC varies — the meter's calibration header), so both
// numbers are constructor options with exported defaults; the worker reads env at its
// edge (VOICE_ENERGY_EVIDENCE_RMS / VOICE_ENERGY_EVIDENCE_WINDOWS) and injects — this
// module NEVER reads process.env (the file-header doctrine).
//
// TWO CONSTANTS, TWO DECISIONS: the meter's DEFAULT_SPEECH_RMS_THRESHOLD (0.03) is a
// provisional LOG LABEL for calibration; DEFAULT_ENERGY_EVIDENCE_RMS (0.02) is the
// EVIDENCE bar. They are independently tunable on purpose — this tracker reads the
// window's raw `rms`, never its `speechLike` label.
//
// PER-WINDOW CLASSIFICATION (each rule earned by a live shape):
//   · rms >= threshold, !duringPlayout  -> the run advances. `duringPlayout` is the
//     METER's majority classification (playoutFraction >= 0.5 — voice-audio-energy.ts
//     closeWindow), consumed as-is: a part-playout window (e.g. fraction 0.27) counts
//     as CLEAR, and E6 pins the 0.5 rule against the real meter so a later meter
//     change cannot silently move this gate.
//   · rms >= threshold, duringPlayout   -> HOLD: neither counts nor resets. Ambiguous
//     by construction — caller-over-agent looks identical to line echo from here (the
//     meter's echo-signature header) — and the live w237(0.73)/w238(clear) pair shows
//     a real caller's utterance straddling the playout tail: a reset here would split
//     every such utterance and blind the rule to exactly the fix-25 shape.
//   · rms < threshold                   -> RESET. Silence between utterances must not
//     let two isolated syllables minutes apart masquerade as sustained speech.
//
// WHAT EVIDENCE MAY AND MAY NOT DO (the review's constraints, enforced at the
// consumers): it prevents an answer window from being COUNTED as silence and it can
// settle a no-audio say as barge-in (`delivered:false`) — it must NEVER produce
// `delivered:true` (model frames only) and never fabricate an answer. A call with no
// caller evidence of ANY kind — no fragment, no interrupt, no sustained clear energy —
// still dies honestly and publishes nothing (the F4 narrowing, owner-accepted).
//
// EVERY evidence window counts (not just the run's first): `evidenceWindows()` is a
// monotonic counter that keeps advancing while sustained speech continues, so a
// consumer snapshotting it at window-open always sees movement if the caller spoke
// for >= consecutiveWindows windows INSIDE that answer window — even when the run
// started before the window opened.
import type { EnergyWindow } from "./voice-audio-energy.js";

/** Normalized RMS at/above which a clear window qualifies as caller evidence.
 *  Live-calibrated on THIS trunk (header) — moderate confidence across carriers,
 *  hence injectable. Deliberately distinct from the meter's 0.03 log label. */
export const DEFAULT_ENERGY_EVIDENCE_RMS = 0.02;

/** Consecutive qualifying windows (600ms at the meter's 300ms default) that make
 *  evidence: a cough or click tops out under one window; deliberate speech crosses
 *  two — the meter's own sustained-run reasoning, applied as a decision. */
export const DEFAULT_ENERGY_EVIDENCE_WINDOWS = 2;

export interface CallerEnergyEvidenceOptions {
  /** Evidence RMS bar. Default DEFAULT_ENERGY_EVIDENCE_RMS (0.02). */
  rmsThreshold?: number;
  /** Consecutive qualifying windows required. Default DEFAULT_ENERGY_EVIDENCE_WINDOWS. */
  consecutiveWindows?: number;
}

export class CallerEnergyEvidence {
  private readonly threshold: number;
  private readonly needed: number;
  private run = 0;
  private count = 0;

  constructor(options?: CallerEnergyEvidenceOptions) {
    const {
      rmsThreshold = DEFAULT_ENERGY_EVIDENCE_RMS,
      consecutiveWindows = DEFAULT_ENERGY_EVIDENCE_WINDOWS,
    } = options ?? {};
    // A mis-wired evidence rule must die at COMPOSITION, before it either hangs up on
    // a talking caller (bar too high) or lets line noise defeat the dead-line bound
    // (bar at 0) — the meter's own loud-or-not-at-all constructor rule.
    if (!Number.isFinite(rmsThreshold) || rmsThreshold <= 0 || rmsThreshold >= 1) {
      throw new Error(
        `CallerEnergyEvidence: rmsThreshold must be in (0,1) normalized full-scale ` +
          `(got ${rmsThreshold})`,
      );
    }
    if (!Number.isInteger(consecutiveWindows) || consecutiveWindows < 1) {
      throw new Error(
        `CallerEnergyEvidence: consecutiveWindows must be a positive integer ` +
          `(got ${consecutiveWindows})`,
      );
    }
    this.threshold = rmsThreshold;
    this.needed = consecutiveWindows;
  }

  /** Feed one CLOSED window (the worker feeds every window `AudioEnergyMeter.onFrame`
   *  returns). Returns true iff THIS window is evidence — the run has reached the
   *  consecutive bar. Levels and counts only, structurally: nothing here can carry
   *  caller content (the meter's content rule, inherited). */
  onWindow(w: EnergyWindow): boolean {
    if (w.rms >= this.threshold) {
      if (w.duringPlayout) return false; // ambiguous (caller-over-agent vs echo): HOLD
      this.run += 1;
      if (this.run >= this.needed) {
        this.count += 1;
        return true;
      }
      return false;
    }
    this.run = 0; // quiet: the run is over
    return false;
  }

  /** Monotonic count of evidence windows so far — the snapshot surface the intake
   *  loop's answer window compares across its own lifetime (open vs expiry). */
  evidenceWindows(): number {
    return this.count;
  }
}
