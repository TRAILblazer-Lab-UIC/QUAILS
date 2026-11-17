"""GitPython auto-commit wrapper for project version control."""

import os
import stat
from datetime import datetime


def init_project_repo(proj_dir):
    """Initialize a git repo in the project directory."""
    try:
        from git import Repo
        if not os.path.exists(os.path.join(proj_dir, ".git")):
            repo = Repo.init(proj_dir)
            # Create .gitignore for project repo
            gitignore_path = os.path.join(proj_dir, ".gitignore")
            with open(gitignore_path, "w") as f:
                f.write("# QUAILS project repo\n")
            repo.index.add([".gitignore"])
            repo.index.commit("[QUAILS] Repository initialized")
    except Exception as e:
        print(f"[version_control] Failed to init repo: {e}")


def commit_project(proj_dir, action):
    """Auto-commit all changes in the project directory."""
    try:
        from git import Repo
        repo_path = os.path.join(proj_dir, ".git")
        if not os.path.exists(repo_path):
            return

        repo = Repo(proj_dir)
        # Add all changes
        repo.git.add(A=True)

        # Check if there are changes to commit
        if repo.is_dirty() or repo.untracked_files:
            timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
            message = f"[QUAILS] {action} | {timestamp}"
            repo.index.commit(message)
    except Exception as e:
        print(f"[version_control] Failed to commit: {e}")


def remove_project_repo(proj_dir):
    """Remove a project directory, handling git read-only files on Windows."""
    import gc
    import shutil
    import time

    # Close any open Repo objects referencing this directory
    try:
        from git import Repo
        repo = Repo(proj_dir)
        repo.close()
        del repo
        gc.collect()
    except Exception:
        pass

    def handle_remove_readonly(func, path, exc_info):
        """Handle read-only files in .git on Windows."""
        os.chmod(path, stat.S_IWRITE)
        func(path)

    # Retry up to 3 times for Windows file locking
    for attempt in range(3):
        try:
            shutil.rmtree(proj_dir, onexc=handle_remove_readonly)
            return
        except PermissionError:
            if attempt < 2:
                gc.collect()
                time.sleep(0.5)
            else:
                raise
