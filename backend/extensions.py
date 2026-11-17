"""Shared Flask extensions — imported by app.py and services alike.

Keeping extensions here avoids the __main__ re-import problem: when a
background thread does 'from app import socketio', Python re-executes app.py
as a fresh module (not __main__), creating a new SocketIO() with server=None.
Importing from this module is safe because it contains no app-dependent code.
"""

from flask_socketio import SocketIO

socketio = SocketIO()

# Safety check: Flask 3.1 made RequestContext.session a read-only property.
# Flask-SocketIO <5.6.1 assigns ctx.session = ... which triggers AttributeError.
# Warn at import time if the installed combination is known-broken.
try:
    import flask
    import flask_socketio
    import inspect

    _flask_ver = tuple(int(x) for x in flask.__version__.split(".")[:2])
    _fsio_ver = tuple(int(x) for x in flask_socketio.__version__.split(".")[:3])

    if _flask_ver >= (3, 1) and _fsio_ver < (5, 6, 1):
        # Check if the source still has the broken assignment
        _src = inspect.getsource(flask_socketio)
        if "ctx.session = " in _src:
            print(
                "[QUAILS] WARNING: Flask-SocketIO %s has a known incompatibility "
                "with Flask %s (session setter bug). Upgrade to flask-socketio>=5.6.1 "
                "or patch site-packages/flask_socketio/__init__.py: "
                "change 'ctx.session = ...' to 'ctx._session = ...'"
                % (flask_socketio.__version__, flask.__version__)
            )
except Exception:
    pass  # Best-effort — never crash on import
