"""Write-up report for one alignment prompt-optimization job.

Gives the author facts, tables and bullet-point reporting arguments: corpus and
cases, procedure, iterations, what changed, improvements with intervals and the
final numbers. No drafted manuscript prose. The protocol itself is documented in
alignment_optimizer_method.md (repo root).
"""

import difflib
import os

from config import PROJECTS_DIR


def _prompt_text(block_type, prompts):
    if block_type == "sourceAnalysis":
        return [("Detection prompt", prompts.get("detection_prompt", "")),
                ("Label prompt", prompts.get("label_prompt", ""))]
    return [(f"Rubric {i + 1} scoring prompt — {it.get('title') or ''}", it.get("scoring_prompt", ""))
            for i, it in enumerate(prompts.get("rubric_items", []))]


def _word_change(before, after):
    a, b = (before or "").split(), (after or "").split()
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return len(a), len(b), added, removed


def _ev(c, model, split="dev"):
    return ((c.get("evaluations") or {}).get(model) or {}).get(split) or {}


def build_report(job, cands, project_title=""):
    from services import agreement_stats as st
    from services import report_sections as R

    L = []
    add = L.append
    cfg = job["config"]
    models = cfg["eval_models"]
    primary = models[0]
    bt = job["block_type"]
    by_id = {c["id"]: c for c in cands}
    base = by_id.get("c000")
    final = by_id.get(job.get("best_candidate_id") or "c000") or base
    evaluated = [c for c in cands if c.get("status") == "evaluated" and c["origin"] != "baseline"]
    rejected = [c for c in cands if c.get("status") in ("unparseable", "invalid", "optimizer_error")]
    promoted_ids = job.get("parent_chain") or []
    sp = job["split"]
    n_dev, n_hold = len(sp["dev_ids"]), len(sp["holdout_ids"])

    # Paired comparisons baseline → final on the primary model
    def paired(split):
        b, f = _ev(base, primary, split).get("correctness"), _ev(final, primary, split).get("correctness")
        if not b or not f or final is base:
            return None, None
        return st.paired_delta_ci(b, f), st.flip_table(b, f)
    dev_delta, dev_flips = paired("dev")
    hold_delta, hold_flips = paired("holdout")

    add("# Prompt Optimization — Reporting Materials")
    add("")
    add("> Facts, tables and reporting points for writing up this optimization run. Bullet points state what the "
        "numbers support; the manuscript wording is left to the author. Protocol: `alignment_optimizer_method.md`.")
    add("")
    add("| Item | Value |")
    add("|---|---|")
    add(f"| Project | {project_title or '(unknown)'} |")
    add(f"| Block | {job.get('block_label')} (`{job['block_id']}`, {bt}) |")
    add(f"| Alignment test | `{job['test_id']}` (cases SHA-256 `{job['cases_sha256'][:16]}…`) |")
    add(f"| Job | `{job['job_id']}` — {job['status']}" + (f", final state **{job.get('final_state')}**" if job.get("final_state") else "") + " |")
    add(f"| Stop reason | {job.get('stop_reason') or 'n/a'} |")
    add(f"| Final working prompt | {final['id'] if final else 'n/a'}" + (" (baseline — no revision passed the selection rule)" if final is base else "") + " |")
    add("")

    add("### Headline numbers (primary model `" + primary + "`)")
    add("| | Baseline | Final | Change [95% CI] | Cases fixed / broken |")
    add("|---|---|---|---|---|")
    for split, label, delta, flips, n in (("dev", "Development", dev_delta, dev_flips, n_dev),
                                         ("holdout", "Holdout", hold_delta, hold_flips, n_hold)):
        b, f = _ev(base, primary, split), _ev(final, primary, split)
        ch = f"{R.pp(delta[0])} {R.ci(delta[1:])}" if delta else ("—" if final is base else "n/a")
        fl = f"{len(flips['fixed'])} / {len(flips['broke'])}" if flips else "—"
        add(f"| {label} agreement (n={n}) | {R.pct(b.get('primary'))} {R.ci(b.get('primary_ci'))} "
            f"| {R.pct(f.get('primary'))} {R.ci(f.get('primary_ci'))} | {ch} | {fl} |")
    add("")
    add("_Agreement = share of cases where the model's decision equals the human code "
        + ("(TRUE/FALSE detection)." if bt == "sourceAnalysis" else "(mean exact-score agreement across rubric items).") + "_")
    add("")

    # 1. Corpus and cases
    add("## 1. Corpus and cases")
    from services.corpus_stats import corpus_statistics, corpus_bullets
    from services.alignment_service import get_test
    test = get_test(job["project_id"], job["test_id"])
    try:
        cs = corpus_statistics(job["project_id"], job["block_id"], test.get("sample_unit_ids") if "error" not in test else None)
    except Exception as e:
        cs = {"error": str(e)}
    L.extend(corpus_bullets(cs))
    samp = (test or {}).get("sampling") or {}
    if samp:
        add(f"- Alignment sample: {samp.get('method')}, seed {samp.get('seed')}, frame {samp.get('frame_size')}")
    add(f"- Human-coded cases used: {len(job['human_codes'])} (codes frozen at job start)")
    add(f"- Split: {n_dev} development (optimizer may see) / {n_hold} holdout (never shown to the optimizer), "
        f"target {cfg['holdout_pct']}%, stratified by human code, seed {sp['seed']}")
    add("- Strata (human code → cases): " + ", ".join(f"{k}: {v}" for k, v in sorted(sp.get("strata", {}).items())))
    add("")

    # 2. Reference standard
    add("## 2. Human reference standard")
    cov = job.get("rationale_coverage") or {}
    b = cov.get("after_pause") or cov.get("baseline")
    add("- One human coder; codes from the alignment test above")
    if b:
        add(f"- Baseline development disagreements: {b['disagreements']}; with a written human rationale: {b['with_rationale']} "
            f"({b['post_hoc']} written after seeing model output)")
    add("- Rationales were the optimizer's primary evidence and were not used in any statistic")
    add(f"- Intra-rater reliability (rater ceiling): " + (f"{R.pct(job['rater_ceiling'])} (n = {job.get('rater_ceiling_n')} re-coded judgements)"
                                                          if job.get("rater_ceiling") is not None else "not measured"))
    add("")

    # 3. Procedure
    add("## 3. Procedure (facts)")
    add(f"- Models evaluated: {', '.join(f'`{m}`' for m in models)}; primary model for selection: `{primary}`")
    add(f"- Optimizer (revision-writing) model: `{cfg['optimizer_model']}`, proposal temperature {cfg['proposal_temperature']}, "
        f"context {cfg.get('optimizer_num_ctx')} tokens; evaluation used the project's decoding settings (§8)")
    add(f"- Search budget: up to {cfg['rounds']} rounds × {cfg['candidates_per_round']} proposals per round; each proposal targeted a "
        "different disagreement pattern (focus)")
    add("- Held fixed: prompt templates, confidence thresholds (" + ", ".join(f"{k} {v}" for k, v in job.get("fixed_settings", {}).items())
        + "), sampling parameters, model versions")
    add("- Selection rule: a revision replaced the working prompt only if the paired-bootstrap 95% CI of its gain in development "
        "agreement excluded zero and the gain exceeded the run-to-run disagreement (1 − noise floor); "
        "two consecutive rounds without such a gain ended the search (plateau)")
    add(f"- Noise floor: " + (f"{R.pct(job['noise_floor'])} self-agreement between two baseline runs"
                              if job.get("noise_floor") is not None else "not measured"))
    add(f"- Holdout examined {len(job.get('holdout_evaluations', []))} time(s), once at the end of the search")
    add("- Promotion to the live block is a separate human action (recorded in §5)")
    add("")

    # 4. Iterations
    add("## 4. Iterations")
    status_counts = {}
    for c in cands:
        if c["origin"] != "baseline":
            status_counts[c.get("status")] = status_counts.get(c.get("status"), 0) + 1
    total_props = sum(status_counts.values())
    add(f"- Rounds completed: {job.get('rounds_completed', 0)} of {cfg['rounds']}")
    add(f"- Proposals generated: {total_props}; evaluated: {status_counts.get('evaluated', 0)}; rejected before evaluation: {len(rejected)}"
        + (" (" + ", ".join(f"{k} {v}" for k, v in status_counts.items() if k != "evaluated") + ")" if rejected else ""))
    add(f"- Revisions promoted to working prompt: {len(promoted_ids)}" + (f" ({' → '.join(['c000'] + promoted_ids)})" if promoted_ids else ""))
    add(f"- Stop reason: {job.get('stop_reason') or 'n/a'}")
    add("")
    add("| Round | Proposals (valid) | Best candidate | Best dev agreement | Δ vs parent [95% CI] | State | Promoted |")
    add("|---|---|---|---|---|---|---|")
    for r in range(1, (job.get("rounds_completed") or 0) + 1):
        rc_ = [c for c in cands if c.get("round") == r]
        valid = [c for c in rc_ if c.get("status") == "evaluated"]
        best = max(valid, key=lambda c: (_ev(c, primary).get("primary") or 0, _ev(c, primary).get("tie_break") or 0)) if valid else None
        if best:
            add(f"| {r} | {len(rc_)} ({len(valid)}) | {best['id']} ({best.get('focus')}) | {R.pct(_ev(best, primary).get('primary'))} "
                f"| {R.pp(best.get('delta_vs_parent'))} {R.ci(best.get('delta_ci'))} | {best.get('state')} | {'yes' if best['id'] in promoted_ids else 'no'} |")
        else:
            add(f"| {r} | {len(rc_)} (0) | — | — | — | — | no |")
    add("")
    if evaluated:
        add("All evaluated candidates (development split):")
        add("")
        head = "| Candidate | Round | Focus | " + " | ".join(f"{m}" for m in models) + " | Δ vs parent [95% CI] | Fixed / broken | State |"
        add(head)
        add("|" + "---|" * (head.count("|") - 1))
        for c in [base] + evaluated:
            if not c:
                continue
            cells = [f"{R.pct(_ev(c, m).get('primary'))}" if _ev(c, m) else "—" for m in models]
            fl = c.get("flips_vs_parent")
            add(f"| {c['id']} | {c.get('round', 0)} | {c.get('focus') or 'baseline'} | " + " | ".join(cells)
                + f" | {R.pp(c.get('delta_vs_parent')) if c.get('delta_vs_parent') is not None else '—'} {R.ci(c.get('delta_ci')) if c.get('delta_ci') else ''}"
                + f" | {(str(len(fl['fixed'])) + ' / ' + str(len(fl['broke']))) if fl else '—'} | {c.get('state') or '—'} |")
        add("")

    # 5. Changes
    add("## 5. What changed")
    chain = [by_id[i] for i in promoted_ids if i in by_id]
    if not chain:
        add("- No revision passed the selection rule; the baseline prompt remains the best-supported version")
    prev = base
    for c in chain:
        add(f"### {c['id']} (round {c['round']}, focus: {c.get('focus')}) — promoted over {prev['id']}")
        for h in c.get("hypotheses") or []:
            ev = ", ".join(h.get("evidence_unit_ids") or []) or "no cited cases"
            add(f"- Hypothesis: {h['hypothesis']} _(evidence: {ev})_" + (f" — human rationale quoted: “{h['rationale_quote']}”" if h.get("rationale_quote") else ""))
        if c.get("diagnosis"):
            add(f"- Optimizer diagnosis: {c['diagnosis']}")
        if c.get("change_rationale"):
            add(f"- Stated reason for the change: {c['change_rationale']}")
        for (title, before), (_, after) in zip(_prompt_text(bt, prev["prompts"]), _prompt_text(bt, c["prompts"])):
            if before != after:
                nb, na, ad, rm = _word_change(before, after)
                add(f"- {title}: {nb} → {na} words (+{ad} / −{rm})")
        if c.get("flips_vs_parent"):
            f = c["flips_vs_parent"]
            add(f"- Development cases: {len(f['fixed'])} fixed, {len(f['broke'])} broken (net {f['net']:+d}); "
                f"gain {R.pp(c.get('delta_vs_parent'))} {R.ci(c.get('delta_ci'))}")
        if c.get("cited_cases_flips"):
            f = c["cited_cases_flips"]
            add(f"- On the cases its hypotheses cited: {len(f['fixed'])} fixed, {len(f['broke'])} broken")
        add("")
        prev = c
    applied = [(c, a) for c in cands for a in c.get("applied", [])]
    add("**Applied to the live block (human promotion):**" + (" none yet" if not applied else ""))
    add("")
    for c, a in applied:
        kind = "baseline" if c["origin"] == "baseline" else ("model-proposed, applied verbatim" if a["verbatim"]
                                                              else "model-proposed, edited by the author before applying")
        add(f"- {a['at']}: {c['id']} — {kind}")
    add("")
    if final is not base and final is not None:
        add("### Baseline vs final prompt text")
        for (title, before), (_, after) in zip(_prompt_text(bt, base["prompts"]), _prompt_text(bt, final["prompts"])):
            if before == after:
                add(f"**{title}** — unchanged")
                continue
            add(f"**{title} — baseline**")
            add(R.fence(before))
            add(f"**{title} — final ({final['id']})**")
            add(R.fence(after))
        add("")

    # 6. Final numbers
    add("## 6. Final numbers")
    add("| Model | Baseline dev | Final dev | Baseline holdout | Final holdout |")
    add("|---|---|---|---|---|")
    for m in models:
        add(f"| `{m}` | {R.pct(_ev(base, m).get('primary'))} {R.ci(_ev(base, m).get('primary_ci'))} "
            f"| {R.pct(_ev(final, m).get('primary'))} {R.ci(_ev(final, m).get('primary_ci'))} "
            f"| {R.pct(_ev(base, m, 'holdout').get('primary'))} | {R.pct(_ev(final, m, 'holdout').get('primary'))} |")
    add("")
    if len(models) > 1:
        add("Best candidate per model (development; holdout where evaluated):")
        add("")
        add("| Model | Best candidate | Dev agreement | Holdout agreement |")
        add("|---|---|---|---|")
        for m in models:
            pool = [c for c in [base] + evaluated if _ev(c, m)]
            if pool:
                bm = max(pool, key=lambda c: _ev(c, m).get("primary") or 0)
                add(f"| `{m}` | {bm['id']} | {R.pct(_ev(bm, m).get('primary'))} {R.ci(_ev(bm, m).get('primary_ci'))} | {R.pct(_ev(bm, m, 'holdout').get('primary'))} |")
        add("")
    if bt == "sourceAnalysis":
        cols = []
        for label, c, split in (("Baseline dev", base, "dev"), ("Final dev", final, "dev"),
                                ("Baseline holdout", base, "holdout"), ("Final holdout", final, "holdout")):
            det = _ev(c, primary, split).get("detection")
            if det and (label.startswith("Baseline") or final is not base):
                cols.append((label, det))
        if cols:
            add(f"Detection statistics, primary model `{primary}`:")
            add("")
            L.extend(R.binary_table(cols))
            add("")
        add(f"- Label similarity (lexical, both-TRUE cases): baseline dev {_ev(base, primary).get('label_similarity')}, "
            f"final dev {_ev(final, primary).get('label_similarity')}")
        add("")
    else:
        items = (base["prompts"].get("rubric_items") or []) if base else []
        add(f"Rubric items, primary model `{primary}` (exact agreement / Gwet's AC1 / weighted κ):")
        add("")
        add("| Item | Baseline dev | Final dev | Baseline holdout | Final holdout |")
        add("|---|---|---|---|---|")
        for i, it in enumerate(items):
            key = f"rubric_{i + 1}"

            def cell(c, split):
                ev = _ev(c, primary, split)
                pi = (ev.get("per_item") or {}).get(key) or {}
                wk = ((ev.get("rubric_metrics") or {}).get(key) or {}).get("weighted_kappa")
                return f"{R.pct(pi.get('agreement'))} / {R.num(pi.get('ac1'), 2)} / {R.num(wk, 2)}" if pi else "—"
            add(f"| {it.get('title') or key} | {cell(base, 'dev')} | {cell(final, 'dev')} | {cell(base, 'holdout')} | {cell(final, 'holdout')} |")
        add("")
        add(f"- Within ±1 (all items): baseline dev {R.pct(_ev(base, primary).get('within_one'))}, final dev {R.pct(_ev(final, primary).get('within_one'))}")
        add("")

    # 7. Calibration context
    add("## 7. Calibration context")
    oc = job.get("overfit_check") or {}
    add(f"- Noise floor (run-to-run self-agreement): {R.pct(job.get('noise_floor'))}")
    add(f"- Rater ceiling (intra-rater agreement): {R.pct(job.get('rater_ceiling'))}")
    add(f"- Development − holdout gap: baseline {R.pp(oc.get('baseline_gap'))}, final {R.pp(oc.get('best_gap'))}"
        + (" — flagged OVERFITTING" if job.get("final_state") == "OVERFITTING" else ""))
    add(f"- Holdout looks: {len(job.get('holdout_evaluations', []))}")
    add("")

    # 8. Reproducibility and compute
    add("## 8. Reproducibility, environment and compute")
    rc = None
    for c in [base] + evaluated:
        if c:
            rc = _ev(c, primary).get("run_conditions")
            if rc and not rc.get("error"):
                break
    if rc:
        L.extend(R.conditions_lines({**rc, "execution": job.get("execution") or rc.get("execution"),
                                     "parallel_slots": cfg.get("parallel_slots", 1)}))
    add(f"- Seeds: split {sp['seed']}; bootstrap 20260911 (2,000 resamples); optimizer proposal seeds recorded per candidate")
    t = job.get("timing", {})
    add(f"- Compute: started {t.get('started_at', 'n/a')}, finished {t.get('finished_at', 'n/a')}; ≈{t.get('approx_llm_calls', 'n/a')} model calls "
        f"at ≈{t.get('seconds_per_call', 'n/a')} s/call (evaluation calls; optimizer calls in candidate files)")
    add("")

    # 9. Reporting points
    add("## 9. Reporting points")
    add("Bullet arguments supported by the numbers above, for the author to use, adapt or discard:")
    add("")
    if final is base:
        add("- No revision produced a reliable improvement over the baseline prompt within the search budget — the original prompt is retained; this is itself a reportable calibration result")
    else:
        if dev_delta:
            add(f"- Development agreement rose from {R.pct(_ev(base, primary).get('primary'))} to {R.pct(_ev(final, primary).get('primary'))} "
                f"({R.pp(dev_delta[0])}, paired 95% CI {R.ci(dev_delta[1:])}); {len(dev_flips['fixed'])} cases fixed, {len(dev_flips['broke'])} broken")
        if hold_delta:
            add(f"- Holdout (never seen by the optimizer): {R.pct(_ev(base, primary, 'holdout').get('primary'))} → {R.pct(_ev(final, primary, 'holdout').get('primary'))} "
                f"({R.pp(hold_delta[0])}, 95% CI {R.ci(hold_delta[1:])}, n = {n_hold}) — this, not the development figure, is the generalisation estimate")
            if hold_delta[1] is not None and hold_delta[1] <= 0:
                add("- The holdout CI includes zero: the gain is not demonstrated on unseen cases at this n — report the development gain as optimistic")
        add(f"- {len(promoted_ids)} revision(s) were promoted across {job.get('rounds_completed', 0)} round(s) out of {total_props} proposals — report the number of candidates examined, since selection among many inflates the development figure")
    if job.get("noise_floor") is not None:
        add(f"- Measured noise floor {R.pct(job['noise_floor'])}: " + ("runs were fully reproducible, so differences between prompts are not run-to-run variation"
                                                                      if job["noise_floor"] >= 0.999 else "some run-to-run variation exists; only gains above it were accepted"))
    if job.get("rater_ceiling") is not None:
        fd = _ev(final, primary).get("primary")
        add(f"- Rater ceiling {R.pct(job['rater_ceiling'])}: " + ("final agreement reached the coder's own consistency — further gains would fit noise in the reference standard"
                                                                 if fd is not None and fd >= job["rater_ceiling"] else "final agreement remains below the coder's own consistency"))
    if cov.get("baseline"):
        add(f"- Revisions were grounded in human rationales: {(cov.get('after_pause') or cov['baseline'])['with_rationale']} of the baseline disagreements carried one; "
            "each promoted revision lists the cases and rationales it cited (§5)")
    if any(not a["verbatim"] for _, a in applied):
        add("- The applied prompt was edited by the author after model proposal: describe it as LLM-assisted prompt engineering, not fully automated optimization")
    elif applied:
        add("- The applied prompt was used exactly as proposed: describe it as automated (model-proposed) prompt revision with human approval")
    add("- Agreement is with one coder on a sample; templates and thresholds were held fixed, so effects are attributable to block-prompt wording")
    add("")

    add("## 10. Threats to validity (for the limitations section)")
    for t_ in ("Single human rater: agreement is with one person's judgement, not a consensus standard",
               f"Small samples (development n = {n_dev}, holdout n = {n_hold}): intervals are wide",
               "Selection on the development split inflates development agreement; the holdout bounds this only while rarely examined",
               "Rationales written after seeing model output may be anchored to it (counted in §2)",
               "Revisions are authored by a language model (optimizer circularity); a different optimizer family reduces correlated blind spots but not overfitting",
               "Results hold for the sampled cases and the recorded model/settings only"):
        add(f"- {t_}")
    add("")
    add("## 11. What to report — checklist")
    for item in ("Corpus, unit of analysis, sample and split sizes (§1)",
                 "Reference standard: coder, rationale practice, intra-rater reliability (§2)",
                 "Procedure: models, optimizer, budget, selection and stopping rules, what was held fixed (§3)",
                 "Number of rounds, proposals and promotions; stop reason (§4)",
                 "What changed and why, and whether the applied prompt was edited (§5)",
                 "Baseline and final agreement on development and holdout with paired CIs (§6, headline table)",
                 "Noise floor, rater ceiling, overfitting check (§7)",
                 "Model, settings, hardware, seeds, compute (§8)",
                 "Full final prompt text (§5) and prompt structure (Appendix)"):
        add(f"- [ ] {item}")
    add("")
    add("## Appendix: prompt structure")
    L.extend(R.skeleton_lines(job.get("prompt_skeleton"), final["prompts"] if final else None))
    add("")
    add("## References")
    L.extend(R.references_lines())
    return "\n".join(L) + "\n"


def write_report(pid, job_id):
    import json
    from services.optimization_job import load_job, load_candidates, _job_dir
    job = load_job(pid, job_id)
    title = ""
    try:
        with open(os.path.join(PROJECTS_DIR, pid, "project.json"), "r", encoding="utf-8") as f:
            title = json.load(f).get("title", "")
    except (OSError, ValueError):
        pass
    text = build_report(job, load_candidates(pid, job_id), title)
    path = os.path.join(_job_dir(pid, job_id), "report.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text
