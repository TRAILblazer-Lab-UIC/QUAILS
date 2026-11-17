"""Agreement statistics for alignment optimization (pure Python, no numpy/scipy).

Ported from the psychpaper calibration harness (`local/harness/metrics.py`) and
generalised from binary to multi-category labels. Used by the prompt
optimization job (optimization_job.py) to decide whether a candidate prompt is
a genuine improvement or run-to-run noise.

Run `python -m services.agreement_stats` for the self-test.
"""

import random
from collections import Counter

BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 20260911
KAPPA_CI_WIDTH_NOT_DECISION_GRADE = 0.40
MAX_DEGENERATE_RESAMPLE_FRACTION = 0.20
MAX_PREVALENCE_FOR_KAPPA_BAND = 0.70
PLATEAU_AFTER = 2
OVERFIT_GAP = 0.10


# ---------------------------------------------------------------------------
# Point statistics over (human, model) pairs of category values
# ---------------------------------------------------------------------------

def raw_agreement(pairs):
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    if not pairs:
        return None
    return sum(1 for h, m in pairs if h == m) / len(pairs)


def cohens_kappa(pairs):
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    n = len(pairs)
    if n == 0:
        return None
    p0 = sum(1 for h, m in pairs if h == m) / n
    hc, mc = Counter(h for h, _ in pairs), Counter(m for _, m in pairs)
    pe = sum(hc[k] * mc[k] for k in set(hc) | set(mc)) / (n * n)
    if pe >= 1:
        return 1.0 if p0 == 1 else 0.0
    return (p0 - pe) / (1 - pe)


def gwet_ac1(pairs):
    """Gwet's AC1, multi-category form: pe = Σ πk(1−πk) / (K−1)."""
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    n = len(pairs)
    if n == 0:
        return None
    p0 = sum(1 for h, m in pairs if h == m) / n
    cats = sorted({c for p in pairs for c in p}, key=str)
    k = max(len(cats), 2)
    counts = Counter(c for p in pairs for c in p)
    pe = sum((counts[c] / (2 * n)) * (1 - counts[c] / (2 * n)) for c in cats) / (k - 1)
    if pe >= 1:
        return 1.0 if p0 == 1 else 0.0
    return (p0 - pe) / (1 - pe)


def pabak(pairs, k=None):
    """Prevalence- and bias-adjusted kappa, k-category: (k·p0 − 1)/(k − 1)."""
    p0 = raw_agreement(pairs)
    if p0 is None:
        return None
    if k is None:
        k = max(len({c for p in pairs for c in p if c is not None}), 2)
    return (k * p0 - 1) / (k - 1)


def binary_cells(pairs, positive="TRUE"):
    a = b = c = d = 0
    for h, m in pairs:
        if h is None or m is None:
            continue
        hp, mp = h == positive, m == positive
        if hp and mp:
            a += 1
        elif hp:
            b += 1
        elif mp:
            c += 1
        else:
            d += 1
    return a, b, c, d


def missed_positive_rate(pairs, positive="TRUE"):
    """Share of human-positive cases the model called negative (analogue of FER)."""
    a, b, _, _ = binary_cells(pairs, positive)
    return b / (a + b) if (a + b) else None


def false_positive_rate(pairs, positive="TRUE"):
    _, _, c, d = binary_cells(pairs, positive)
    return c / (c + d) if (c + d) else None


def prevalence_index(pairs, positive="TRUE"):
    a, b, c, d = binary_cells(pairs, positive)
    n = a + b + c + d
    return abs(a - d) / n if n else None


def bias_index(pairs, positive="TRUE"):
    a, b, c, d = binary_cells(pairs, positive)
    n = a + b + c + d
    return abs(b - c) / n if n else None


def self_agreement(a, b):
    """Agreement between two runs/passes keyed by the same ids: {id: value}."""
    ids = [i for i in a if i in b and a[i] is not None and b[i] is not None]
    if not ids:
        return None
    return sum(1 for i in ids if a[i] == b[i]) / len(ids)


# ---------------------------------------------------------------------------
# Interval estimation
# ---------------------------------------------------------------------------

def bootstrap_ci(pairs, stat_fn, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED, alpha=0.05):
    """Percentile bootstrap. Returns (lo, hi, n_degenerate). Undefined or
    single-category resamples are discarded and counted, never coerced to 0."""
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    if len(pairs) < 2:
        return None, None, 0
    rng = random.Random(seed)
    vals, degenerate = [], 0
    for _ in range(resamples):
        s = [pairs[rng.randrange(len(pairs))] for _ in pairs]
        if len({c for p in s for c in p}) < 2:
            degenerate += 1
            continue
        v = stat_fn(s)
        if v is None:
            degenerate += 1
            continue
        vals.append(v)
    if len(vals) < 20:
        return None, None, degenerate
    vals.sort()
    lo = vals[int((alpha / 2) * (len(vals) - 1))]
    hi = vals[int((1 - alpha / 2) * (len(vals) - 1))]
    return lo, hi, degenerate


def paired_delta_ci(correct_old, correct_new, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED):
    """Paired bootstrap on per-case correctness (values in [0, 1]; fractional OK
    for rubric blocks). Inputs: {id: correctness}. Returns (delta, lo, hi) or None."""
    ids = [i for i in correct_old if i in correct_new]
    if len(ids) < 2:
        return None
    diffs = [correct_new[i] - correct_old[i] for i in ids]
    point = sum(diffs) / len(diffs)
    rng = random.Random(seed)
    means = []
    for _ in range(resamples):
        s = [diffs[rng.randrange(len(diffs))] for _ in diffs]
        means.append(sum(s) / len(s))
    means.sort()
    return point, means[int(0.025 * (len(means) - 1))], means[int(0.975 * (len(means) - 1))]


def mean_ci(values, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED):
    """Percentile bootstrap CI of a mean (e.g. per-case correctness). Returns (lo, hi)."""
    values = [v for v in values if v is not None]
    if len(values) < 2:
        return None, None
    rng = random.Random(seed)
    means = sorted(sum(values[rng.randrange(len(values))] for _ in values) / len(values)
                   for _ in range(resamples))
    return means[int(0.025 * (resamples - 1))], means[int(0.975 * (resamples - 1))]


def flip_table(correct_old, correct_new):
    """Which cases moved wrong→right / right→wrong. Correctness ≥ 0.5 counts as right."""
    fixed, broke, uc, uw = [], [], 0, 0
    for i in correct_old:
        if i not in correct_new:
            continue
        o, n = correct_old[i] >= 0.5, correct_new[i] >= 0.5
        if not o and n:
            fixed.append(i)
        elif o and not n:
            broke.append(i)
        elif o:
            uc += 1
        else:
            uw += 1
    return {"fixed": fixed, "broke": broke, "unchanged_correct": uc,
            "unchanged_wrong": uw, "net": len(fixed) - len(broke)}


# ---------------------------------------------------------------------------
# Summary + selection
# ---------------------------------------------------------------------------

def summarize_binary(pairs, positive="TRUE"):
    """Full agreement summary for a TRUE/FALSE decision, with suppression flags."""
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    n = len(pairs)
    out = {
        "n": n,
        "agreement": raw_agreement(pairs),
        "kappa": cohens_kappa(pairs),
        "ac1": gwet_ac1(pairs),
        "pabak": pabak(pairs, 2),
        "missed_positive_rate": missed_positive_rate(pairs, positive),
        "false_positive_rate": false_positive_rate(pairs, positive),
        "prevalence_index": prevalence_index(pairs, positive),
        "bias_index": bias_index(pairs, positive),
        "cells": dict(zip("abcd", binary_cells(pairs, positive))),
    }
    lo, hi, deg = bootstrap_ci(pairs, raw_agreement)
    out["agreement_ci"] = [lo, hi]
    klo, khi, kdeg = bootstrap_ci(pairs, cohens_kappa)
    out["kappa_ci"] = [klo, khi]
    width = (khi - klo) if klo is not None else None
    deg_frac = kdeg / BOOTSTRAP_RESAMPLES
    out["kappa_decision_grade"] = width is not None and width <= KAPPA_CI_WIDTH_NOT_DECISION_GRADE \
        and deg_frac <= MAX_DEGENERATE_RESAMPLE_FRACTION
    single_category = len({h for h, _ in pairs}) < 2 or len({m for _, m in pairs}) < 2
    if single_category:
        out["kappa_decision_grade"] = False
    pi = out["prevalence_index"]
    out["kappa_interpretable"] = pi is not None and pi <= MAX_PREVALENCE_FOR_KAPPA_BAND
    notes = []
    if single_category and n:
        notes.append("One rater used a single category: kappa is fixed at 0 (or undefined) by construction and carries no information.")
    if not out["kappa_decision_grade"]:
        notes.append("Kappa interval is too wide or too many resamples were single-category; do not read a verbal band into it.")
    if not out["kappa_interpretable"]:
        notes.append("One category dominates (prevalence index > 0.70); kappa is pinned by the marginals — read AC1/PABAK instead.")
    if (pi or 0) >= 0.7 and (out["agreement"] or 0) >= 0.8 and (out["kappa"] or 0) < 0.4:
        notes.append("Kappa paradox: high raw agreement with low kappa caused by skewed prevalence.")
    out["notes"] = notes
    return out


def convergence_state(delta, ci_lo, ci_hi, noise_floor, rater_ceiling, dev_agreement,
                      prior_nonsig, gap_history=None):
    """Classify a candidate vs its parent (ported order: ceiling, overfit, data, regress, improve, plateau).

    noise_floor is self-agreement (0-1); the run-to-run disagreement rate is 1 - noise_floor.
    gap_history is a list of dev−holdout gaps for successive versions (may be empty).
    """
    gaps = gap_history or []
    if rater_ceiling is not None and dev_agreement is not None and dev_agreement >= rater_ceiling:
        return "AT-RATER-CEILING", False
    if len(gaps) >= 3 and gaps[-1] > gaps[-2] > gaps[-3] and gaps[-1] > OVERFIT_GAP:
        return "OVERFITTING", False
    if delta is None or ci_lo is None:
        return "INSUFFICIENT-DATA", False
    excludes_zero = ci_lo > 0 or ci_hi < 0
    if excludes_zero and delta < 0:
        return "REGRESSING", False
    noise_ok = noise_floor is None or abs(delta) > (1 - noise_floor)
    if excludes_zero and delta > 0 and noise_ok:
        return "IMPROVING", True
    if prior_nonsig + 1 >= PLATEAU_AFTER:
        return "PLATEAU", False
    return "NOT-SIGNIFICANT", False


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _selftest():
    checks = 0

    def ok(cond, msg):
        nonlocal checks
        assert cond, msg
        checks += 1

    def approx(a, b, tol=1e-9):
        return a is not None and abs(a - b) < tol

    # Hand-computed 2x2: a=20 b=5 c=10 d=15 (n=50)
    pairs = [("TRUE", "TRUE")] * 20 + [("TRUE", "FALSE")] * 5 + [("FALSE", "TRUE")] * 10 + [("FALSE", "FALSE")] * 15
    ok(approx(raw_agreement(pairs), 0.70), "p0")
    # pe = (25*30 + 25*20)/2500 = 0.5 -> kappa = 0.4
    ok(approx(cohens_kappa(pairs), 0.4), "kappa")
    ok(approx(pabak(pairs, 2), 0.4), "pabak")
    ok(approx(missed_positive_rate(pairs), 5 / 25), "missed-positive")
    ok(approx(false_positive_rate(pairs), 10 / 25), "false-positive")
    ok(approx(prevalence_index(pairs), 5 / 50), "PI")
    ok(approx(bias_index(pairs), 5 / 50), "BI")
    # AC1: pi_true = (25+30)/100 = .55 ; pe = 2*.55*.45 = .495 (K=2) ; (0.7-.495)/(.505)
    ok(approx(gwet_ac1(pairs), (0.7 - 0.495) / 0.505), "AC1")

    # Kappa paradox: 28/30 agree, all on TRUE, 2 human TRUE model FALSE
    par = [("TRUE", "TRUE")] * 28 + [("TRUE", "FALSE")] * 2
    ok(approx(raw_agreement(par), 28 / 30), "paradox p0")
    ok(approx(cohens_kappa(par), 0.0), "paradox kappa = 0")
    s = summarize_binary(par)
    ok(not s["kappa_interpretable"], "paradox flagged uninterpretable")
    ok(any("paradox" in n.lower() for n in s["notes"]), "paradox note")
    ok(gwet_ac1(par) > 0.9, "AC1 high under paradox")

    # Multi-category AC1 with perfect agreement = 1
    ok(approx(gwet_ac1([("1", "1"), ("2", "2"), ("3", "3")]), 1.0), "AC1 perfect multi")
    ok(approx(pabak([("1", "1"), ("2", "3")], 3), (3 * 0.5 - 1) / 2), "pabak k=3")

    # Bootstrap reproducible + degenerate counting
    lo1, hi1, _ = bootstrap_ci(pairs, raw_agreement)
    lo2, hi2, _ = bootstrap_ci(pairs, raw_agreement)
    ok(lo1 == lo2 and hi1 == hi2 and lo1 < 0.7 < hi1, "bootstrap reproducible, brackets p0")
    _, _, deg = bootstrap_ci([("TRUE", "TRUE")] * 9 + [("FALSE", "FALSE")], raw_agreement)
    ok(deg > 0, "degenerate resamples counted")

    # Paired delta: 10 fixed out of 40, none broken -> +0.25, CI excludes zero
    old = {i: (1 if i >= 10 else 0) for i in range(40)}
    new = {i: 1 for i in range(40)}
    d, lo, hi = paired_delta_ci(old, new)
    ok(approx(d, 0.25) and lo > 0, "paired delta improving")
    ft = flip_table(old, new)
    ok(len(ft["fixed"]) == 10 and ft["broke"] == [] and ft["net"] == 10, "flip table")
    ok(paired_delta_ci({1: 1}, {1: 0}) is None, "paired needs >=2")

    # Convergence states
    ok(convergence_state(0.25, 0.1, 0.4, 1.0, None, 0.8, 0)[0] == "IMPROVING", "improving")
    ok(convergence_state(0.25, 0.1, 0.4, 0.70, None, 0.8, 0)[0] == "NOT-SIGNIFICANT", "gain within noise not improving")
    ok(convergence_state(-0.2, -0.4, -0.05, 1.0, None, 0.6, 0)[0] == "REGRESSING", "regressing")
    ok(convergence_state(0.02, -0.1, 0.1, 1.0, None, 0.7, 1)[0] == "PLATEAU", "plateau after 2")
    ok(convergence_state(0.2, 0.1, 0.3, 1.0, 0.85, 0.9, 0)[0] == "AT-RATER-CEILING", "ceiling precedence")
    ok(convergence_state(0.2, 0.1, 0.3, 1.0, None, 0.9, 0, [0.05, 0.08, 0.15])[0] == "OVERFITTING", "overfitting")
    ok(convergence_state(None, None, None, 1.0, None, 0.5, 0)[0] == "INSUFFICIENT-DATA", "insufficient")

    mlo, mhi = mean_ci([1, 0, 1, 1, 0.5, 1, 0, 1])
    ok(mlo is not None and mlo < 0.6875 < mhi, "mean CI brackets mean")
    ok(approx(self_agreement({1: "a", 2: "b"}, {1: "a", 2: "c", 3: "x"}), 0.5), "self agreement")
    print(f"agreement_stats self-test: {checks}/{checks} checks passed")


if __name__ == "__main__":
    _selftest()
