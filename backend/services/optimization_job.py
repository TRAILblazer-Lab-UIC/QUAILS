"""Automated prompt optimization for alignment (open-coding + rubric blocks).

Protocol (see alignment_optimizer_method.md; ported from the psychpaper harness):
  1. Freeze a dev/holdout split of a human-coded alignment test.
  2. Evaluate the block's current prompts (baseline) on dev, for every chosen model.
  3. Optionally replicate the baseline once → measured noise floor.
  4. Optionally pause so the human can add rationales to baseline disagreements.
  5. Rounds: an optimizer model reads dev disagreements + human rationales,
     proposes K revisions (different focuses), each is evaluated on dev; the best
     replaces the parent only if its paired-bootstrap gain excludes zero and
     exceeds the noise floor. Stops on plateau / rater ceiling / budget.
  6. Evaluate the shortlist on the holdout once; flag overfitting.
  7. Write report.md. Nothing changes the live block until a human applies a candidate.

Judging reuses alignment_runner._run_source_alignment / _run_rubric_alignment,
i.e. the exact code path of a manual "Run Alignment Comparison".
"""

import hashlib
import json
import os
import random
import secrets
import threading
import time
from datetime import datetime, timezone

from config import PROJECTS_DIR, OLLAMA_BASE_URL

SUPPORTED_TYPES = ("sourceAnalysis", "rubricAnalysis")
DEFAULTS = {
    "rounds": 5,
    "candidates_per_round": 3,
    "holdout_pct": 30,
    "noise_floor": True,
    "pause_for_rationales": True,
    "proposal_temperature": 0.7,
    "optimizer_num_ctx": 16384,
    "split_seed": 20260911,
    "parallel_slots": 1,     # opt-in Throughput mode (cases in flight at once); 1 = replicable
}
MIN_LABELED = 10
DEFAULT_SEC_PER_CALL = 2.0

_running = {}        # project_id -> job_id
_stop = {}           # job_id -> bool
_resume = {}         # job_id -> threading.Event
_lock = threading.Lock()


class _QuietSocket:
    """Swallows the runner's per-unit log/progress events (the job emits its own)."""
    def emit(self, *a, **k):
        pass


def _now():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def _jobs_root(pid):
    return os.path.join(PROJECTS_DIR, pid, "alignment", "optimizations")


def _job_dir(pid, job_id):
    return os.path.join(_jobs_root(pid), job_id)


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_job(pid, job_id):
    path = os.path.join(_job_dir(pid, job_id), "job.json")
    if not os.path.exists(path):
        return None
    return _read_json(path)


def save_job(job):
    _write_json(os.path.join(_job_dir(job["project_id"], job["job_id"]), "job.json"), job)


def load_candidates(pid, job_id):
    cdir = os.path.join(_job_dir(pid, job_id), "candidates")
    if not os.path.isdir(cdir):
        return []
    return [_read_json(os.path.join(cdir, f)) for f in sorted(os.listdir(cdir)) if f.endswith(".json")]


def save_candidate(job, cand):
    _write_json(os.path.join(_job_dir(job["project_id"], job["job_id"]), "candidates", f"{cand['id']}.json"), cand)


def _event(job, message, level="info", socketio=None):
    entry = {"at": _now(), "level": level, "message": message}
    path = os.path.join(_job_dir(job["project_id"], job["job_id"]), "events.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    if socketio is not None:
        from services.socket_logger import emit_log
        emit_log(socketio, f"[Optimize] {message}", level, job["project_id"])


def list_jobs(pid, block_id=None):
    root = _jobs_root(pid)
    if not os.path.isdir(root):
        return []
    out = []
    for jid in sorted(os.listdir(root), reverse=True):
        job = load_job(pid, jid)
        if not job or (block_id and job.get("block_id") != block_id):
            continue
        out.append({k: job.get(k) for k in (
            "job_id", "block_id", "block_label", "test_id", "status", "created_at",
            "stop_reason", "final_state", "best_candidate_id", "rounds_completed")} | {
            "eval_models": job["config"].get("eval_models"),
            "optimizer_model": job["config"].get("optimizer_model")})
    return out


# ---------------------------------------------------------------------------
# Job creation
# ---------------------------------------------------------------------------

def _human_code(block_type, label):
    """The part of a human label that is the reference standard (codes only)."""
    if not isinstance(label, dict):
        return None
    if block_type == "sourceAnalysis":
        det = (label.get("detection") or "").upper()
        if det not in ("TRUE", "FALSE"):
            return None
        return {"detection": det, "labels": label.get("labels") or []}
    scores = {k: v for k, v in (label.get("rubric_scores") or {}).items() if v not in (None, "")}
    return {"rubric_scores": scores} if scores else None


def _stratum(block_type, code):
    if block_type == "sourceAnalysis":
        return code["detection"]
    return str(code["rubric_scores"].get("rubric_1", "∅"))


def split_cases(ids_by_stratum, holdout_pct, seed):
    """Stratified dev/holdout split with a global top-up so the holdout is never
    silently empty (round(1 × 0.30) = 0 in every thin stratum)."""
    rng = random.Random(seed)
    dev, hold = [], []
    for stratum in sorted(ids_by_stratum):
        ids = sorted(ids_by_stratum[stratum])
        rng.shuffle(ids)
        k = round(len(ids) * holdout_pct / 100)
        hold += ids[:k]
        dev += ids[k:]
    n = len(dev) + len(hold)
    target = min(max(1, round(n * holdout_pct / 100)), n - 1)
    by_size = sorted(ids_by_stratum, key=lambda s: -len(ids_by_stratum[s]))
    while len(hold) < target:
        moved = False
        for s in by_size:
            cand = [i for i in dev if i in ids_by_stratum[s]]
            if cand and len(dev) > 1:
                dev.remove(cand[0])
                hold.append(cand[0])
                moved = True
                break
        if not moved:
            break
    while len(hold) > target:
        dev.append(hold.pop())
    return sorted(dev), sorted(hold)


def _baseline_prompts(block_type, data):
    if block_type == "sourceAnalysis":
        prompts = {"detection_prompt": data.get("detection_prompt", ""),
                   "label_prompt": data.get("label_prompt", "")}
        fixed = {"detection_threshold": float(data.get("detection_threshold") or 70.0),
                 "label_threshold": float(data.get("label_threshold") or 70.0)}
    else:
        prompts = {"rubric_items": data.get("rubric_items", [])}
        fixed = {"label_threshold": float(data.get("label_threshold") or 70.0)}
    return prompts, fixed


def create_job(pid, block_id, test_id, config):
    from services.alignment_service import get_test, _get_block

    test = get_test(pid, test_id)
    if "error" in test:
        return {"error": test["error"]}
    block_type = test.get("block_type")
    if block_type not in SUPPORTED_TYPES:
        return {"error": "Automated optimization supports Open-Coding and Rubric blocks only."}
    if test.get("block_id") != block_id:
        return {"error": "That test belongs to a different block."}

    codes = {}
    for uid, label in (test.get("human_labels") or {}).items():
        c = _human_code(block_type, label)
        if c:
            codes[uid] = c
    sample_ids = {u["unit_id"] for u in test.get("sample_units", [])}
    codes = {u: c for u, c in codes.items() if u in sample_ids}
    if len(codes) < MIN_LABELED:
        return {"error": f"Need at least {MIN_LABELED} human-coded cases in this test (found {len(codes)})."}

    cfg = {**DEFAULTS, **{k: v for k, v in (config or {}).items() if v is not None}}
    models = [m for m in (cfg.get("eval_models") or []) if m]
    if not models:
        return {"error": "Choose at least one model to evaluate."}
    if not cfg.get("optimizer_model"):
        return {"error": "Choose an optimizer model."}
    cfg["eval_models"] = models
    cfg["rounds"] = max(1, min(int(cfg["rounds"]), 20))
    cfg["candidates_per_round"] = max(1, min(int(cfg["candidates_per_round"]), 6))
    cfg["holdout_pct"] = max(10, min(int(cfg["holdout_pct"]), 50))
    cfg["parallel_slots"] = max(1, min(int(cfg.get("parallel_slots") or 1), 8))
    # Optimizer context: never smaller than the evaluation context, so a model used in
    # both roles is never reloaded at a different num_ctx mid-job.
    try:
        env_ctx = int(os.environ.get("OLLAMA_NUM_CTX", "") or 0)
    except ValueError:
        env_ctx = 0
    cfg["optimizer_num_ctx"] = max(int(cfg["optimizer_num_ctx"]), env_ctx)

    strata = {}
    for uid, c in codes.items():
        strata.setdefault(_stratum(block_type, c), []).append(uid)
    dev, hold = split_cases(strata, cfg["holdout_pct"], cfg["split_seed"])

    _, block_data = _get_block(pid, block_id)
    if block_data is None:
        return {"error": f"Block {block_id} not found in the flow."}
    prompts, fixed = _baseline_prompts(block_type, block_data)

    rel = (test.get("reliability") or {}).get("computed") or {}
    cases_blob = json.dumps(sorted(test.get("sample_units", []), key=lambda u: u["unit_id"]), sort_keys=True)

    job_id = "opt_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + "_" + secrets.token_hex(2)
    job = {
        "job_id": job_id,
        "project_id": pid,
        "block_id": block_id,
        "block_type": block_type,
        "block_label": block_data.get("label") or block_id,
        "test_id": test_id,
        "created_at": _now(),
        "config": cfg,
        "split": {"dev_ids": dev, "holdout_ids": hold, "seed": cfg["split_seed"],
                  "strata": {s: len(v) for s, v in strata.items()}},
        "human_codes": codes,
        "cases_sha256": hashlib.sha256(cases_blob.encode("utf-8")).hexdigest(),
        "baseline_prompts": prompts,
        "fixed_settings": fixed,
        "unit_type": (test.get("source_config") or {}).get("unit_type") or block_data.get("unit_type") or "sentence",
        "rater_ceiling": rel.get("self_agreement"),
        "rater_ceiling_n": rel.get("n"),
        "status": "created",
        "noise_floor": None,
        "holdout_evaluations": [],
        "rounds_completed": 0,
        "parent_chain": [],
        "rationale_coverage": None,
        "timing": {},
    }
    save_job(job)
    return job


def estimate(pid, test_id, config):
    """Rough call count and duration before starting."""
    from services.alignment_service import get_test
    test = get_test(pid, test_id)
    if "error" in test:
        return test
    bt = test.get("block_type")
    cfg = {**DEFAULTS, **{k: v for k, v in (config or {}).items() if v is not None}}
    codes = {u: _human_code(bt, l) for u, l in (test.get("human_labels") or {}).items()}
    codes = {u: c for u, c in codes.items() if c}
    n = len(codes)
    n_hold = round(n * int(cfg["holdout_pct"]) / 100) if n else 0
    n_dev = n - n_hold
    models = max(1, len(cfg.get("eval_models") or []))
    if bt == "sourceAnalysis":
        true_rate = (sum(1 for c in codes.values() if c["detection"] == "TRUE") / n) if n else 0.5
        per_unit = 2 + 2 * true_rate
    else:
        per_unit = max(1, len((test.get("prompts_snapshot") or {}).get("rubric_items") or []) or 3)
    rounds, k = int(cfg["rounds"]), int(cfg["candidates_per_round"])
    dev_evals = models * (1 + rounds * k) + (1 if cfg.get("noise_floor") else 0)
    hold_evals = 2 * models + max(0, models - 1)
    calls = int(per_unit * (dev_evals * n_dev + hold_evals * n_hold) + rounds * k)
    return {"labeled_cases": n, "dev_cases": n_dev, "holdout_cases": n_hold,
            "max_llm_calls": calls, "est_minutes": round(calls * DEFAULT_SEC_PER_CALL / 60, 1),
            "assumed_seconds_per_call": DEFAULT_SEC_PER_CALL,
            "note": "Upper bound: the job usually stops early on plateau. Time per call depends on your hardware and model size."}


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def _correctness(job, uid, result, rubric_items):
    code = job["human_codes"].get(uid)
    if code is None or result is None:
        return None, None
    from services.prompt_optimizer import scores_equal, scores_within_one
    if job["block_type"] == "sourceAnalysis":
        return (1.0 if (result.get("detection") or "").upper() == code["detection"] else 0.0), None
    exact, within = [], []
    for idx in range(len(rubric_items)):
        key = f"rubric_{idx + 1}"
        hv = code["rubric_scores"].get(key)
        if hv in (None, ""):
            continue
        mv = (result.get("rubric_scores") or {}).get(key, "")
        exact.append(1.0 if scores_equal(hv, mv) else 0.0)
        within.append(1.0 if scores_within_one(hv, mv) else 0.0)
    if not exact:
        return None, None
    return sum(exact) / len(exact), sum(within) / len(within)


def _summarize(job, ids, llm_results, rubric_items):
    from services import agreement_stats as st
    from services.alignment_service import compute_label_similarity, compute_rubric_metrics
    correct, tie_vals = {}, {}
    for uid in ids:
        c, t = _correctness(job, uid, llm_results.get(uid), rubric_items)
        if c is not None:
            correct[uid] = c
            if t is not None:
                tie_vals[uid] = t
    primary = (sum(correct.values()) / len(correct)) if correct else None
    out = {"n": len(correct), "primary": primary, "correctness": correct}
    codes = {u: job["human_codes"][u] for u in ids if u in job["human_codes"]}

    if job["block_type"] == "sourceAnalysis":
        pairs = [(codes[u]["detection"], (llm_results[u].get("detection") or "").upper())
                 for u in ids if u in codes and u in llm_results]
        out["detection"] = st.summarize_binary(pairs)
        human_true = {u: {"labels": codes[u]["labels"]} for u in codes
                      if codes[u]["detection"] == "TRUE" and u in llm_results}
        sims = compute_label_similarity(human_true, llm_results) if human_true else {"mean_similarity": None, "per_unit": {}}
        out["label_similarity"] = sims.get("mean_similarity")
        out["tie_break"] = (sims.get("mean_similarity") or 0) / 100
        out["primary_ci"] = out["detection"]["agreement_ci"]
    else:
        out["within_one"] = (sum(tie_vals.values()) / len(tie_vals)) if tie_vals else None
        out["tie_break"] = out["within_one"] or 0
        hl = {u: {"rubric_scores": codes[u]["rubric_scores"]} for u in codes}
        out["rubric_metrics"] = compute_rubric_metrics(hl, {u: llm_results[u] for u in codes if u in llm_results}, rubric_items)
        per_item = {}
        for idx in range(len(rubric_items)):
            key = f"rubric_{idx + 1}"
            pairs = [(str(codes[u]["rubric_scores"].get(key)), str((llm_results[u].get("rubric_scores") or {}).get(key, "")))
                     for u in codes if u in llm_results and codes[u]["rubric_scores"].get(key) not in (None, "")]
            per_item[key] = {"n": len(pairs), "agreement": st.raw_agreement(pairs), "ac1": st.gwet_ac1(pairs)}
        out["per_item"] = per_item
        out["primary_ci"] = list(st.mean_ci(list(correct.values())))
    return out


class _Ctx:
    """Per-run shared state: templates/params fixed for the whole job."""
    def __init__(self, job, socketio):
        from services.alignment_runner import _load_model_params
        from services.alignment_service import get_test
        from services.prompt_template_service import get_effective_templates
        self.job = job
        self.socketio = socketio
        self.pid = job["project_id"]
        proj_dir = os.path.join(PROJECTS_DIR, self.pid)
        self.params = _load_model_params(proj_dir)
        with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
            self.base_url = (json.load(f).get("llm", {}) or {}).get("base_url", OLLAMA_BASE_URL)
        self.templates = get_effective_templates(self.pid)
        test = get_test(self.pid, job["test_id"])
        self.units = {u["unit_id"]: u for u in test.get("sample_units", [])}
        self.calls = 0
        self.call_seconds = 0.0
        self.evals_done = 0
        self.evals_planned = 1

    def client(self, model, **overrides):
        from services.ollama_client import OllamaClient
        p = {**self.params, **overrides}
        return OllamaClient(base_url=self.base_url, model=model,
                            temperature=p.get("temperature", 0), seed=p.get("seed", 5),
                            top_k=p.get("top_k", 3), top_p=p.get("top_p", 0.9),
                            repeat_penalty=p.get("repeat_penalty", 1.0))

    def stopped(self):
        return _stop.get(self.job["job_id"], False)

    def progress(self):
        from services.socket_logger import emit_progress
        emit_progress(self.socketio, f"optimize:{self.job['block_id']}", self.evals_done,
                      max(self.evals_planned, self.evals_done), self.pid)


def evaluate(ctx, cand, model, split, slot=None):
    """Run the candidate's prompts over one split with one model; store results on the candidate."""
    from services.alignment_runner import _run_source_alignment, _run_rubric_alignment
    from services.run_conditions import collect_run_conditions
    job = ctx.job
    ids = job["split"]["dev_ids"] if split == "dev" else job["split"]["holdout_ids"]
    units = [ctx.units[u] for u in ids if u in ctx.units]
    prompts = {**job["fixed_settings"], **cand["prompts"]}
    client = ctx.client(model)
    t0 = time.time()
    quiet = _QuietSocket()
    if job["block_type"] == "sourceAnalysis":
        prompts["rubric_items"] = None
        results = _run_source_alignment(client, units, prompts, ctx.templates, quiet, ctx.pid,
                                        job["block_id"], len(units), job["unit_type"], should_stop=ctx.stopped,
                                        workers=job["config"].get("parallel_slots", 1))
        rubric_items = []
    else:
        rubric_items = prompts.get("rubric_items", [])
        results = _run_rubric_alignment(client, units, prompts, rubric_items, ctx.templates, quiet, ctx.pid,
                                        job["block_id"], len(units), job["unit_type"], should_stop=ctx.stopped,
                                        workers=job["config"].get("parallel_slots", 1))
    elapsed = time.time() - t0
    summary = _summarize(job, ids, results, rubric_items)
    summary["llm_results"] = results
    summary["elapsed_sec"] = round(elapsed, 1)
    summary["evaluated_at"] = _now()
    summary["complete"] = len(results) == len(units)
    approx_calls = max(1, len(units) * (3 if job["block_type"] == "sourceAnalysis" else max(1, len(rubric_items))))
    ctx.calls += approx_calls
    ctx.call_seconds += elapsed
    try:
        summary["run_conditions"] = collect_run_conditions(
            ctx.pid, client, job["block_type"], {"prompts_snapshot": prompts}, ctx.templates, job["unit_type"])
        summary["run_conditions"].pop("prompt_skeleton", None)  # same for every candidate; kept once on the job
        summary["run_conditions"]["parallel_slots"] = job["config"].get("parallel_slots", 1)
    except Exception as e:  # never fail a job over reporting
        summary["run_conditions"] = {"error": str(e)}
    cand.setdefault("evaluations", {}).setdefault(model, {})[slot or split] = summary
    save_candidate(job, cand)
    ctx.evals_done += 1
    ctx.progress()
    return summary


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------

def _new_candidate(job, idx, round_no, parent_id, origin, prompts, **extra):
    cand = {"id": f"c{idx:03d}", "round": round_no, "parent_id": parent_id, "origin": origin,
            "created_at": _now(), "prompts": prompts, "evaluations": {}, "status": "proposed", **extra}
    save_candidate(job, cand)
    return cand


def _primary(cand, model, split="dev"):
    return ((cand.get("evaluations", {}).get(model) or {}).get(split) or {}).get("primary")


def _decisions(cand, model, slot):
    """Model decisions keyed for self-agreement (noise floor)."""
    ev = ((cand.get("evaluations", {}).get(model) or {}).get(slot) or {}).get("llm_results") or {}
    out = {}
    for uid, r in ev.items():
        if "detection" in r:
            out[uid] = (r.get("detection") or "").upper()
        else:
            for k, v in (r.get("rubric_scores") or {}).items():
                out[f"{uid}::{k}"] = str(v)
    return out


def _propose(ctx, parent, focus, seed, cand_idx, round_no):
    """One optimizer call → a validated candidate (or a recorded failure)."""
    from services import prompt_optimizer as po
    from services.alignment_service import get_test
    job = ctx.job
    primary_model = job["config"]["eval_models"][0]
    ev = (parent["evaluations"].get(primary_model) or {}).get("dev") or {}
    live_labels = get_test(ctx.pid, job["test_id"]).get("human_labels") or {}  # live: picks up new rationales
    rubric_items = parent["prompts"].get("rubric_items")
    dis, agr = po.gather_cases(job, live_labels, ctx.units, ev.get("llm_results") or {}, rubric_items)
    num_ctx = int(job["config"]["optimizer_num_ctx"])
    prompt, budget = po.build_optimizer_prompt(job, parent["prompts"], focus, dis, agr, num_ctx, rubric_items)

    client = ctx.client(job["config"]["optimizer_model"], temperature=job["config"]["proposal_temperature"], seed=seed)
    t0 = time.time()
    res = client.chat([{"role": "user", "content": prompt}], num_predict=2048, logprobs=False,
                      format=po.response_schema(job["block_type"]), options_override={"num_ctx": num_ctx})
    elapsed = round(time.time() - t0, 1)
    origin = f"optimizer:{job['config']['optimizer_model']} focus={focus}"
    common = {"focus": focus, "optimizer_seed": seed, "optimizer_prompt_budget": budget,
              "optimizer_elapsed_sec": elapsed, "raw_response": res.get("content") or res.get("error"),
              "optimizer_prompt_preview": prompt[:6000]}
    if res.get("error"):
        return _new_candidate(job, cand_idx, round_no, parent["id"], origin, parent["prompts"],
                              status="optimizer_error", error=res["error"], **common)
    proposal, notes = po.normalize_proposal(res.get("content"), job["block_type"], job["split"]["dev_ids"])
    if not proposal:
        return _new_candidate(job, cand_idx, round_no, parent["id"], origin, parent["prompts"],
                              status="unparseable", normalization_notes=notes, **common)
    prompts = po.apply_proposal(job["block_type"], parent["prompts"], proposal)
    problems = po.validate_candidate(job["block_type"], parent["prompts"], prompts)
    cited = sorted({u for h in proposal["hypotheses"] for u in h["evidence_unit_ids"]})
    return _new_candidate(job, cand_idx, round_no, parent["id"], origin, prompts,
                          status="invalid" if problems else "proposed", problems=problems,
                          hypotheses=proposal["hypotheses"], diagnosis=proposal["diagnosis"],
                          change_rationale=proposal["change_rationale"], optimizer_confidence=proposal["confidence"],
                          normalization_notes=notes, cited_unit_ids=cited,
                          cited_with_rationale=sum(1 for c in dis if c["unit_id"] in cited and c["human_rationale"]),
                          **common)


def baseline_disagreements(pid, job_id):
    """Dev disagreements of the baseline on the primary model (for 'Explain disagreements')."""
    from services import prompt_optimizer as po
    from services.alignment_service import get_test
    job = load_job(pid, job_id)
    if not job:
        return {"error": "Job not found"}
    cands = load_candidates(pid, job_id)
    base = next((c for c in cands if c["origin"] == "baseline"), None)
    if not base:
        return {"cases": []}
    model = job["config"]["eval_models"][0]
    ev = (base["evaluations"].get(model) or {}).get("dev") or {}
    test = get_test(pid, job["test_id"])
    units = {u["unit_id"]: u for u in test.get("sample_units", [])}
    dis, _ = po.gather_cases(job, test.get("human_labels") or {}, units, ev.get("llm_results") or {},
                             base["prompts"].get("rubric_items"))
    return {"cases": dis, "model": model, "block_type": job["block_type"]}


def _coverage(cases):
    n = len(cases)
    w = sum(1 for c in cases if c.get("human_rationale"))
    return {"disagreements": n, "with_rationale": w,
            "post_hoc": sum(1 for c in cases if c.get("human_rationale") and c.get("rationale_post_hoc"))}


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def start_job(pid, job_id):
    from services.analysis_engine import get_status
    with _lock:
        if _running.get(pid):
            return {"error": "An optimization job is already running for this project."}
        if get_status(pid).get("active"):
            return {"error": "An analysis run is in progress; wait for it to finish."}
        job = load_job(pid, job_id)
        if not job:
            return {"error": "Job not found"}
        _running[pid] = job_id
        _stop[job_id] = False
        _resume[job_id] = threading.Event()

    def _target():
        from extensions import socketio
        try:
            _run(pid, job_id, socketio)
        finally:
            with _lock:
                _running.pop(pid, None)
                _resume.pop(job_id, None)

    threading.Thread(target=_target, daemon=True).start()
    return {"status": "started", "job_id": job_id}


def stop_job(pid, job_id):
    _stop[job_id] = True
    ev = _resume.get(job_id)
    if ev:
        ev.set()
    return {"status": "stopping"}


def resume_job(pid, job_id):
    ev = _resume.get(job_id)
    if not ev:
        return {"error": "Job is not waiting."}
    ev.set()
    return {"status": "resumed"}


def running_job(pid):
    return _running.get(pid)


def _finish(job, ctx, socketio, status, reason=None):
    from services.optimization_report import write_report
    job["status"] = status
    if reason:
        job["stop_reason"] = reason
    job["timing"]["finished_at"] = _now()
    if ctx and ctx.calls:
        job["timing"]["seconds_per_call"] = round(ctx.call_seconds / ctx.calls, 2)
        job["timing"]["approx_llm_calls"] = ctx.calls
    save_job(job)
    try:
        write_report(job["project_id"], job["job_id"])
    except Exception as e:
        _event(job, f"Report generation failed: {e}", "warning", socketio)
    _event(job, f"Finished: {status}" + (f" — {reason}" if reason else ""), "info", socketio)
    socketio.emit("optimization_complete", {"project_id": job["project_id"], "job_id": job["job_id"],
                                            "status": status, "reason": reason})


def _run(pid, job_id, socketio):
    from services import agreement_stats as st
    from services.ollama_client import OllamaClient
    from services.prompt_optimizer import HoldoutLeak, choose_focuses, gather_cases
    from services.alignment_service import get_test
    from services.run_conditions import _skeleton

    job = load_job(pid, job_id)
    ctx = None
    try:
        job["status"] = "running"
        job["timing"]["started_at"] = _now()
        save_job(job)
        socketio.emit("optimization_started", {"project_id": pid, "job_id": job_id})
        cfg = job["config"]
        models = cfg["eval_models"]
        primary_model = models[0]

        # 1. Preflight
        probe = OllamaClient(base_url=OLLAMA_BASE_URL)
        ctx = _Ctx(job, socketio)
        probe.base_url = ctx.base_url
        if not probe.is_running():
            return _finish(job, ctx, socketio, "error", "Ollama is not running.")
        installed = {m.get("name") for m in probe.list_models()}
        installed |= {n.split(":")[0] for n in list(installed) if n and n.endswith(":latest")}
        missing = [m for m in models + [cfg["optimizer_model"]] if m not in installed]
        if missing:
            return _finish(job, ctx, socketio, "error", f"Model(s) not installed in Ollama: {', '.join(missing)}")

        for m in models:   # load each evaluated model once, at the evaluation num_ctx
            ctx.client(m).warm_model()
        from services.run_conditions import execution_environment
        job["execution"] = execution_environment(ctx.client(primary_model), cfg.get("parallel_slots", 1))
        rubric_items = job["baseline_prompts"].get("rubric_items")
        job["prompt_skeleton"] = _skeleton(job["block_type"], {**job["fixed_settings"], **job["baseline_prompts"]},
                                           ctx.templates, job["unit_type"])
        k = cfg["candidates_per_round"]
        ctx.evals_planned = len(models) * (1 + cfg["rounds"] * k) + (1 if cfg["noise_floor"] else 0) + 3 * len(models)
        _event(job, f"Started on {len(job['split']['dev_ids'])} dev / {len(job['split']['holdout_ids'])} holdout cases; "
                    f"models: {', '.join(models)}; optimizer: {cfg['optimizer_model']}", "info", socketio)

        # 2. Baseline
        cands = [_new_candidate(job, 0, 0, None, "baseline", job["baseline_prompts"], status="evaluated")]
        baseline = cands[0]
        for m in models:
            if ctx.stopped():
                return _finish(job, ctx, socketio, "stopped", "Stopped by user.")
            s = evaluate(ctx, baseline, m, "dev")
            _event(job, f"Baseline on {m}: dev agreement {_pct(s['primary'])}", "info", socketio)

        # 3. Noise floor
        if cfg["noise_floor"] and not ctx.stopped():
            evaluate(ctx, baseline, primary_model, "dev", slot="dev_replicate")
            job["noise_floor"] = st.self_agreement(_decisions(baseline, primary_model, "dev"),
                                                   _decisions(baseline, primary_model, "dev_replicate"))
            _event(job, f"Noise floor (baseline replicated on {primary_model}): self-agreement {_pct(job['noise_floor'])}",
                   "info", socketio)
        save_job(job)

        # 3b. Rationale coverage + optional pause
        test = get_test(pid, job["test_id"])
        dis, _ = gather_cases(job, test.get("human_labels") or {}, ctx.units,
                              baseline["evaluations"][primary_model]["dev"]["llm_results"], rubric_items)
        job["rationale_coverage"] = {"baseline": _coverage(dis)}
        save_job(job)
        missing_rat = sum(1 for c in dis if not c["human_rationale"])
        if cfg["pause_for_rationales"] and missing_rat and not ctx.stopped():
            job["status"] = "awaiting_rationales"
            save_job(job)
            _event(job, f"Paused: {missing_rat} of {len(dis)} baseline disagreements have no human rationale. "
                        "Add rationales (Explain disagreements) or continue.", "warning", socketio)
            socketio.emit("optimization_waiting", {"project_id": pid, "job_id": job_id, "missing": missing_rat})
            _resume[job_id].wait()
            job = load_job(pid, job_id)
            ctx.job = job
            job["status"] = "running"
            test = get_test(pid, job["test_id"])
            dis, _ = gather_cases(job, test.get("human_labels") or {}, ctx.units,
                                  baseline["evaluations"][primary_model]["dev"]["llm_results"], rubric_items)
            job["rationale_coverage"]["after_pause"] = _coverage(dis)
            save_job(job)
        if ctx.stopped():
            return _finish(job, ctx, socketio, "stopped", "Stopped by user.")

        # 4. Search rounds
        parent, prior_nonsig, idx, reason = baseline, 0, 1, None
        rng = random.Random(cfg["split_seed"])
        for r in range(1, cfg["rounds"] + 1):
            if ctx.stopped():
                reason = "Stopped by user."
                break
            pev = parent["evaluations"][primary_model]["dev"]
            dis, _ = gather_cases(job, get_test(pid, job["test_id"]).get("human_labels") or {}, ctx.units,
                                  pev["llm_results"], parent["prompts"].get("rubric_items"))
            if not dis:
                reason = "No development-set disagreements remain on the primary model."
                break
            focuses = choose_focuses(job["block_type"], dis, k, parent["prompts"].get("rubric_items"))
            _event(job, f"Round {r}: {len(dis)} dev disagreements ({sum(1 for c in dis if c['human_rationale'])} with rationale); "
                        f"proposing {k} revision(s) from {parent['id']}", "info", socketio)
            round_cands = []
            for focus in focuses:
                if ctx.stopped():
                    break
                try:
                    cand = _propose(ctx, parent, focus, rng.randrange(1, 2**31), idx, r)
                except HoldoutLeak as e:
                    return _finish(job, ctx, socketio, "error", f"Holdout leak blocked: {e}")
                idx += 1
                if cand["status"] != "proposed":
                    _event(job, f"  {cand['id']} ({focus}) rejected: {cand['status']} "
                                f"{'; '.join(cand.get('problems') or cand.get('normalization_notes') or [])}", "warning", socketio)
                    continue
                for m in models:
                    if ctx.stopped():
                        break
                    evaluate(ctx, cand, m, "dev")
                if ctx.stopped():
                    break
                ce = cand["evaluations"][primary_model]["dev"]
                pd = st.paired_delta_ci(pev["correctness"], ce["correctness"])
                delta, lo, hi = pd if pd else (None, None, None)
                state, promotable = st.convergence_state(delta, lo, hi, job["noise_floor"], job["rater_ceiling"],
                                                         ce["primary"], prior_nonsig)
                cand.update({"status": "evaluated", "delta_vs_parent": delta, "delta_ci": [lo, hi],
                             "flips_vs_parent": st.flip_table(pev["correctness"], ce["correctness"]),
                             "state": state, "promotable": promotable})
                if cand.get("cited_unit_ids"):
                    ft = st.flip_table({u: pev["correctness"].get(u, 0) for u in cand["cited_unit_ids"] if u in pev["correctness"]},
                                       {u: ce["correctness"].get(u, 0) for u in cand["cited_unit_ids"] if u in ce["correctness"]})
                    cand["cited_cases_flips"] = ft
                save_candidate(job, cand)
                round_cands.append(cand)
                _event(job, f"  {cand['id']} ({focus}): dev {_pct(ce['primary'])} "
                            f"(Δ {_pp(delta)} [{_pp(lo)}, {_pp(hi)}]) → {state}", "info", socketio)

            if ctx.stopped():
                reason = "Stopped by user."
                break
            job["rounds_completed"] = r
            if not round_cands:
                prior_nonsig += 1
            else:
                best = max(round_cands, key=lambda c: (c["evaluations"][primary_model]["dev"]["primary"] or 0,
                                                       c["evaluations"][primary_model]["dev"].get("tie_break") or 0))
                if best["promotable"] or (best["state"] == "AT-RATER-CEILING" and (best["delta_vs_parent"] or 0) > 0
                                          and (best["delta_ci"][0] or 0) > 0):
                    parent = best
                    prior_nonsig = 0
                    job["parent_chain"].append(best["id"])
                    _event(job, f"Round {r}: {best['id']} promoted as the new working prompt.", "info", socketio)
                else:
                    prior_nonsig += 1
                if best["state"] == "AT-RATER-CEILING":
                    reason = "Dev agreement reached the rater's own consistency (rater ceiling)."
                    save_job(job)
                    break
            save_job(job)
            if prior_nonsig >= st.PLATEAU_AFTER:
                reason = f"Plateau: {prior_nonsig} consecutive rounds without a significant improvement."
                break
        else:
            reason = reason or f"Completed all {cfg['rounds']} rounds."

        if ctx.stopped():
            job["best_candidate_id"] = parent["id"]
            return _finish(job, ctx, socketio, "stopped", reason or "Stopped by user.")

        # 5. Holdout — once, on a shortlist
        all_c = [c for c in load_candidates(pid, job_id) if c.get("status") == "evaluated"]
        shortlist = {(baseline["id"], m) for m in models} | {(parent["id"], m) for m in models}
        for m in models[1:]:
            best_m = max(all_c, key=lambda c: (_primary(c, m) or 0))
            shortlist.add((best_m["id"], m))
        by_id = {c["id"]: c for c in all_c}
        _event(job, f"Holdout evaluation of {len(shortlist)} candidate×model pair(s) "
                    f"(holdout look #{len(job['holdout_evaluations']) + 1}).", "info", socketio)
        for cid, m in sorted(shortlist):
            if ctx.stopped():
                break
            s = evaluate(ctx, by_id[cid], m, "holdout")
            _event(job, f"  {cid} on {m}: holdout {_pct(s['primary'])} (dev {_pct(_primary(by_id[cid], m))})", "info", socketio)
        job["holdout_evaluations"].append({"at": _now(), "pairs": sorted([list(p) for p in shortlist])})

        def gap(c):
            d, h = _primary(by_id[c["id"]], primary_model), _primary(by_id[c["id"]], primary_model, "holdout")
            return (d - h) if d is not None and h is not None else None
        g_base, g_best = gap(baseline), gap(parent)
        job["overfit_check"] = {"baseline_gap": g_base, "best_gap": g_best}
        job["best_candidate_id"] = parent["id"]
        verdict, note = final_verdict(parent["id"] != baseline["id"],
                                      _primary(baseline, primary_model), _primary(baseline, primary_model, "holdout"),
                                      _primary(parent, primary_model), _primary(parent, primary_model, "holdout"))
        job["final_state"] = verdict
        if note:
            reason = (reason or "") + " " + note
        return _finish(job, ctx, socketio, "complete", reason)

    except Exception as e:
        import traceback
        traceback.print_exc()
        job = load_job(pid, job_id) or job
        job["error"] = str(e)
        return _finish(job, ctx, socketio, "error", f"Unexpected error: {e}")


def final_verdict(changed, dev_base, hold_base, dev_final, hold_final):
    """Outcome of a job once the holdout has been examined (psychpaper rule):
    OVERFITTING when the final dev−holdout gap exceeds 10 points and widened
    versus the baseline; NOT-GENERALISED when the development gain did not
    carry over to the holdout at all; IMPROVED otherwise."""
    from services import agreement_stats as st
    if not changed:
        return "NO-SIGNIFICANT-IMPROVEMENT", None
    if None in (dev_base, hold_base, dev_final, hold_final):
        return "IMPROVED", None
    g_base, g_final = dev_base - hold_base, dev_final - hold_final
    if g_final > st.OVERFIT_GAP and g_final > g_base:
        return "OVERFITTING", ("Development–holdout gap exceeds 10 points and widened versus the baseline: "
                               "treat the development gain as overfitting.")
    if hold_final <= hold_base:
        return "NOT-GENERALISED", ("The development gain did not carry over to the holdout "
                                   "(holdout agreement did not improve); report it as development-only.")
    return "IMPROVED", None


def _pct(v):
    return "n/a" if v is None else f"{v * 100:.1f}%"


def _pp(v):
    return "n/a" if v is None else f"{v * 100:+.1f}pp"


# ---------------------------------------------------------------------------
# Apply (human promotion, with provenance)
# ---------------------------------------------------------------------------

def apply_candidate(pid, job_id, cid, edits=None):
    job = load_job(pid, job_id)
    if not job:
        return {"error": "Job not found"}
    cands = {c["id"]: c for c in load_candidates(pid, job_id)}
    cand = cands.get(cid)
    if not cand:
        return {"error": "Candidate not found"}
    prompts = json.loads(json.dumps(cand["prompts"]))
    if edits:
        for k, v in edits.items():
            if k in prompts:
                prompts[k] = v
    verbatim = prompts == cand["prompts"]
    entry = {"at": _now(), "verbatim": verbatim, "prompts": prompts}
    cand.setdefault("applied", []).append(entry)
    save_candidate(job, cand)
    log = os.path.join(PROJECTS_DIR, pid, "alignment", "prompt_log.jsonl")
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": entry["at"], "block_id": job["block_id"], "job_id": job_id,
                            "candidate_id": cid, "origin": cand["origin"],
                            "provenance": "model-proposed (applied verbatim)" if verbatim and cand["origin"] != "baseline"
                            else "model-proposed, human-edited" if cand["origin"] != "baseline" else "baseline",
                            "prompts": prompts}) + "\n")
    return {"status": "applied", "block_id": job["block_id"], "prompts": prompts, "verbatim": verbatim}
