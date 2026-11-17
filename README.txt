================================================================================
  QUAILS - Qualitative AI Labeling Support
  Installation & Usage Guide
================================================================================

QUAILS is a local web application for automating thematic text analysis in
qualitative research. It uses open-weight LLMs that run entirely on your own
computer through Ollama, and a visual flow editor for designing multi-round
analysis workflows. At each step, QUAILS flags results that need human review:
low-confidence decisions, rejected units, and checkpoints between analysis
rounds.


================================================================================
  DATA PRIVACY NOTICE
================================================================================

  NO DATA EVER LEAVES YOUR MACHINE. All LLM inference runs entirely on your
  local hardware through Ollama.

  You remain responsible for handling research data in line with research
  ethics, institutional review board (IRB) requirements, and legal
  regulations (e.g., HIPAA, FERPA, GDPR) regarding personally identifiable
  information (PII) or confidential data.

  THIS SOFTWARE IS PROVIDED "AS-IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS
  OR IMPLIED. SEE THE LICENSE FILE FOR FULL TERMS.


================================================================================
  RECOMMENDED SYSTEM SPECIFICATIONS
================================================================================

  QUAILS itself (Flask backend + React frontend) is lightweight. The main
  resource demand comes from running a local LLM via Ollama.

  The specs below target efficient processing of substantive datasets
  (1,000+ text units across multiple documents) with a local LLM.

  ---- USING OLLAMA (LOCAL LLM) ------------------------------------------------

  These specs assume running a ~4B-8B parameter model (e.g., gemma3, llama3).
  Larger models (70B+) require significantly more RAM and VRAM.

    WINDOWS PC (recommended):
      CPU:      Intel i7 / AMD Ryzen 7 (8+ cores) or better
      RAM:      16 GB minimum, 32 GB recommended
      GPU:      NVIDIA GPU with 8+ GB VRAM (e.g., RTX 3060 or better)
                  - CUDA acceleration dramatically speeds up inference
                  - CPU-only is possible but 5-10x slower per unit
      Storage:  10 GB free (app + models + project data)
      OS:       Windows 10/11 (64-bit)

    MAC (recommended):
      Chip:     Apple M1 or later (M1 Pro/Max/Ultra, M2, M3, M4 preferred)
                  - Apple Silicon runs Ollama natively with unified memory
                  - Intel Macs work but are significantly slower (no GPU accel)
      RAM:      16 GB unified memory minimum, 24-36 GB recommended
                  - Unified memory is shared between CPU and GPU on Apple Silicon
                  - More memory = ability to run larger models
      Storage:  10 GB free (app + models + project data)
      OS:       macOS 13 (Ventura) or later

    MINIMUM (will work, but slower on large datasets):
      CPU:      Any modern quad-core processor
      RAM:      8 GB (limits you to smaller models like gemma3:2b)
      GPU:      Not required (CPU-only mode)
      Storage:  5 GB free

  ---- NOTES -------------------------------------------------------------------

  - Dataset size impact: A corpus of 5,000+ units with multi-block flows will
    use more memory for in-process data. 16 GB RAM is recommended for large
    projects.
  - Ollama model sizes: ~4B models need ~3 GB disk + ~5 GB RAM at runtime.
    ~8B models need ~5 GB disk + ~8 GB RAM. 70B+ models need 40+ GB RAM.
  - Analysis speed with Ollama depends heavily on GPU. Expect ~2-10 units/sec
    with GPU acceleration vs ~0.2-1 units/sec on CPU-only for a 4B model.
  - Multiple projects do not increase resource usage -- only one analysis
    runs at a time.


================================================================================
  TABLE OF CONTENTS
================================================================================

  1. Prerequisites (what you need installed)
  2. Installation (first-time setup)
  3. Running the App (start.bat / start.sh)
  4. Using QUAILS (step-by-step guide)
  5. Troubleshooting


================================================================================
  1. PREREQUISITES
================================================================================

You need three things installed before running QUAILS. If you already have
these, skip to section 2.

  A) PYTHON (3.10 or newer)
     Download: https://www.python.org/downloads/
     IMPORTANT: During installation, CHECK the box that says
                "Add Python to PATH"
     To verify: open a terminal and type: python --version

  B) NODE.JS (20.19+ or 22.12+; the current LTS version is fine)
     Download: https://nodejs.org/ (choose the LTS version)
     This also installs npm automatically.
     To verify: open a terminal and type: node --version

  C) GIT
     Download: https://git-scm.com/downloads
     Use the default settings during installation.
     To verify: open a terminal and type: git --version

  D) OLLAMA (runs the LLM on your computer)
     Download: https://ollama.com/download
     After installing, open a terminal and run:
       ollama pull gemma3
     This downloads the default LLM model (~3GB). You can also use other
     models like "llama3" or "mistral" -- just pull them the same way.
     To verify: open a terminal and type: ollama list


================================================================================
  2. INSTALLATION (first-time only)
================================================================================

  OPTION A - AUTOMATIC (recommended):

    Windows: Double-click "start.bat"
    macOS:   Double-click "start.command"
    Linux:   Double-click "start_linux.sh" (or run ./start_linux.sh)

    The launcher is also the installer. Every time it runs, it:
      - Checks that Python, Node.js, npm, Git and Ollama are installed
        and new enough
      - Creates a private Python environment in backend/.venv (first run)
      - Checks every package in backend/requirements.txt and installs only
        what is missing or out of date
      - Installs the frontend packages when they have changed
      - Starts Ollama if it isn't running, launches QUAILS, and opens your
        browser

    The first launch can take several minutes. Logs are in backend/logs/.

    If your computer warns that the launcher is from an unverified
    developer:
      - macOS: click Done, open System Settings > Privacy & Security, and
        click "Open Anyway" next to the message about start.command.
        (macOS 14 and earlier: Control-click start.command > Open.)
      - Windows: click "More info", then "Run anyway".
      - Linux: right-click start_linux.sh > Properties > Permissions and
        tick "Allow executing file as program".

  OPTION B - MANUAL:

    1. Open a terminal/command prompt in the QUAILS folder

    2. Install backend (Python) dependencies:
         cd backend
         python -m venv .venv
         (Mac/Linux) source .venv/bin/activate
         (Windows)   .venv\Scripts\activate
         pip install -r requirements.txt

    3. Install frontend (Node.js) dependencies:
         cd ../frontend
         npm install

    4. That's it! See section 3 for how to run.


================================================================================
  3. RUNNING THE APP
================================================================================

  QUICK START:

    Windows: Double-click "start.bat"
    macOS:   Double-click "start.command"
    Linux:   Double-click "start_linux.sh"

    The app opens in your browser at: http://localhost:5173

    To stop: double-click "stop.bat" (Windows) or "stop.command" (macOS),
    or close the launcher window (macOS/Linux).

  MANUAL START (if you prefer):

    You need TWO terminal windows:

    Terminal 1 - Backend:
      cd backend
      python app.py

    Terminal 2 - Frontend:
      cd frontend
      npm run dev

    Then open your browser to: http://localhost:5173

    Make sure Ollama is running before starting analysis:
      ollama serve


================================================================================
  4. USING QUAILS (step-by-step)
================================================================================

  STEP 0: CONFIGURE AI MODEL (optional)
  -------------------------
  - Click "AI Settings" on the home page (next to "New Project")
  - By default, QUAILS uses Ollama (local) with the gemma3 model
  - To use another model:
    1. Click "Load Models" to see the models installed in Ollama
    2. Select a model from the dropdown
    3. Click "Set as Active"
  - The health banner at the top shows your current connection status

  ** PRIVACY NOTE: All analysis runs locally; your data stays on your
     machine. See the DATA PRIVACY NOTICE at the top of this file. **

  STEP 1: CREATE A PROJECT
  -------------------------
  - Click "New Project" on the home page
  - Give it a title and optional description
  - Click "Create" -- you'll be taken to the project workspace

  STEP 2: UPLOAD DOCUMENTS
  -------------------------
  - Click "Upload Documents" in the left sidebar
  - Drag and drop files or click to browse
  - Supported formats: .txt .md .csv .xlsx .xls .numbers .docx .pdf .html
  - Each document is parsed into units (sentences, paragraphs, etc.)
  - You can change the unit type in Settings (left sidebar)

  STEP 3: CONFIGURE SETTINGS
  -------------------------
  - Click "Settings" in the left sidebar
  - Unit Type: how to split documents (sentence, paragraph, document, or line)
  - Context Window: how many surrounding units to include for context (0-10)
  - LLM Model: which Ollama model to use (e.g., gemma3, llama3)
  - Thresholds: minimum confidence levels for detection, labeling, and themes

  STEP 4: BUILD YOUR ANALYSIS FLOW
  -------------------------
  The Flow Editor tab is where you design your analysis pipeline.

  Add blocks from the panel on the left:
    - "Project Spec" (Start) -- always add this first
    - "Open-Coding Analysis" -- Block Type 1: detects relevant units + assigns labels
    - "Theme Identification" -- Block Type 2: groups labels into themes
    - "Category Builder" -- Block Type 3: nests themes into categories
    - "Custom Prompt" -- Block Type 4: run any custom LLM prompt
    - "Outputs & Report" (End) -- always add this last

  Connect blocks by dragging from one block's bottom handle to another's
  top handle. Human Review checkpoints are automatically inserted between
  analysis blocks, flagging where you should review and correct results
  before running the next block.

  Click any block to open its settings panel on the right:
    - Open-Coding Analysis: set detection prompt, label prompt, thresholds
    - Theme Identification: set input block ID, theme threshold
    - Category Builder: set input block ID, max categories
    - Custom Prompt: set prompt text, input source, output format

  Click "Save Flow" to save your configuration.

  STEP 5: MODEL ALIGNMENT (optional but recommended)
  -------------------------
  Go to the "Alignment" tab to calibrate the LLM:
    1. Create Sample -- randomly selects units from your corpus
    2. Human Coding -- you label each sample unit (TRUE/FALSE + label)
    3. Submit Labels -- computes Cohen's Kappa (agreement score)
    4. Optimize -- automatically tweaks prompts to improve agreement

  Kappa interpretation:
    < 0.20  Slight agreement
    0.21-0.40  Fair agreement
    0.41-0.60  Moderate agreement
    0.61-0.80  Substantial agreement
    > 0.81  Almost perfect agreement

  STEP 6: RUN THE ANALYSIS
  -------------------------
  - Go to the Flow Editor tab
  - Click "Validate" to check your flow for errors
  - Click "Run Analysis" to start
  - Watch progress in the Console panel (click "Console" in the tab bar)
  - Click "Stop Analysis" to pause at any time (you can resume later)

  STEP 7: REVIEW RESULTS
  -------------------------
  QUAILS flags what needs human review at each step:
    - Low-confidence decisions are color-coded so you can review them first
    - Units judged not relevant are kept in a separate "_false" file for audit
    - Rubric scores below the confidence threshold are left blank for you
      to score by hand
    - Review checkpoints between blocks mark where to check results before
      the next round. Run blocks one at a time to review between rounds.

  - "Data Browser" tab: view CSV outputs in a spreadsheet grid
    - Enter the block ID and filename, click Load
    - Confidence scores are color-coded (green=high, yellow=medium, red=low)
    - Click a unit_id to jump to it in the Document Viewer
    - You can edit labels and reasoning directly in the grid

  - "Document Viewer" tab: view original documents with unit highlighting
    - Select a document from the left panel
    - Units are listed in the right panel
    - Selected units are highlighted in the text

  STEP 8: GENERATE REPORT
  -------------------------
  The final "Outputs & Report" block generates a Markdown report
  summarizing all analysis results, settings, and alignment scores.


================================================================================
  5. TROUBLESHOOTING
================================================================================

  PROBLEM: "Python is not installed or not on PATH"
  FIX: Reinstall Python and CHECK "Add Python to PATH" during install.
       Or add Python to your PATH manually.

  PROBLEM: "npm install" fails or takes forever
  FIX: Make sure you have a working internet connection. Try:
       npm cache clean --force
       npm install

  PROBLEM: "pip install" fails with build errors
  FIX: Some packages may not support the newest Python. Try Python 3.12
       from https://www.python.org/downloads/release/python-3128/

  PROBLEM: Ollama not connecting / LLM not responding
  FIX: Make sure Ollama is running:
       ollama serve
       And that you have a model installed:
       ollama pull gemma3
       Then check that the AI Settings health banner shows "Connected".

  PROBLEM: "Port 5174 already in use"
  FIX: Another app is using port 5174. Either close it, or edit
       backend/app.py and change the port number on the last line
       (and match it in frontend/vite.config.js proxy targets).

  PROBLEM: Browser shows blank page
  FIX: Make sure BOTH backend and frontend are running.
       Backend = python app.py (port 5174)
       Frontend = npm run dev (port 5173)
       Open http://localhost:5173 (not 5174).

  PROBLEM: "Analysis stopped" or "LLM error" in console
  FIX: Check that Ollama is connected. Go to AI Settings and verify the
       health banner shows "Connected". Then try:
       ollama list
       ollama run gemma3 "hello"

  PROBLEM: File upload fails
  FIX: Check the file format is supported (.txt .md .csv .xlsx .xls .numbers
       .docx .pdf .html). PDFs must contain actual text (scanned images won't
       work without OCR). For .doc files, convert to .docx first.

  PROBLEM: Delete project fails on Windows
  FIX: Close any file explorer windows open to the projects folder, then
       try again.


================================================================================
  FILE STRUCTURE
================================================================================

  quails/
  ├── start.bat              <-- Double-click to run (Windows)
  ├── start.command          <-- Double-click to run (macOS)
  ├── start_linux.sh         <-- Double-click to run (Linux)
  ├── start.sh               <-- Shared launcher for macOS/Linux
  ├── stop.bat / stop.command / stop.sh  <-- Stop QUAILS
  ├── README.txt             <-- This file
  ├── backend/               <-- Python/Flask server
  │   ├── app.py             <-- Backend entry point
  │   ├── config.py          <-- Configuration and defaults
  │   ├── requirements.txt   <-- Python package list
  │   ├── .env               <-- Model selection and settings (auto-created)
  │   ├── api/               <-- REST API endpoints
  │   └── services/          <-- Business logic
  ├── frontend/              <-- React/Vite web interface
  │   ├── package.json       <-- npm package list
  │   └── src/               <-- React components
  └── projects/              <-- Your project data (created at runtime)

  Each project you create gets its own folder under projects/ with its own
  git history, uploaded documents, parsed data, and analysis outputs.


================================================================================
  SUPPORTED DOCUMENT FORMATS
================================================================================

  .txt    Plain text
  .md     Markdown
  .csv    Comma-separated values (each row = one unit)
  .xlsx   Excel (modern)
  .xls    Excel (legacy)
  .numbers  Mac Numbers spreadsheet (first sheet/table only)
  .docx   Word document
  .pdf    PDF (text-based only; scanned images need OCR, not supported)
  .html   Web page
  .doc    Word (legacy) -- requires LibreOffice installed for conversion


================================================================================
