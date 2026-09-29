# SyntheSys 🔬✨

**SyntheSys** is an AI-assisted, local-first systematic literature review and synthesis platform. It accelerates academic research from initial search screening to deep full-text manuscript extraction and PRISMA-style narrative synthesis.

---

## 🌟 Key Features

### 1. Multi-Stage Systematic Review Workflow
- **Identification & Screening (Stage 1)**: Import CSV/Excel bibliographies (PubMed, Scopus, Web of Science, arXiv). Run AI-assisted title and abstract screening with discrete inclusion decisions (`Yes`, `No`, `Not Sure`), evidence-based explanations, and fast interactive decision filtering.
- **Full-Text Eligibility (Stage 2)**: Attach full-text PDF manuscripts, verify inclusion/exclusion criteria, and manage candidate papers.
- **AI Data Extraction (Stage 3)**: Extract custom user-defined research fields (e.g., *Methodology*, *Benchmark Datasets*, *Evaluation Metrics*, *Limitations*) across papers into structured, interactive data tables.
- **Systematic Synthesis (Stage 4)**: Generate comprehensive, PRISMA/SLR-style narrative syntheses that group papers by methodological paradigms, compare strengths and trade-offs, and outline research gaps. Features a dual **View / Edit** markdown mode, full **LaTeX formula rendering** ($\text{IC}_{50}$, mathematical equations), ASCII hierarchy trees, one-click copy, and persistent revision drafts.

### 2. Deep Manuscript Parsing & Inspection
- **High-Definition Figures (288 DPI / 4x Scale)**: Automatically extracts plots, chemical structures, and architectural diagrams using tight spatial clustering. Includes an interactive full-resolution lightbox viewer with zoom.
- **Structured Table Extraction**: Intelligently unpacks multi-line table headers and grid cells into searchable, formatted tables.
- **Hierarchical Outlines & PDF Navigation**: Hierarchical section outlines with AI-generated section summaries and direct jump-links to exact source PDF pages and lines.

### 3. Local-First & Privacy-Focused
- **SQLite Database**: Local database (`data/fieldnote.sqlite3`) stores project structures, paper metadata, extracted fields, and PDF BLOBs without cloud storage lock-in.
- **Flexible AI Providers**: Seamless integration with Google Gemini (`gemini-2.5-flash`) or local/remote Ollama instances.

---

## 🚀 Quick Start

### Automated Setup (Recommended)

Run the included automated bootstrapper to configure virtual environments, sync dependencies, and start both backend and frontend servers:

```bash
./start.sh
```

- **Web Application**: [http://localhost:5173](http://localhost:5173)
- **FastAPI Backend & Swagger Docs**: [http://localhost:3001/docs](http://localhost:3001/docs)

### CLI Options for `start.sh`

```bash
./start.sh -b          # Run only the FastAPI backend (port 3001)
./start.sh -f          # Run only the Vite frontend dev server (port 5173)
./start.sh -i          # Install / update all Python and Node.js dependencies
./start.sh -p 8000     # Custom backend port
```

---

## 🛠 Manual Installation

### 1. Backend Setup (FastAPI & Python)
```bash
# Create and activate Python virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Frontend Setup (React & Vite)
```bash
# Install Node dependencies
npm install
```

### 3. Environment Configuration
Create a `.env` file from the provided template:
```bash
cp .env.example .env
```

Configure your environment settings in `.env`:
```env
# Google Gemini API key
GEMINI_API_KEY=your_gemini_api_key_here

# (Optional) Ollama Configuration for local LLM screening
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma:12b

# LLM Provider Preference: auto | gemini | ollama | mock
LLM_PROVIDER=auto
```

### 4. Running the Development Servers
```bash
# Terminal 1: Backend
source .venv/bin/activate
python -m uvicorn backend.main:app --reload --port 3001

# Terminal 2: Frontend
npm run dev
```

---

## 🏗 Tech Stack

- **Frontend**: React 18, TypeScript, Vite, KaTeX (LaTeX math rendering), Lucide Icons, Vanilla CSS Design System
- **Backend**: FastAPI, Python 3.10+, Uvicorn, SQLite3, HTTPX
- **Document & PDF Processing**: `pdfplumber`, `pypdf`, `Pillow`
- **AI / LLM Integration**: Google Gemini 3.8 Flash API (`google-genai` / REST), Ollama

---

## 🧪 Testing

Run backend tests:
```bash
.venv/bin/python -m unittest discover -s tests
```

Run frontend build verification:
```bash
npm run build
```

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.