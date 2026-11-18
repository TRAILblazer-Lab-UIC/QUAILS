"""Export and import QUAILS project packages (.qpkg)."""

import csv
import io
import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime, timezone

import pyzipper
from flask import Blueprint, jsonify, request, send_file

from config import APP_VERSION, PROJECTS_DIR, SELECTED_MODEL, SELECTED_PROVIDER
from services.version_control import commit_project, init_project_repo

project_packages_bp = Blueprint("project_packages", __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _add_dir_to_zip(zf, fs_path, zip_prefix):
    """Recursively add all files under fs_path into zf under zip_prefix."""
    for root, dirs, files in os.walk(fs_path):
        # Skip .git directories
        dirs[:] = [d for d in dirs if d != ".git"]
        for filename in files:
            abs_path = os.path.join(root, filename)
            rel_to_src = os.path.relpath(abs_path, fs_path)
            arc_name = os.path.join(zip_prefix, rel_to_src).replace("\\", "/")
            zf.write(abs_path, arc_name)


def _rewrite_ids_deep(obj, old_short, new_short):
    """Recursively rewrite unit-id prefixes in every dict key and string value."""
    prefix = old_short + "-"

    def _fix(text):
        return new_short + text[len(old_short):] if text.startswith(prefix) else text

    if isinstance(obj, dict):
        return {(_fix(k) if isinstance(k, str) else k): _rewrite_ids_deep(v, old_short, new_short)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_rewrite_ids_deep(v, old_short, new_short) for v in obj]
    if isinstance(obj, str):
        return _fix(obj)
    return obj


def _rewrite_project_ids(proj_dir, old_short, new_short, new_id):
    """Rewrite all embedded project-ID references after import."""
    now_iso = datetime.now(timezone.utc).isoformat()

    # --- project.json ---
    proj_json_path = os.path.join(proj_dir, "project.json")
    if os.path.exists(proj_json_path):
        with open(proj_json_path, "r", encoding="utf-8") as f:
            proj_data = json.load(f)
        proj_data["id"] = new_id
        proj_data["created_at"] = now_iso
        proj_data["updated_at"] = now_iso
        with open(proj_json_path, "w", encoding="utf-8") as f:
            json.dump(proj_data, f, indent=2)

    # --- parsed/doc_NNN.json ---
    parsed_dir = os.path.join(proj_dir, "parsed")
    if os.path.isdir(parsed_dir):
        for fname in os.listdir(parsed_dir):
            if fname.endswith(".json"):
                fpath = os.path.join(parsed_dir, fname)
                with open(fpath, "r", encoding="utf-8") as f:
                    doc_data = json.load(f)
                changed = False
                units = doc_data if isinstance(doc_data, list) else doc_data.get("units", [])
                for unit in units:
                    if isinstance(unit, dict):
                        uid = unit.get("unit_id", "")
                        if uid.startswith(old_short + "-"):
                            unit["unit_id"] = new_short + uid[len(old_short):]
                            changed = True
                        parent_uid = unit.get("parent_unit_id", "")
                        if parent_uid and parent_uid.startswith(old_short + "-"):
                            unit["parent_unit_id"] = new_short + parent_uid[len(old_short):]
                            changed = True
                if changed:
                    with open(fpath, "w", encoding="utf-8") as f:
                        json.dump(doc_data, f, indent=2)

    # --- alignment/sample.json ---
    sample_path = os.path.join(proj_dir, "alignment", "sample.json")
    if os.path.exists(sample_path):
        with open(sample_path, "r", encoding="utf-8") as f:
            sample_data = json.load(f)

        def _rewrite_uid(uid):
            if uid.startswith(old_short + "-"):
                return new_short + uid[len(old_short):]
            return uid

        # Rewrite in units list
        for unit in sample_data.get("units", []):
            if isinstance(unit, dict):
                uid = unit.get("unit_id", "")
                if uid.startswith(old_short + "-"):
                    unit["unit_id"] = _rewrite_uid(uid)

        # Rewrite keys in human_labels and llm_labels
        for label_key in ("human_labels", "llm_labels"):
            if label_key in sample_data:
                old_dict = sample_data[label_key]
                new_dict = {_rewrite_uid(k): v for k, v in old_dict.items()}
                sample_data[label_key] = new_dict

        with open(sample_path, "w", encoding="utf-8") as f:
            json.dump(sample_data, f, indent=2)

    # --- alignment/tests/**/*.json (current layout) ---
    tests_dir = os.path.join(proj_dir, "alignment", "tests")
    if os.path.isdir(tests_dir) and old_short != new_short:
        for root, _dirs, files in os.walk(tests_dir):
            for fname in files:
                if not fname.endswith(".json"):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        test_data = json.load(f)
                except (OSError, ValueError):
                    continue
                with open(fpath, "w", encoding="utf-8") as f:
                    json.dump(_rewrite_ids_deep(test_data, old_short, new_short), f, indent=2)

    # --- blocks/*/  *.csv ---
    blocks_dir = os.path.join(proj_dir, "blocks")
    if os.path.isdir(blocks_dir):
        for block_id in os.listdir(blocks_dir):
            block_path = os.path.join(blocks_dir, block_id)
            if not os.path.isdir(block_path):
                continue
            for fname in os.listdir(block_path):
                if not fname.endswith(".csv"):
                    continue
                fpath = os.path.join(block_path, fname)
                rows = []
                changed = False
                with open(fpath, "r", encoding="utf-8", newline="") as f:
                    reader = csv.DictReader(f)
                    fieldnames = reader.fieldnames or []
                    for row in reader:
                        uid = row.get("unit_id", "")
                        if uid.startswith(old_short + "-"):
                            row["unit_id"] = new_short + uid[len(old_short):]
                            changed = True
                        rows.append(row)
                if changed:
                    with open(fpath, "w", encoding="utf-8", newline="") as f:
                        writer = csv.DictWriter(f, fieldnames=fieldnames)
                        writer.writeheader()
                        writer.writerows(rows)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@project_packages_bp.route("/<project_id>/export", methods=["POST"])
def export_project(project_id):
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.isdir(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    include_data = bool(body.get("include_data", False))
    include_alignment = bool(body.get("include_alignment", True))
    password = body.get("password") or None

    # Load project title
    proj_json_path = os.path.join(proj_dir, "project.json")
    try:
        with open(proj_json_path, "r", encoding="utf-8") as f:
            proj_meta = json.load(f)
        title = proj_meta.get("title", project_id)
    except Exception:
        title = project_id

    # Build manifest (always unencrypted)
    manifest = {
        "quails_version": APP_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "original_project_id": project_id,
        "title": title,
        "includes_data": include_data,
        "includes_alignment": include_alignment,
        "encrypted": bool(password),
    }

    buf = io.BytesIO()
    compression = pyzipper.ZIP_DEFLATED

    with pyzipper.AESZipFile(buf, "w", compression=compression) as zf:
        # Write manifest always unencrypted (before setting any encryption)
        zf.writestr("quails_package.json", json.dumps(manifest, indent=2))

        # Apply encryption for all subsequent writes if password provided
        if password:
            zf.setencryption(pyzipper.WZ_AES, nbits=256)
            zf.setpassword(password.encode())

        # Always include core project files
        for filename in ("project.json", "flow.json", "inventory.json", "folders.json", "reviews.json"):
            fpath = os.path.join(proj_dir, filename)
            if os.path.exists(fpath):
                zf.write(fpath, f"project/{filename}")

        # Alignment package: source files, parsed units, alignment tests, and
        # the prompt templates in effect, so another user can continue alignment.
        data_dirs = []
        if include_alignment:
            data_dirs += ["corpus", "parsed", "alignment"]
            for filename in ("prompt_overrides.json", "inventory.md"):
                fpath = os.path.join(proj_dir, filename)
                if os.path.exists(fpath):
                    zf.write(fpath, f"project/{filename}")
            snapshot = {
                "provider": os.environ.get("SELECTED_PROVIDER", SELECTED_PROVIDER),
                "model": os.environ.get("SELECTED_MODEL", SELECTED_MODEL),
                "ollama_num_ctx": os.environ.get("OLLAMA_NUM_CTX") or None,
            }
            zf.writestr("project/settings_snapshot.json", json.dumps(snapshot, indent=2))

        # Optionally include analysis outputs
        if include_data:
            data_dirs += ["blocks", "reports"]

        for dirname in data_dirs:
            dir_path = os.path.join(proj_dir, dirname)
            if os.path.isdir(dir_path):
                _add_dir_to_zip(zf, dir_path, f"project/{dirname}")

    buf.seek(0)
    safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in title).strip()
    download_name = f"{safe_title}_{project_id}.qpkg"
    return send_file(
        buf,
        as_attachment=True,
        download_name=download_name,
        mimetype="application/zip",
    )


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

@project_packages_bp.route("/import", methods=["POST"])
def import_project():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    uploaded = request.files["file"]
    password = request.form.get("password") or None

    # Save to temp file
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".qpkg")
    os.close(tmp_fd)
    try:
        uploaded.save(tmp_path)

        # Read manifest (unencrypted)
        try:
            with pyzipper.AESZipFile(tmp_path, "r") as zf:
                manifest_bytes = zf.read("quails_package.json")
            manifest = json.loads(manifest_bytes)
        except Exception as e:
            return jsonify({"error": f"Invalid package file: {e}"}), 400

        encrypted = manifest.get("encrypted", False)
        if encrypted and not password:
            return jsonify({
                "error": "password_required",
                "title": manifest.get("title", "Unknown"),
            }), 400

        # Extract project/ subtree to temp directory
        tmp_extract_dir = tempfile.mkdtemp()
        try:
            pw_bytes = password.encode() if password else None
            with pyzipper.AESZipFile(tmp_path, "r") as zf:
                if pw_bytes:
                    zf.setpassword(pw_bytes)
                for member in zf.namelist():
                    if member.startswith("project/"):
                        target = os.path.normpath(os.path.join(tmp_extract_dir, member[len("project/"):]))
                        if not target.startswith(os.path.normpath(tmp_extract_dir) + os.sep):
                            continue  # reject path traversal entries
                        os.makedirs(os.path.dirname(target), exist_ok=True)
                        if not member.endswith("/"):
                            with zf.open(member) as src, open(target, "wb") as dst:
                                dst.write(src.read())

            # Generate new project ID
            new_id = uuid.uuid4().hex[:8]
            new_short = new_id[:4]
            old_id = manifest.get("original_project_id", "")
            old_short = old_id[:4] if old_id else ""

            # Rewrite embedded IDs
            if old_short:
                _rewrite_project_ids(tmp_extract_dir, old_short, new_short, new_id)

            # Move to projects directory
            dest_dir = os.path.join(PROJECTS_DIR, new_id)
            shutil.move(tmp_extract_dir, dest_dir)
            tmp_extract_dir = None  # already moved, don't cleanup

            # Init git repo and commit
            init_project_repo(dest_dir)
            commit_project(dest_dir, "Imported from package")

            # Return new project.json
            proj_json_path = os.path.join(dest_dir, "project.json")
            with open(proj_json_path, "r", encoding="utf-8") as f:
                proj_data = json.load(f)

            # Surface the exporter's model so the UI can note it (never overwrites .env)
            snapshot_path = os.path.join(dest_dir, "settings_snapshot.json")
            if os.path.exists(snapshot_path):
                try:
                    with open(snapshot_path, "r", encoding="utf-8") as f:
                        proj_data["snapshot_model"] = json.load(f).get("model")
                except (OSError, ValueError):
                    pass
            return jsonify(proj_data), 201

        finally:
            if tmp_extract_dir and os.path.exists(tmp_extract_dir):
                shutil.rmtree(tmp_extract_dir, ignore_errors=True)

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
