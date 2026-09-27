# Fieldnote

Fieldnote is a local-first workspace for organizing paper screening in projects and lists. CSV and Excel files are parsed in the browser; projects, lists, papers, scores, and manuscript data are stored in SQLite.

## Run locally

### Quick Start (Automated Script)

Run the included startup script (auto-configures `.env`, virtual environment, dependencies, and boots backend + frontend):

```bash
./start.sh
```

### Manual Setup

1. Create and activate a Python virtual environment with `python3 -m venv .venv` and `source .venv/bin/activate`.
2. Install the API dependencies with `python -m pip install -r requirements.txt`.
3. Install the web dependencies with `npm install`.
4. Create `.env` from `.env.example` and set `GEMINI_API_KEY` to enable AI screening.
5. Run `npm run dev` (or `npm start`) and open the URL printed by Vite.

The Gemini key is read only by the local FastAPI server. Screening uses Gemini 2.5 Flash and returns a 0–10 inclusion confidence score with a brief rationale. The score slider starts at 9; papers below the threshold remain in the list and can be shown by lowering it.

## Manuscripts

Select one paper to attach or replace its PDF, or open its parsed manuscript. PDFs up to 50 MB and 500 pages are stored as SQLite BLOBs along with their structured extraction JSON. The SQLite database at `data/fieldnote.sqlite3` is created automatically and ignored by Git. Existing projects in the older browser-storage format are migrated once when the database is empty.

PDF text is extracted with `pdfplumber`. Parsed pages preserve 1-based page and reading-order line numbers plus text bounding boxes in PDF points, measured from the page's top-left. Numbered sections and subsections expand to show extracted text in-app, with separate links to source PDF locations. Embedded figure images, detected table cells, and references are also shown in-app with source-page links. Image-only scanned PDFs can be attached, but this version does not OCR them; it shows a warning when no selectable text is found. Layout and caption detection are heuristic, so check the source PDF when exact structure matters.