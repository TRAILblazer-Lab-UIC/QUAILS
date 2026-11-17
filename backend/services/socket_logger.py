"""WebSocket real-time log emitter."""

from datetime import datetime


def emit_log(socketio, message, level="info", project_id=None):
    """Emit a log message via WebSocket."""
    timestamp = datetime.utcnow().strftime("%H:%M:%S")
    data = {
        "timestamp": timestamp,
        "level": level,
        "message": message,
    }
    if project_id:
        data["project_id"] = project_id
    socketio.emit("log", data)


def emit_progress(socketio, block_id, current, total, project_id=None):
    """Emit progress update via WebSocket."""
    pct = round((current / total) * 100, 1) if total > 0 else 0
    data = {
        "block_id": block_id,
        "current": current,
        "total": total,
        "pct": pct,
    }
    if project_id:
        data["project_id"] = project_id
    socketio.emit("progress", data)


def emit_block_complete(socketio, block_id, project_id=None):
    """Emit block completion event."""
    data = {"block_id": block_id}
    if project_id:
        data["project_id"] = project_id
    socketio.emit("block_complete", data)


def emit_error(socketio, message, project_id=None):
    """Emit error event."""
    data = {"message": message}
    if project_id:
        data["project_id"] = project_id
    socketio.emit("error", data)
