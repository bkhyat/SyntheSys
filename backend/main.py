import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from . import database
from .llm_service import (
    DataExtractionRequest,
    FieldDefinition,
    PaperInput,
    ScreeningInput,
    SynthesisPaperItem,
    SynthesisRequest,
    clean_unwanted_section_summaries,
    extract_batch_data_with_llm,
    generate_manuscript_summaries,
    get_llm_status,
    screen_papers_with_llm,
    synthesize_papers_with_llm,
)
from .pdf_parser import extract_manuscript
from .section_matcher import apply_manual_section_mappings

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
_manuscript_migration_guard = asyncio.Lock()
_manuscript_migration_locks: dict[str, asyncio.Lock] = {}

MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024
MANUSCRIPT_ROOT = Path(
    os.getenv("FIELDNOTE_MANUSCRIPT_DIR", Path(__file__).resolve().parent.parent / "data" / "manuscripts")
)

app = FastAPI(title="SyntheSys Screening & Synthesis API", version="0.1.0")


class SectionMappingItem(BaseModel):
    original_title: str = Field(default="")
    page: int | None = Field(default=None)
    line: int | None = Field(default=None)
    standard_section: str | None = Field(default=None)
    is_excluded: bool | None = Field(default=None)


class UpdateSectionMappingsRequest(BaseModel):
    mappings: list[SectionMappingItem] = Field(default_factory=list)


class ManuscriptMetadataInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    file_name: str = Field(alias="fileName")
    page_count: int = Field(alias="pageCount", ge=0)
    line_count: int = Field(alias="lineCount", ge=0)
    extracted_at: str = Field(alias="extractedAt")
    warnings: list[str] = Field(default_factory=list)


class ProjectPaperInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    title: str = ""
    authors: str = ""
    year: str = ""
    journal: str = ""
    doi: str = ""
    url: str = ""
    abstract: str = ""
    include: str | None = None
    decision: str | None = None
    explanation: str | None = None
    score: int | None = Field(default=None, ge=0, le=10)
    rationale: str | None = None
    manual_visibility: str | None = Field(default=None, alias="manualVisibility")
    extracted_data: dict[str, Any] | None = Field(default=None, alias="extractedData")
    manuscript: ManuscriptMetadataInput | None = None



class ExtractionFieldConfig(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1)
    description: str = Field(default="")


class ProjectListInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    min_score: int = Field(default=9, alias="minScore", ge=0, le=10)
    stage_type: str = Field(default="standard", alias="stageType")
    inclusion_criteria: str = Field(default="", alias="inclusionCriteria")
    exclusion_criteria: str = Field(default="", alias="exclusionCriteria")
    extraction_fields: list[dict[str, Any]] = Field(default_factory=list, alias="extractionFields")
    synthesis_text: str = Field(default="", alias="synthesisText")
    synthesis_prompt: str = Field(default="", alias="synthesisPrompt")
    papers: list[ProjectPaperInput] = Field(default_factory=list)


class ProjectInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    created_at: str = Field(alias="createdAt")
    lists: list[ProjectListInput] = Field(default_factory=list)


@app.get("/api/projects")
async def list_projects() -> list[dict[str, Any]]:
    return await run_in_threadpool(database.get_projects)


@app.put("/api/projects")
async def save_projects(projects: list[ProjectInput]) -> list[dict[str, Any]]:
    await run_in_threadpool(
        database.replace_projects,
        [project.model_dump(by_alias=True) for project in projects],
    )
    return await run_in_threadpool(database.get_projects)


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, str]:
    await run_in_threadpool(database.delete_project, project_id)
    return {"status": "deleted", "id": project_id}


def _manuscript_directory(paper_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", paper_id):
        raise HTTPException(status_code=422, detail="Invalid paper ID.")
    return MANUSCRIPT_ROOT / paper_id


@app.post("/api/papers/{paper_id}/manuscript")
async def upload_manuscript(paper_id: str, file: UploadFile = File(...)) -> JSONResponse:
    directory = _manuscript_directory(paper_id)
    if not await run_in_threadpool(database.paper_exists, paper_id):
        raise HTTPException(status_code=404, detail="Paper not found in the project database.")
    original_name = Path(file.filename or "manuscript.pdf").name
    if not original_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Upload a PDF manuscript.")

    pdf_bytes = await file.read(MAX_MANUSCRIPT_BYTES + 1)
    if len(pdf_bytes) > MAX_MANUSCRIPT_BYTES:
        raise HTTPException(status_code=413, detail="PDF must be 50 MB or smaller.")
    if not pdf_bytes.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="The uploaded file is not a valid PDF.")

    try:
        document = await run_in_threadpool(extract_manuscript, pdf_bytes, paper_id, original_name)
    except Exception as error:
        logger.info("Could not parse manuscript for paper %s: %s", paper_id, error)
        raise HTTPException(
            status_code=422,
            detail="Could not parse this PDF. It may be corrupt, password-protected, or unsupported.",
        ) from error

    extracted_at = datetime.now(timezone.utc).isoformat()
    document["extracted_at"] = extracted_at

    try:
        figure_previews = await run_in_threadpool(_render_figure_previews, document, pdf_bytes)
    except Exception as error:
        logger.info("Could not render figure previews for paper %s: %s", paper_id, error)
        figure_previews = []
    await run_in_threadpool(database.save_manuscript, document, pdf_bytes, figure_previews)

    return JSONResponse({
        "paper_id": paper_id,
        "file_name": original_name,
        "page_count": document["page_count"],
        "line_count": document["line_count"],
        "extracted_at": extracted_at,
        "warnings": document["warnings"],
        "document": document,
    })


@app.get("/api/papers/{paper_id}/manuscript")
async def get_manuscript(paper_id: str) -> dict[str, Any]:
    return await _get_current_manuscript(paper_id)


@app.put("/api/papers/{paper_id}/section-mappings")
async def update_section_mappings_endpoint(
    paper_id: str,
    request: UpdateSectionMappingsRequest,
) -> dict[str, Any]:
    document = await _get_current_manuscript(paper_id)
    pdf_bytes = await run_in_threadpool(database.get_manuscript_pdf, paper_id)
    mappings_data = [item.model_dump() for item in request.mappings]
    document = apply_manual_section_mappings(document, mappings_data)
    await run_in_threadpool(database.save_manuscript, document, pdf_bytes, None)
    return document


@app.post("/api/papers/{paper_id}/summarize")
async def summarize_manuscript_endpoint(paper_id: str) -> dict[str, Any]:
    document = await _get_current_manuscript(paper_id)
    pdf_bytes = await run_in_threadpool(database.get_manuscript_pdf, paper_id)
    document = await generate_manuscript_summaries(document)
    await run_in_threadpool(database.save_manuscript, document, pdf_bytes, None)
    return document


async def _get_current_manuscript(paper_id: str) -> dict[str, Any]:
    _manuscript_directory(paper_id)
    document = await run_in_threadpool(database.get_manuscript, paper_id)
    legacy_path = MANUSCRIPT_ROOT / paper_id / "document.json"
    if document is None and legacy_path.is_file():
        document = await run_in_threadpool(lambda: json.loads(legacy_path.read_text(encoding="utf-8")))
    if document is None:
        raise HTTPException(status_code=404, detail="No manuscript is attached to this paper.")

    if document.get("schema_version", 0) < 3 or "overall_summary" not in document:
        async with _manuscript_migration_guard:
            migration_lock = _manuscript_migration_locks.setdefault(paper_id, asyncio.Lock())
        async with migration_lock:
            document = await run_in_threadpool(database.get_manuscript, paper_id) or document
            if document.get("schema_version", 0) < 3 or "mapped_sections" not in document:
                pdf_bytes = await run_in_threadpool(database.get_manuscript_pdf, paper_id)
                if pdf_bytes is None:
                    pdf_path = MANUSCRIPT_ROOT / paper_id / "manuscript.pdf"
                    if pdf_path.is_file():
                        pdf_bytes = await run_in_threadpool(pdf_path.read_bytes)
                if pdf_bytes:
                    file_name = document.get("file_name", "manuscript.pdf")
                    try:
                        upgraded_document = await run_in_threadpool(extract_manuscript, pdf_bytes, paper_id, file_name)
                    except Exception:
                        logger.exception("Could not upgrade manuscript extraction for paper %s", paper_id)
                        return document

                    upgraded_document["extracted_at"] = datetime.now(timezone.utc).isoformat()
                    if "overall_summary" in document:
                        upgraded_document["overall_summary"] = document["overall_summary"]

                    old_figure_keys = [(figure.get("label"), figure.get("page_number")) for figure in document.get("figures", [])]
                    new_figure_keys = [(figure.get("label"), figure.get("page_number")) for figure in upgraded_document["figures"]]
                    try:
                        previews = await run_in_threadpool(_render_figure_previews, upgraded_document, pdf_bytes)
                    except Exception:
                        logger.exception("Could not refresh figure previews for paper %s", paper_id)
                        previews = None if old_figure_keys == new_figure_keys else []
                    await run_in_threadpool(database.save_manuscript, upgraded_document, pdf_bytes, previews)
                    document = upgraded_document
    clean_unwanted_section_summaries(document.get("sections", []))
    return document


@app.get("/api/papers/{paper_id}/manuscript.pdf")
async def get_manuscript_pdf(paper_id: str) -> FileResponse:
    pdf_bytes = await run_in_threadpool(database.get_manuscript_pdf, paper_id)
    if pdf_bytes is not None:
        return Response(pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": "inline"})
    pdf_path = _manuscript_directory(paper_id) / "manuscript.pdf"
    if pdf_path.is_file():
        return FileResponse(pdf_path, media_type="application/pdf", content_disposition_type="inline")
    raise HTTPException(status_code=404, detail="No manuscript is attached to this paper.")


@app.get("/api/papers/{paper_id}/figures/{figure_index}.png")
async def get_manuscript_figure(paper_id: str, figure_index: int) -> Response:
    _manuscript_directory(paper_id)
    document = await _get_current_manuscript(paper_id)
    if figure_index < 0 or figure_index >= len(document["figures"]):
        raise HTTPException(status_code=404, detail="Figure not found.")
    figure = document["figures"][figure_index]
    preview = await run_in_threadpool(database.get_figure_preview, paper_id, figure_index)
    if preview is not None:
        return Response(preview, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})
    bbox = figure.get("image_bbox")
    if not bbox:
        raise HTTPException(status_code=404, detail="No embedded image was found for this figure.")

    try:
        pdf_bytes = await run_in_threadpool(database.get_manuscript_pdf, paper_id)
        pdf_path = MANUSCRIPT_ROOT / paper_id / "manuscript.pdf"
        if pdf_bytes is None and pdf_path.is_file():
            pdf_bytes = await run_in_threadpool(pdf_path.read_bytes)
        if pdf_bytes is None:
            raise HTTPException(status_code=404, detail="No manuscript PDF is attached.")
        image_bytes = await run_in_threadpool(_render_figure_crop, pdf_bytes, figure["page_number"], bbox)
    except Exception as error:
        logger.info("Could not render figure %s for paper %s: %s", figure_index, paper_id, error)
        raise HTTPException(status_code=422, detail="Could not render this figure preview.") from error
    await run_in_threadpool(database.save_figure_preview, paper_id, figure_index, image_bytes)
    return Response(image_bytes, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


FIGURE_RENDER_DPI = 288


def _crop_page_image(page_image: Any, bbox: dict[str, float], resolution: int) -> bytes:
    from io import BytesIO

    resolution_scale = resolution / 72
    left = max(0, round(bbox["x0"] * resolution_scale))
    top = max(0, round(bbox["top"] * resolution_scale))
    right = min(page_image.width, round(bbox["x1"] * resolution_scale))
    bottom = min(page_image.height, round(bbox["bottom"] * resolution_scale))
    if right <= left or bottom <= top:
        raise ValueError("Figure image bounds are empty.")
    output = BytesIO()
    page_image.crop((left, top, right, bottom)).save(output, format="PNG", optimize=True)
    return output.getvalue()


def _render_figure_previews(document: dict[str, Any], pdf_bytes: bytes) -> list[tuple[int, bytes]]:
    from io import BytesIO

    import pdfplumber

    resolution = FIGURE_RENDER_DPI
    rendered_pages = {}
    previews = []
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for figure_index, figure in enumerate(document["figures"]):
            bbox = figure.get("image_bbox")
            if not bbox:
                continue
            page_number = figure["page_number"]
            if page_number not in rendered_pages:
                rendered_pages[page_number] = pdf.pages[page_number - 1].to_image(resolution=resolution).original
            previews.append((figure_index, _crop_page_image(rendered_pages[page_number], bbox, resolution)))
    return previews


def _render_figure_crop(pdf_bytes: bytes, page_number: int, bbox: dict[str, float]) -> bytes:
    from io import BytesIO

    import pdfplumber

    resolution = FIGURE_RENDER_DPI
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        page_image = pdf.pages[page_number - 1].to_image(resolution=resolution).original
        return _crop_page_image(page_image, bbox, resolution)


@app.get("/api/llm/status")
async def get_llm_status_endpoint() -> dict[str, Any]:
    return await get_llm_status()


@app.post("/api/screen")
async def screen_papers(screen_request: ScreeningInput) -> JSONResponse:
    if not screen_request.inclusion_criteria.strip():
        return JSONResponse({"error": "Inclusion criteria are required."}, status_code=400)

    paper_ids = [paper.id for paper in screen_request.papers]
    if len(set(paper_ids)) != len(paper_ids):
        return JSONResponse({"error": "Paper IDs must be unique within a screening request."}, status_code=400)

    try:
        results = await screen_papers_with_llm(screen_request)
        return JSONResponse({"results": results})
    except RuntimeError as error:
        logger.warning("Screening service error: %s", error)
        return JSONResponse({"error": str(error)}, status_code=502)
    except Exception as error:
        logger.exception("Unexpected error during screening: %s", error)
        return JSONResponse({"error": f"Screening failed: {error}"}, status_code=500)


@app.post("/api/extract-data")
async def extract_data_endpoint(request: DataExtractionRequest) -> JSONResponse:
    if not request.fields:
        return JSONResponse({"error": "At least one extraction field is required."}, status_code=400)

    papers_payload = []
    for paper in request.papers:
        manuscript = await run_in_threadpool(database.get_manuscript, paper.id)
        papers_payload.append({
            "id": paper.id,
            "title": paper.title,
            "manuscript": manuscript,
        })

    try:
        results = await extract_batch_data_with_llm(papers_payload, request.fields)
        return JSONResponse({"results": results})
    except RuntimeError as error:
        logger.warning("Data extraction service error: %s", error)
        return JSONResponse({"error": str(error)}, status_code=502)
    except Exception as error:
        logger.exception("Unexpected error during data extraction: %s", error)
        return JSONResponse({"error": f"Data extraction failed: {error}"}, status_code=500)


@app.post("/api/synthesize")
async def synthesize_endpoint(request: SynthesisRequest) -> JSONResponse:
    if not request.papers:
        return JSONResponse({"error": "At least one paper is required for synthesis."}, status_code=400)

    try:
        synthesis_text = await synthesize_papers_with_llm(request)
        return JSONResponse({
            "synthesis": synthesis_text,
            "paperCount": len(request.papers),
        })
    except RuntimeError as error:
        logger.warning("Synthesis service error: %s", error)
        return JSONResponse({"error": str(error)}, status_code=502)
    except Exception as error:
        logger.exception("Unexpected error during synthesis: %s", error)
        return JSONResponse({"error": f"Synthesis failed: {error}"}, status_code=500)