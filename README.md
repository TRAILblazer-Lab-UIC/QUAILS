# QUAILS — Qualitative AI Labeling Support

A local Python/React/Flask web application for automating thematic text analysis in qualitative research. Uses LLMs for inference — local via Ollama, or cloud providers (OpenAI, Anthropic, Google Gemini, Azure OpenAI) — with a visual flow editor for designing multi-round analysis workflows and enforced human review between rounds.

> **Data Privacy:** When using **Ollama (local)**, no data ever leaves your machine — all LLM inference runs entirely on your local hardware. When using a **cloud provider**, your document text is sent to that provider's servers. Be aware of research ethics, IRB requirements, and legal regulations (HIPAA, FERPA, GDPR, etc.) regarding personally identifiable information (PII) or confidential data with third-party AI services. **You are solely liable for any third-party data sharing that occurs through your use of this application.** This software is provided "AS-IS" without warranty of any kind.

## Prerequisites

- Python 3.14+
- Node.js 24+ / npm 11+
- Ollama (with at least one model installed, e.g., `gemma3`) — *optional if using a cloud provider*
- Git

## Setup

### Backend

```bash
cd backend
pip install -r requirements.txt
```

Note: spaCy is incompatible with Python 3.14 — the app uses a regex-based sentence segmenter as a fallback.

### Frontend

```bash
cd frontend
npm install
```

## Running

Start both servers:

**Terminal 1 — Backend (Flask):**
```bash
cd backend
python app.py
```
Backend runs on http://127.0.0.1:5174

**Terminal 2 — Frontend (Vite dev server):**
```bash
cd frontend
npm run dev
```
Frontend runs on http://localhost:5173 (proxies API calls to Flask)

If using Ollama, ensure it is running (`ollama serve`) — the app will attempt to auto-start it if not. If using a cloud provider, configure your API key in **AI Settings** from the home page.

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
- **LLM**: Multi-provider support — Ollama (local), OpenAI, Anthropic, Google Gemini, Azure OpenAI. Provider and model selection managed via the AI Settings page. API keys stored locally in `backend/.env` (gitignored).
- **Data**: JSON-backed project files, CSV outputs, per-project git repos for version control.

## Block Types

1. **Open-Coding Analysis**: Two-step LLM evaluation (TRUE/FALSE detection + labeling) with confidence scoring
2. **Theme Identification**: Constant comparison method — assigns labels to themes
3. **Category Building**: Nests themes into user-defined categories
4. **Custom Prompt**: Generic user-defined LLM prompt block

## Key Features

- Visual flow editor with drag-and-drop block placement
- Auto-inserted human review gates between analysis blocks
- Confidence scoring via logprob extraction
- Model alignment testing with Cohen's Kappa
- Prompt optimization loop
- Auto-save with idle detection
- Per-project git version control
- Resume-able analysis (crash recovery)
- Multi-format document support (txt, md, csv, xlsx, xls, numbers, docx, pdf, html)
- Multi-provider LLM support with API key management
- Full local processing with Ollama — no data leaves your machine
