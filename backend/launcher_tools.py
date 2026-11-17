"""Helper commands shared by the QUAILS launchers (start.sh, start.bat).

Uses only the Python standard library, so it runs before any QUAILS
dependency is installed.

Commands:
  check-python                Exit 0 if this interpreter is Python >= 3.10.
  check-deps REQUIREMENTS     Exit 0 if every package in the requirements
                              file is installed at a satisfying version;
                              otherwise list what is missing and exit 1.
  frontend-stale FRONTEND_DIR Exit 0 if `npm install` is needed (no
                              node_modules, or package files changed since the
                              last install); exit 1 if up to date.
  wait-url URL SECONDS        Poll URL until it responds; exit 1 on timeout.
  url-up URL                  Exit 0 if URL responds now, else 1.
"""

import os
import re
import sys
import time
import urllib.error
import urllib.request

MIN_PYTHON = (3, 10)


def _version_tuple(text):
    """Turn '3.1.2', '2.0rc1' or '5.0.post1' into a comparable tuple of ints."""
    parts = []
    for piece in text.split("."):
        m = re.match(r"\d+", piece)
        if not m:
            break
        parts.append(int(m.group()))
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def _satisfies(installed, op, wanted):
    a, b = _version_tuple(installed), _version_tuple(wanted)
    if op == ">=":
        return a >= b
    if op == ">":
        return a > b
    if op == "<=":
        return a <= b
    if op == "<":
        return a < b
    if op in ("==", "==="):
        return a == b
    if op == "!=":
        return a != b
    if op == "~=":
        # ~=X.Y means >=X.Y and ==X.*
        prefix = b[:-1] if len(b) > 1 else b
        return a >= b and a[: len(prefix)] == prefix
    return True


def _parse_requirement(line):
    line = line.split("#", 1)[0].strip()
    if not line or line.startswith("-"):
        return None
    line = line.split(";", 1)[0].strip()  # drop environment markers
    m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)", line)
    if not m:
        return None
    name, _, spec = m.groups()
    specs = re.findall(r"(~=|===|==|!=|<=|>=|<|>)\s*([^\s,]+)", spec)
    return name, specs


def check_deps(req_path):
    from importlib import metadata

    problems = []
    with open(req_path, encoding="utf-8") as fh:
        for raw in fh:
            req = _parse_requirement(raw)
            if not req:
                continue
            name, specs = req
            try:
                installed = metadata.version(name)
            except metadata.PackageNotFoundError:
                problems.append(f"{name} (not installed)")
                continue
            for op, wanted in specs:
                if not _satisfies(installed, op, wanted):
                    problems.append(f"{name} {installed} (needs {op}{wanted})")
                    break
    if problems:
        print("  Missing or outdated Python packages:")
        for p in problems:
            print(f"    - {p}")
        return 1
    return 0


def frontend_stale(frontend_dir):
    marker = os.path.join(frontend_dir, "node_modules", ".package-lock.json")
    if not os.path.exists(marker):
        return 0
    stamp = os.path.getmtime(marker)
    for name in ("package.json", "package-lock.json"):
        path = os.path.join(frontend_dir, name)
        if os.path.exists(path) and os.path.getmtime(path) > stamp:
            return 0
    return 1


def url_up(url):
    try:
        with urllib.request.urlopen(url, timeout=2):
            return True
    except urllib.error.HTTPError:
        return True  # the server answered, even if with an error status
    except Exception:
        return False


def wait_url(url, seconds):
    deadline = time.time() + float(seconds)
    while time.time() < deadline:
        if url_up(url):
            return 0
        time.sleep(1)
    return 1


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "check-python":
        return 0 if sys.version_info[:2] >= MIN_PYTHON else 1
    if cmd == "check-deps" and len(args) == 1:
        return check_deps(args[0])
    if cmd == "frontend-stale" and len(args) == 1:
        return frontend_stale(args[0])
    if cmd == "wait-url" and len(args) == 2:
        return wait_url(args[0], args[1])
    if cmd == "url-up" and len(args) == 1:
        return 0 if url_up(args[0]) else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
