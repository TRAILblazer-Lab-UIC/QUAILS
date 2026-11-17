"""Flask application factory with SocketIO, CORS, and blueprint registration."""

import os
import sys
from flask import Flask
from flask_cors import CORS
from config import PROJECTS_DIR
from extensions import socketio
from services.error_logger import setup_logging


def create_app():
    setup_logging()

    app = Flask(__name__)
    app.config["SECRET_KEY"] = "quails-dev-key"
    app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100MB upload limit

    CORS(app, resources={r"/api/*": {"origins": "*"}})

    # Ensure projects directory exists
    os.makedirs(PROJECTS_DIR, exist_ok=True)

    # Register blueprints
    from api.projects import projects_bp
    from api.documents import documents_bp
    from api.analysis import analysis_bp
    from api.flow import flow_bp
    from api.alignment import alignment_bp
    from api.llm import llm_bp
    from api.csv_data import csv_data_bp
    from api.reports import reports_bp
    from api.settings import settings_bp
    from api.about import about_bp
    from api.project_packages import project_packages_bp
    from api.prompt_templates import bp as prompt_templates_bp
    from api.llmfit import llmfit_bp

    app.register_blueprint(projects_bp, url_prefix="/api/projects")
    app.register_blueprint(documents_bp, url_prefix="/api/documents")
    app.register_blueprint(analysis_bp, url_prefix="/api/analysis")
    app.register_blueprint(flow_bp, url_prefix="/api/flow")
    app.register_blueprint(alignment_bp, url_prefix="/api/alignment")
    app.register_blueprint(llm_bp, url_prefix="/api/llm")
    app.register_blueprint(csv_data_bp, url_prefix="/api/csv")
    app.register_blueprint(reports_bp, url_prefix="/api/reports")
    app.register_blueprint(settings_bp, url_prefix="/api/settings")
    app.register_blueprint(about_bp, url_prefix="/api/about")
    app.register_blueprint(project_packages_bp, url_prefix="/api/packages")
    app.register_blueprint(prompt_templates_bp, url_prefix="/api/prompts")
    app.register_blueprint(llmfit_bp, url_prefix="/api/llmfit")

    socketio.init_app(app, cors_allowed_origins="*", async_mode="threading")

    @socketio.on("connect")
    def on_connect():
        print("[SocketIO] Client connected", flush=True)

    @socketio.on("disconnect")
    def on_disconnect():
        print("[SocketIO] Client disconnected", flush=True)

    return app


if __name__ == "__main__":
    print(f"[QUAILS] Python {sys.version}")
    app = create_app()
    # use_reloader=False is required: Flask-SocketIO threading mode is incompatible
    # with Werkzeug's reloader, which spawns two processes sharing the same port.
    # With two processes, socket events emitted from a background thread in the
    # worker process never reach clients connected to the other process.
    socketio.run(app, host="127.0.0.1", port=5174, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
