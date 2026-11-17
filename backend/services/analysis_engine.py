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
    """Execute analysis blocks in flow order."""
    from models.flow_graph import FlowGraph
    from extensions import socketio
    from services.socket_logger import emit_log, emit_block_complete

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    flow = FlowGraph(proj_dir)
    flow.load()

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
            socketio.emit("analysis_complete", {"project_id": project_id, "error": f"Block '{block_id}' not in flow"})
            return
        block_order = [block_id]

    for bid in block_order:
        if is_stopped(project_id):
            emit_log(socketio, "Analysis stopped by user", "warn", project_id)
            break

        node = node_map.get(bid)
        if not node:
            continue

        block_type = node.get("type")
        block_data = node.get("data", {})

        emit_log(socketio, f"Starting block: {block_data.get('label', bid)} ({block_type})", "info", project_id)

        # Ensure block output directory
        block_dir = os.path.join(proj_dir, "blocks", bid)
        os.makedirs(block_dir, exist_ok=True)

        # Save block config
        with open(os.path.join(block_dir, "config.json"), "w", encoding="utf-8") as f:
            json.dump(block_data, f, indent=2)

        # Execute based on block type
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

        from services.save_state import mark_complete
        mark_complete(block_dir)
        emit_block_complete(socketio, bid, project_id)
        emit_log(socketio, f"Block complete: {block_data.get('label', bid)}", "info", project_id)

    from services.socket_logger import emit_log as el
    if is_stopped(project_id):
        el(socketio, "Analysis stopped by user.", "warn", project_id)
    else:
        el(socketio, "Analysis complete.", "info", project_id)
    socketio.emit("analysis_complete", {"project_id": project_id})
