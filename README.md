# QUAILS — Qualitative AI Labeling Support

A local Python/React/Flask web application for automating thematic text analysis in qualitative research. Uses open-weight LLMs that run entirely on your own computer through Ollama, with a visual flow editor for designing multi-round analysis workflows. At each step, QUAILS flags results that need human review: low-confidence decisions, rejected units, and checkpoints between analysis rounds.

> **Data Privacy:** No data ever leaves your machine — all LLM inference runs entirely on your local hardware through Ollama. You remain responsible for handling research data in line with research ethics, IRB requirements, and legal regulations (HIPAA, FERPA, GDPR, etc.) regarding personally identifiable information (PII) or confidential data. This software is provided "AS-IS" without warranty of any kind.

> 🚧 **QUAILS is a work in progress and is actively being updated.** Features, file formats and outputs may change between releases, and some features described here are still being built or refined. Please [open an issue](https://github.com/TRAILblazer-Lab-UIC/QUAILS/issues) if you find a bug or have a suggestion.

## Getting started

### 1. Install the prerequisites

Install these once. The launcher checks for each one and tells you what is missing.

| Software | Version | Download |
|---|---|---|
| Python | 3.10 or newer | https://www.python.org/downloads/ (on Windows, tick **"Add python.exe to PATH"**) |
| Node.js | 20.19+ or 22.12+ (the current LTS is fine) | https://nodejs.org/ |
| Git | any recent version | https://git-scm.com/downloads (macOS: run `xcode-select --install`) |
| Ollama | any recent version | https://ollama.com/download |

After installing Ollama, download at least one model, for example `ollama pull gemma3`. You can also find and download models that fit your computer from **AI Settings** inside QUAILS.

### 2. Download QUAILS

Either clone the repository:

```bash
git clone https://github.com/TRAILblazer-Lab-UIC/QUAILS.git
```

or click **Code → Download ZIP** on this page and unzip it. QUAILS can live in any folder; nothing is tied to a specific location.

### 3. Start QUAILS with one click

| Your computer | Double-click | To stop |
|---|---|---|
| macOS | `start.command` | Close the Terminal window, or double-click `stop.command` |
| Windows | `start.bat` | Double-click `stop.bat` |
| Linux | `start_linux.sh` (choose **Run** or **Run in Terminal**) | Close the terminal window, or run `./stop.sh` |

The launcher is also the installer. Every time it runs, it:

- checks that Python, Node.js, npm, Git and Ollama are installed and new enough;
- creates a private Python environment in `backend/.venv` on the first run, so nothing is installed into your system Python;
- checks every package listed in `backend/requirements.txt` and installs only what is missing or out of date;
- installs the frontend packages on the first run, and again whenever they change;
- starts Ollama if it isn't already running, then starts QUAILS and opens http://localhost:5173 in your browser.

The first launch downloads packages and can take several minutes. Later launches start in seconds. On Linux, the first launch also adds QUAILS to your applications menu. If a step fails, the window stays open with the error message. Logs are written to `backend/logs/`.

### 4. If your computer warns that the launcher is unverified

The launchers are plain scripts that you can read in any text editor. They aren't signed with a paid developer certificate, so your operating system may warn you the first time you open one. To allow it:

**macOS** ("Apple could not verify 'start.command' is free of malware", or "unidentified developer")
1. Click **Done** (or **OK**). Don't click Move to Trash.
2. Open **System Settings → Privacy & Security** and scroll down to **Security**.
3. Next to the message about `start.command`, click **Open Anyway**, then enter your password.
4. Double-click `start.command` again and click **Open**.

On macOS 14 (Sonoma) and earlier, you can instead Control-click (or right-click) `start.command`, choose **Open**, then click **Open**. Do the same for `stop.command` the first time you use it.

*Terminal alternative:* allow the whole folder at once with `xattr -dr com.apple.quarantine /path/to/QUAILS`. If macOS says the file can't be executed because you lack permissions, run `chmod +x /path/to/QUAILS/*.command /path/to/QUAILS/*.sh`.

**Windows** ("Windows protected your PC" from Microsoft Defender SmartScreen)
1. Click **More info**.
2. Click **Run anyway**.

If you see "Open File – Security Warning" instead, click **Run**. To stop the warnings permanently, right-click `start.bat` → **Properties**, tick **Unblock** at the bottom of the General tab, and click **OK**. If you downloaded the ZIP, you can unblock the ZIP file the same way *before* unzipping it, which unblocks every file inside.

**Linux** (double-clicking opens the script in a text editor, or nothing happens)
1. Make the launchers executable: right-click `start_linux.sh` → **Properties → Permissions** and tick **Allow executing file as program**. Or, in a terminal: `chmod +x start_linux.sh start.sh stop.sh`.
2. Double-click `start_linux.sh` again and choose **Run** or **Run in Terminal**. In GNOME Files you may need to right-click and choose **Run as a Program**.

Or just run `./start_linux.sh` from a terminal in the QUAILS folder.

### 5. First steps in QUAILS

1. Open **AI Settings** from the home page and choose the Ollama model to use.
2. Click **New Project**, then upload your documents.
3. Build an analysis flow in the **Analysis Builder** and run it block by block, reviewing the flagged results between rounds.

`README.txt` (also available inside the app) has a step-by-step guide and troubleshooting tips.

### Manual setup (for developers)

If you prefer to run the two servers yourself:

```bash
# Terminal 1: backend (Flask), runs on http://127.0.0.1:5174
cd backend
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py

# Terminal 2: frontend (Vite), runs on http://localhost:5173 and proxies API calls to Flask
cd frontend
npm install
npm run dev
```

Make sure Ollama is running (`ollama serve`). The app tries to start it if it isn't.

## Hardware & performance (Apple Silicon, NVIDIA GB10 / DGX Spark, unified memory)

QUAILS is tuned for unified-memory machines, where the GPU uses most of system RAM: Apple Silicon Macs, NVIDIA GB10 systems such as DGX Spark and ASUS Ascent GX10, and AMD Ryzen AI Max.
- **See your hardware:** open **AI Settings → Ollama → Hardware & performance**. It shows:
  - the detected hardware and how much memory the GPU can actually use;
  - which installed models fit at your context window, and which would spill to the CPU (slow);
  - the models currently loaded and their % on GPU;
  - a quick tokens-per-second benchmark.
- **Server settings:**
  - **Apply recommended server settings** sets flash attention, the KV-cache precision (full f16 whenever it fits) and one request at a time.
  - On a Mac with Ollama.app, or with an Ollama that QUAILS started, this restarts Ollama with the settings after you confirm.
  - On Linux systemd installs (typical on DGX Spark / GX10), QUAILS shows the exact `sudo systemctl edit ollama` override to paste. QUAILS never runs sudo.
  - The launchers apply saved settings whenever they start `ollama serve` themselves.
- **Throughput mode:** sending several cases to the model at once is much faster on these machines, but batched requests can change results slightly.
  - It is **off by default**.
  - It is available per comparison ("Cases in parallel") and per optimization job, and, behind a warning, per project for analyses.
  - Every run records the hardware, server settings and parallelism it used.

## Architecture

- **Backend**: Flask + Flask-SocketIO + Flask-CORS. REST API for all data operations, WebSocket for real-time console/progress.
- **Frontend**: React 19 + Vite + Tailwind CSS 4. Uses @xyflow/react for the flow editor, AG Grid for data browsing.
- **LLM**: Local inference through Ollama. Model selection is managed on the AI Settings page and stored locally in `backend/.env` (gitignored).
- **Data**: JSON-backed project files, CSV outputs, per-project git repos for version control.

## Block Types

1. **Open-Coding Analysis**: Two-step LLM evaluation (TRUE/FALSE detection + labeling) with confidence scoring
2. **Theme Identification**: Constant comparison method — assigns labels to themes
3. **Category Building**: Nests themes into user-defined categories
4. **Custom Prompt**: Generic user-defined LLM prompt block

## Key Features

- Visual flow editor with drag-and-drop block placement
- Human review flagged at each step: low-confidence results are color-coded, rejected units are kept for audit, and review checkpoints are auto-inserted between analysis blocks
- Confidence scoring via logprob extraction
- Model alignment testing with Cohen's Kappa
- Prompt optimization loop
- Auto-save with idle detection
- Per-project git version control
- Resume-able analysis (crash recovery)
- Multi-format document support (txt, md, csv, xlsx, xls, numbers, docx, pdf, html)
- Full local processing with Ollama — no data leaves your machine
