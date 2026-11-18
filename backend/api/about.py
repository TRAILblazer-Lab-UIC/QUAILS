"""About page endpoint — serves the about.html template with app metadata."""

import os
from flask import Blueprint, jsonify, send_file, abort

from config import (
    APP_TITLE, APP_VERSION, APP_VERSION_DATE,
    APP_URL, APP_AUTHOR, APP_LICENSE, APP_LICENSE_URL,
)

about_bp = Blueprint("about", __name__)

TEMPLATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "templates",
    "about.html",
)

README_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "README.txt",
)


@about_bp.route("/", methods=["GET"])
def get_about():
    """Return the about page HTML with metadata variables substituted."""
    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        html = f.read()

    replacements = {
        "{{ title }}": APP_TITLE,
        "{{ version }}": APP_VERSION,
        "{{ version_date }}": APP_VERSION_DATE,
        "{{ url }}": APP_URL,
        "{{ author }}": APP_AUTHOR,
        "{{ license }}": APP_LICENSE,
        "{{ license_url }}": APP_LICENSE_URL,
        "{{ logo_url }}": "/logo.png",
    }

    for placeholder, value in replacements.items():
        html = html.replace(placeholder, value)

    return jsonify({
        "html": html,
        "metadata": {
            "title": APP_TITLE,
            "version": APP_VERSION,
            "version_date": APP_VERSION_DATE,
            "url": APP_URL,
            "author": APP_AUTHOR,
            "license": APP_LICENSE,
            "license_url": APP_LICENSE_URL,
        },
    })


@about_bp.route("/readme", methods=["GET"])
def get_readme():
    """Serve the README.txt file as plain text."""
    if not os.path.exists(README_PATH):
        abort(404)
    return send_file(README_PATH, mimetype="text/plain")
