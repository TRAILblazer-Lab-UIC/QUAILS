"""Core orchestrator: traverse flow, execute blocks, manage state."""

import os
import json
import threading

from config import PROJECTS_DIR

# Track running analyses
_running_analyses = {}
_stop_flags = {}


def start_analysis(project_id, block_id=None):
    """Start analysis in a background thread."""
    _stop_flags[project_id] = False

    def _run():
        _running_analyses[project_id] = {"active": True, "block_id": block_id, "status": "running"}
        try:
            from extensions import socketio
            from services.socket_logger import emit_log
            socketio.emit("analysis_started", {"project_id": project_id, "block_id": block_id})
            _execute_analysis(project_id, block_id)
        except Exception as e:
            import traceback
            traceback.print_exc()
            _running_analyses[project_id] = {"active": False, "status": "error", "error": str(e)}
            try:
                from extensions import socketio
                from services.socket_logger import emit_log, emit_error
                emit_error(socketio, f"Analysis failed: {str(e)}", project_id)
                emit_log(socketio, f"Analysis failed: {str(e)}", "error", project_id)
                socketio.emit("analysis_complete", {"project_id": project_id, "error": str(e)})
            except Exception:
                pass
        finally:
            if project_id in _running_analyses:
                _running_analyses[project_id]["active"] = False
                _running_analyses[project_id].setdefault("status", "idle")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()


def stop_analysis(project_id):
    """Signal an analysis to stop."""
    _stop_flags[project_id] = True


def resume_analysis(project_id, block_id=None):
    """Resume a previously stopped analysis."""
    start_analysis(project_id, block_id)


def get_status(project_id):
    """Get current analysis status."""
    return _running_analyses.get(project_id, {"active": False, "status": "idle"})


def is_stopped(project_id):
    """Check if stop was requested."""
    return _stop_flags.get(project_id, False)


def _execute_analysis(project_id, block_id=None):
    """Execute analysis blocks in flow order.

    block_id given  -> run only that block (the researcher chose it; review
                       checkpoints are not enforced).
    block_id None   -> pipeline run: every block in flow order. Completed,
                       up-to-date blocks are skipped. The run pauses before any
                       block whose Human Review checkpoint is not approved for
                       the upstream block's current run. Any failure stops the
                       run. When every block is done, the final report is written.
    """
    from models.flow_graph import FlowGraph
    from extensions import socketio
    from services.socket_logger import emit_log, emit_block_complete
    from services import pipeline as pl
    from services.save_state import mark_complete, mark_failed

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    flow = FlowGraph(proj_dir)
    flow.load()

    def finish(error=None, paused=None, report=None):
        payload = {"project_id": project_id}
        if error:
            payload["error"] = error
        if paused:
            payload["paused"] = paused
        if report:
            payload["report"] = report
        status = "error" if error else ("paused" if paused else ("stopped" if is_stopped(project_id) else "complete"))
        _running_analyses[project_id] = {"active": False, "status": status, "error": error, "paused": paused}
        socketio.emit("analysis_complete", payload)

    pipeline_run = not block_id
    if pipeline_run:
        problems = flow.validate()
        if problems:
            for msg in problems:
                emit_log(socketio, msg, "error", project_id)
            finish(error="The flow has problems: " + " | ".join(problems))
            return

    block_order = flow.get_analysis_order()
    node_map = {n["id"]: n for n in flow.nodes}

    # Extract model params from the projectSpec node (if present)
    spec_node = next((n for n in flow.nodes if n.get("type") == "projectSpec"), None)
    spec_data = spec_node.get("data", {}) if spec_node else {}
    model_params = {
        "temperature": spec_data.get("temperature", 0),
        "seed":        spec_data.get("seed", 5),
        "top_k":       spec_data.get("top_k", 3),
        "top_p":       spec_data.get("top_p", 0.9),
        "repeat_penalty": spec_data.get("repeat_penalty", 1.0),
    }

    # If a specific block is requested, only run that one
    if block_id:
        if block_id not in block_order:
            emit_log(socketio, f"Block '{block_id}' not found in analysis order — check that the flow was saved.", "error", project_id)
            finish(error=f"Block '{block_id}' not in flow")
            return
        block_order = [block_id]

    completed_at = {}  # block id -> completed_at, for staleness checks within this run

    for bid in block_order:
        if is_stopped(project_id):
            break

        node = node_map.get(bid)
        if not node:
            continue

        block_type = node.get("type")
        block_data = flow.apply_resolved_inputs(bid, node.get("data", {}))
        label = block_data.get("label", bid)
        block_dir = os.path.join(proj_dir, "blocks", bid)
        os.makedirs(block_dir, exist_ok=True)
        chash = pl.config_hash(block_data)
        state = pl.read_block_state(proj_dir, bid)
        upstream = flow.resolve_block_inputs(bid)

        if pipeline_run:
            up_times = [completed_at.get(u) or pl.read_block_state(proj_dir, u).get("completed_at") for u in upstream]
            done = state.get("completed") and not state.get("failed") and state.get("completed_at")
            changed = done and state.get("config_hash") not in (None, chash)
            stale = done and any(t and t > state["completed_at"] for t in up_times)
            if done and not changed and not stale:
                emit_log(socketio, f"Skipping {label}: already complete and up to date.", "info", project_id)
                completed_at[bid] = state["completed_at"]
                continue

            # Every review checkpoint before this block must be approved for
            # the upstream block's current run.
            for review_id, up in flow.checkpoints_before(bid):
                rs = pl.review_status(project_id, review_id, up)
                if rs["status"] != "approved":
                    up_label = (node_map.get(up, {}).get("data") or {}).get("label", up)
                    emit_log(socketio, f"Paused for human review of {up_label}. Review its results, then approve the checkpoint to continue.", "warn", project_id)
                    finish(paused={"review_id": review_id, "upstream_block_id": up, "next_block_id": bid})
                    return

            if changed or stale:
                why = "its settings changed" if changed else "an earlier block was re-run"
                emit_log(socketio, f"Re-running {label} from the start because {why}.", "info", project_id)
                pl.clear_block_outputs(proj_dir, bid, block_type, block_data)

        emit_log(socketio, f"Starting block: {label} ({block_type})", "info", project_id)

        # Save block config (with resolved inputs) for the audit trail
        with open(os.path.join(block_dir, "config.json"), "w", encoding="utf-8") as f:
            json.dump(block_data, f, indent=2)

        try:
            if block_type == "sourceAnalysis":
                from services.source_analysis import run_source_analysis
                run_source_analysis(project_id, bid, block_data, model_params)
            elif block_type == "themeIdent":
                from services.theme_identifier import run_theme_identification
                run_theme_identification(project_id, bid, block_data, model_params)
            elif block_type == "categoryBuild":
                from services.category_builder import run_category_building
                run_category_building(project_id, bid, block_data, model_params)
            elif block_type == "customPrompt":
                from services.custom_prompt import run_custom_prompt
                run_custom_prompt(project_id, bid, block_data, model_params)
            elif block_type == "rubricAnalysis":
                from services.rubric_analysis import run_rubric_analysis
                run_rubric_analysis(project_id, bid, block_data, model_params)

            if is_stopped(project_id):
                emit_log(socketio, f"{label} stopped before finishing. Resume to continue where it left off.", "warn", project_id)
                break

            missing = pl.missing_outputs(proj_dir, bid, block_type, block_data)
            if missing:
                raise pl.BlockFailed(f"{label} finished without writing {', '.join(missing)}.")
        except Exception as e:  # BlockFailed or anything unexpected
            if not isinstance(e, pl.BlockFailed):
                import traceback
                traceback.print_exc()
            msg = str(e) or e.__class__.__name__
            mark_failed(block_dir, msg)
            emit_log(socketio, f"Block failed: {label}. {msg}", "error", project_id)
            socketio.emit("block_failed", {"project_id": project_id, "block_id": bid, "error": msg})
            finish(error=f"{label}: {msg}")
            return

        mark_complete(block_dir, chash)
        completed_at[bid] = pl.read_block_state(proj_dir, bid).get("completed_at")
        emit_block_complete(socketio, bid, project_id)
        emit_log(socketio, f"Block complete: {label}", "info", project_id)

    if is_stopped(project_id):
        emit_log(socketio, "Analysis stopped by user.", "warn", project_id)
        finish()
        return

    report_name = None
    if pipeline_run:
        try:
            from services.report_generator import generate_report
            from services.version_control import commit_project
            report_path = generate_report(project_id)
            report_name = os.path.basename(report_path)
            commit_project(proj_dir, "Final report generated")
            emit_log(socketio, f"Pipeline complete. Final report written: reports/{report_name}", "info", project_id)
        except Exception as e:
            import traceback
            traceback.print_exc()
            emit_log(socketio, f"All blocks finished, but the final report could not be written: {e}", "error", project_id)
            finish(error=f"Report generation failed: {e}")
            return
    else:
        emit_log(socketio, "Analysis complete.", "info", project_id)
    finish(report=report_name)
