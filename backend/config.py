"""App constants and default configuration."""

import os
from dotenv import load_dotenv

# Application metadata
APP_TITLE = "QUAILS: Qualitative AI Labeling Support"
APP_VERSION = "1.0"
APP_VERSION_DATE = "November 2026"
APP_URL = "https://www.quailsai.com"
APP_AUTHOR = "Jeremy Riel"
APP_AUTHOR_URL = "https://www.jeremyriel.com"
APP_LICENSE = "MIT"
APP_LICENSE_URL = "https://opensource.org/licenses/MIT"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# QUAILS_PROJECTS_DIR lets a separate data folder be used (e.g. demos, tests) without touching real projects
PROJECTS_DIR = os.environ.get("QUAILS_PROJECTS_DIR") or os.path.join(BASE_DIR, "projects")

# Load .env from backend directory
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(ENV_PATH)

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "gemma3")

# Selected provider and model (persisted in .env)
SELECTED_PROVIDER = os.environ.get("SELECTED_PROVIDER", "ollama")
SELECTED_MODEL = os.environ.get("SELECTED_MODEL", "gemma3")

# Default confidence thresholds (0-100)
DEFAULT_DETECTION_THRESHOLD = 70.0
DEFAULT_LABEL_THRESHOLD = 70.0
DEFAULT_THEME_THRESHOLD = 80.0

# Default alignment settings
DEFAULT_SAMPLE_SIZE = 20
DEFAULT_CONVERGENCE_THRESHOLD = 0.5
DEFAULT_MAX_CATEGORIES = 6
DEFAULT_SIMILARITY_THRESHOLD = 80
DEFAULT_ALIGNMENT_SAMPLE_SIZE = 20

# Autosave settings
AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000  # 5 minutes
IDLE_TIMEOUT_MS = 15 * 60 * 1000      # 15 minutes

# Default prompts
DEFAULT_DETECTION_PROMPT = "Analyze the following text unit. Does it contain content relevant to the research question? Respond with only TRUE or FALSE."
DEFAULT_LABEL_PROMPT = "Based on the text unit above, assign a single descriptive label (code/tag) that captures the key theme or concept. Respond with only the label."

# Feedback / crash report form URLs (Formspree)
# Create forms at https://formspree.io and paste the full endpoint URLs here.
# Leave empty to disable remote submission (users will still see the UI but
# submissions will be silently skipped).
CRASH_REPORT_FORM_URL = os.environ.get("CRASH_REPORT_FORM_URL", "")
SUGGESTION_FORM_URL = os.environ.get("SUGGESTION_FORM_URL", "")
