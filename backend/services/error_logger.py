"""Centralized logging setup and crash context collector."""

import logging
import os
import platform
import sys
from collections import deque
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler

from config import APP_VERSION

# Ring buffer for recent log lines (used in crash context)
_recent_lines = deque(maxlen=20)

LOGS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")


class _BufferHandler(logging.Handler):
    """Stores recent log lines in a ring buffer for crash reports."""

    def emit(self, record):
        try:
            _recent_lines.append(self.format(record))
        except Exception:
            pass


def setup_logging():
    """Configure root logger with console + rotating file + ring buffer handlers."""
    os.makedirs(LOGS_DIR, exist_ok=True)

    fmt = logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")

    # Console handler (INFO)
    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(fmt)

    # Rotating file handler (WARNING+) — 1 MB max, 1 backup = 2 MB ceiling
    log_path = os.path.join(LOGS_DIR, "quails.log")
    file_handler = RotatingFileHandler(
        log_path, maxBytes=1 * 1024 * 1024, backupCount=1, encoding="utf-8"
    )
    file_handler.setLevel(logging.WARNING)
    file_handler.setFormatter(fmt)

    # Ring buffer handler (WARNING+)
    buffer_handler = _BufferHandler()
    buffer_handler.setLevel(logging.WARNING)
    buffer_handler.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(console)
    root.addHandler(file_handler)
    root.addHandler(buffer_handler)


def collect_crash_context():
    """Return anonymized crash context dict. No project names, paths, or content."""
    return {
        "app_version": APP_VERSION,
        "python_version": platform.python_version(),
        "platform": sys.platform,
        "os_info": f"{platform.system()} {platform.release()}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "recent_log_lines": list(_recent_lines),
    }
