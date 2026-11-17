"""Alignment testing API endpoints — per-block alignment workflow."""

import os
import json
from flask import Blueprint, request, jsonify, send_file

from config import PROJECTS_DIR

alignment_bp = Blueprint("alignment", __name__)


@alignment_bp.route("/<project_id>/blocks", methods=["GET"])
def get_blocks(project_id):
    """List open-coding + rubric-based analysis blocks from flow.json."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    from services.alignment_service import get_alignment_blocks
    blocks = get_alignment_blocks(project_id)
    return jsonify(blocks)


@alignment_bp.route("/<project_id>/generate-sample", methods=["POST"])
def generate_sample(project_id):
    """Random sample N units from a block's data source."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json() or {}
    block_id = body.get("block_id")
    sample_size = body.get("sample_size", 20)

    if not block_id:
        return jsonify({"error": "block_id is required"}), 400

    from services.alignment_service import generate_sample
    result = generate_sample(project_id, block_id, sample_size)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@alignment_bp.route("/<project_id>/generate-theme-sample", methods=["POST"])
def generate_theme_sample(project_id):
    """Sample rows for a themeIdent block against its established theme list (v1)."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json() or {}
    block_id = body.get("block_id")
    sample_size = body.get("sample_size", 20)
    if not block_id:
        return jsonify({"error": "block_id is required"}), 400

    from services.alignment_service import generate_theme_sample
    result = generate_theme_sample(project_id, block_id, sample_size)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@alignment_bp.route("/<project_id>/generate-single-output-test", methods=["POST"])
def generate_single_output_test(project_id):
    """Create the current draft for a single-call block (categoryBuild/customPrompt, v1)."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json() or {}
    block_id = body.get("block_id")
    if not block_id:
        return jsonify({"error": "block_id is required"}), 400

    from services.alignment_service import generate_single_output_test
    result = generate_single_output_test(project_id, block_id)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@alignment_bp.route("/<project_id>/save-test", methods=["POST"])
def save_test(project_id):
    """Create or update a test file (human labels, config)."""
    body = request.get_json() or {}
    block_id = body.get("block_id")
    if not block_id:
        return jsonify({"error": "block_id is required"}), 400

    from services.alignment_service import create_or_update_test
    result = create_or_update_test(project_id, block_id, body)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@alignment_bp.route("/<project_id>/save-single-label", methods=["POST"])
def save_single_label(project_id):
    """Save one unit's human label."""
    body = request.get_json() or {}
    test_id = body.get("test_id")
    unit_id = body.get("unit_id")
    label_data = body.get("label_data")

    if not test_id or not unit_id or label_data is None:
        return jsonify({"error": "test_id, unit_id, and label_data are required"}), 400

    from services.alignment_service import save_single_label
    result = save_single_label(project_id, test_id, unit_id, label_data)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@alignment_bp.route("/<project_id>/run-comparison", methods=["POST"])
def run_comparison(project_id):
    """Run LLM on sample + compute metrics (background thread)."""
    body = request.get_json() or {}
    test_id = body.get("test_id")
    if not test_id:
        return jsonify({"error": "test_id is required"}), 400

    from services.alignment_runner import start_alignment_thread
    start_alignment_thread(project_id, test_id)
    return jsonify({"status": "started", "test_id": test_id})


@alignment_bp.route("/<project_id>/current-test/<block_id>", methods=["GET"])
def get_current_test(project_id, block_id):
    """Get the current in-progress draft test for a block, if any (null if none)."""
    from services.alignment_service import get_current_draft
    result = get_current_draft(project_id, block_id)
    return jsonify(result)


@alignment_bp.route("/<project_id>/tests/<block_id>", methods=["GET"])
def get_tests_for_block(project_id, block_id):
    """List all tests for a block (summary view)."""
    from services.alignment_service import list_tests
    tests = list_tests(project_id, block_id)
    return jsonify(tests)


@alignment_bp.route("/<project_id>/test/<test_id>", methods=["GET"])
def get_test(project_id, test_id):
    """Get full test result."""
    from services.alignment_service import get_test
    result = get_test(project_id, test_id)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result)


@alignment_bp.route("/<project_id>/test/<test_id>", methods=["DELETE"])
def delete_test(project_id, test_id):
    """Delete test (requires ?confirm=true)."""
    if request.args.get("confirm") != "true":
        return jsonify({"error": "Confirmation required: add ?confirm=true"}), 400

    from services.alignment_service import delete_test
    result = delete_test(project_id, test_id)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result)


@alignment_bp.route("/<project_id>/test/<test_id>/download", methods=["GET"])
def download_test(project_id, test_id):
    """Download test JSON file."""
    from services.alignment_service import get_test
    result = get_test(project_id, test_id)
    if "error" in result:
        return jsonify(result), 404

    import io
    buf = io.BytesIO(json.dumps(result, indent=2).encode("utf-8"))
    return send_file(buf, mimetype='application/json',
                     as_attachment=True, download_name=f"{test_id}.json")


@alignment_bp.route("/<project_id>/test/<test_id>/export.csv", methods=["GET"])
def export_test_csv(project_id, test_id):
    """Download a test's cases + human codes (+ LLM output if run) as long-format CSV."""
    import io
    from services.alignment_service import get_test
    from services.alignment_export import build_csv
    result = get_test(project_id, test_id)
    if "error" in result:
        return jsonify(result), 404
    buf = io.BytesIO(build_csv(result).encode("utf-8-sig"))  # BOM so Excel reads UTF-8
    return send_file(buf, mimetype="text/csv", as_attachment=True,
                     download_name=f"{test_id}_cases_and_codes.csv")


@alignment_bp.route("/<project_id>/test/<test_id>/report", methods=["GET"])
def export_test_report(project_id, test_id):
    """Write-up report for one alignment test (?format=md|txt|docx, default md)."""
    import io
    from services.alignment_service import get_test
    from services.alignment_export import build_report
    from services.report_render import render
    result = get_test(project_id, test_id)
    if "error" in result:
        return jsonify(result), 404
    title = ""
    try:
        with open(os.path.join(PROJECTS_DIR, project_id, "project.json"), "r", encoding="utf-8") as f:
            title = json.load(f).get("title", "")
    except (OSError, ValueError):
        pass
    data, mime, ext = render(build_report(result, title, project_id), request.args.get("format"),
                             title=f"Alignment test {test_id}")
    return send_file(io.BytesIO(data), mimetype=mime, as_attachment=True,
                     download_name=f"{test_id}_report.{ext}")


@alignment_bp.route("/<project_id>/block-prompts/<block_id>", methods=["PUT"])
def update_block_prompts(project_id, block_id):
    """Update block's prompts in flow.json."""
    body = request.get_json() or {}
    from services.alignment_service import update_block_prompts
    result = update_block_prompts(project_id, block_id, body)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result)


# ── Human rationale (added from the optimizer's "Explain disagreements") ──

@alignment_bp.route("/<project_id>/test/<test_id>/rationale", methods=["POST"])
def save_rationale(project_id, test_id):
    body = request.get_json() or {}
    if not body.get("unit_id"):
        return jsonify({"error": "unit_id is required"}), 400
    from services.alignment_service import save_rationale as _save
    result = _save(project_id, test_id, body["unit_id"], body.get("rationale", ""),
                   rubric_key=body.get("rubric_key"), post_hoc=body.get("post_hoc", True))
    return (jsonify(result), 400) if "error" in result else jsonify(result)


# ── Rater reliability (blind re-code) ──

@alignment_bp.route("/<project_id>/test/<test_id>/reliability/start", methods=["POST"])
def reliability_start(project_id, test_id):
    from services.alignment_service import start_reliability
    result = start_reliability(project_id, test_id)
    return (jsonify(result), 400) if "error" in result else jsonify(result)


@alignment_bp.route("/<project_id>/test/<test_id>/reliability/label", methods=["POST"])
def reliability_label(project_id, test_id):
    body = request.get_json() or {}
    from services.alignment_service import save_reliability_label
    result = save_reliability_label(project_id, test_id, body.get("unit_id"), body.get("label_data") or {})
    return (jsonify(result), 400) if "error" in result else jsonify(result)


@alignment_bp.route("/<project_id>/test/<test_id>/reliability/compute", methods=["POST"])
def reliability_compute(project_id, test_id):
    from services.alignment_service import compute_reliability
    result = compute_reliability(project_id, test_id)
    return (jsonify(result), 400) if "error" in result else jsonify(result)


# ── Automated prompt optimization ──

@alignment_bp.route("/<project_id>/optimizations/models", methods=["GET"])
def optimization_models(project_id):
    from services.llm_providers import list_provider_models
    names, err = list_provider_models("ollama")
    return jsonify({"models": names or [], "error": err})


@alignment_bp.route("/<project_id>/optimizations/estimate", methods=["POST"])
def optimization_estimate(project_id):
    body = request.get_json() or {}
    from services.optimization_job import estimate
    result = estimate(project_id, body.get("test_id"), body.get("config") or {})
    return (jsonify(result), 400) if "error" in result else jsonify(result)


@alignment_bp.route("/<project_id>/optimizations", methods=["POST"])
def optimization_create(project_id):
    body = request.get_json() or {}
    from services.optimization_job import create_job, start_job
    job = create_job(project_id, body.get("block_id"), body.get("test_id"), body.get("config") or {})
    if "error" in job:
        return jsonify(job), 400
    started = start_job(project_id, job["job_id"])
    if "error" in started:
        return jsonify(started), 409
    return jsonify({"job_id": job["job_id"], "status": "started"}), 201


@alignment_bp.route("/<project_id>/optimizations", methods=["GET"])
def optimization_list(project_id):
    from services.optimization_job import list_jobs, running_job
    return jsonify({"jobs": list_jobs(project_id, request.args.get("block_id")),
                    "running_job_id": running_job(project_id)})


def _slim_candidate(c):
    """Candidate for the UI: drop bulky per-unit LLM outputs and prompt previews."""
    out = {k: v for k, v in c.items() if k not in ("raw_response", "optimizer_prompt_preview")}
    evs = {}
    for model, slots in (c.get("evaluations") or {}).items():
        evs[model] = {slot: {k: v for k, v in ev.items() if k not in ("llm_results", "correctness", "run_conditions")}
                      for slot, ev in slots.items()}
    out["evaluations"] = evs
    return out


@alignment_bp.route("/<project_id>/optimizations/<job_id>", methods=["GET"])
def optimization_get(project_id, job_id):
    from services.optimization_job import load_job, load_candidates, running_job
    job = load_job(project_id, job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job = {k: v for k, v in job.items() if k != "human_codes"}
    job["is_running"] = running_job(project_id) == job_id
    return jsonify({"job": job, "candidates": [_slim_candidate(c) for c in load_candidates(project_id, job_id)]})


@alignment_bp.route("/<project_id>/optimizations/<job_id>/candidates/<cid>", methods=["GET"])
def optimization_candidate(project_id, job_id, cid):
    from services.optimization_job import load_candidates
    cand = next((c for c in load_candidates(project_id, job_id) if c["id"] == cid), None)
    if not cand:
        return jsonify({"error": "Candidate not found"}), 404
    return jsonify(cand)


@alignment_bp.route("/<project_id>/optimizations/<job_id>/stop", methods=["POST"])
def optimization_stop(project_id, job_id):
    from services.optimization_job import stop_job
    return jsonify(stop_job(project_id, job_id))


@alignment_bp.route("/<project_id>/optimizations/<job_id>/resume", methods=["POST"])
def optimization_resume(project_id, job_id):
    from services.optimization_job import resume_job
    result = resume_job(project_id, job_id)
    return (jsonify(result), 409) if "error" in result else jsonify(result)


@alignment_bp.route("/<project_id>/optimizations/<job_id>/disagreements", methods=["GET"])
def optimization_disagreements(project_id, job_id):
    from services.optimization_job import baseline_disagreements
    result = baseline_disagreements(project_id, job_id)
    return (jsonify(result), 404) if "error" in result else jsonify(result)


@alignment_bp.route("/<project_id>/optimizations/<job_id>/candidates/<cid>/apply", methods=["POST"])
def optimization_apply(project_id, job_id, cid):
    body = request.get_json() or {}
    from services.optimization_job import apply_candidate
    result = apply_candidate(project_id, job_id, cid, body.get("edits"))
    return (jsonify(result), 400) if "error" in result else jsonify(result)


@alignment_bp.route("/<project_id>/optimizations/<job_id>/report", methods=["GET"])
def optimization_report(project_id, job_id):
    """Write-up report for an optimization job (?format=md|txt|docx, default md)."""
    import io
    from services.optimization_report import write_report
    from services.optimization_job import load_job
    from services.report_render import render
    if not load_job(project_id, job_id):
        return jsonify({"error": "Job not found"}), 404
    text = write_report(project_id, job_id)  # regenerate so provenance is current
    data, mime, ext = render(text, request.args.get("format"), title=f"Prompt optimization {job_id}")
    return send_file(io.BytesIO(data), mimetype=mime, as_attachment=True,
                     download_name=f"{job_id}_report.{ext}")
