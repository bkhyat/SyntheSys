"""
LLM Service Module for Fieldnote
Handles AI summarization (manuscript-level and section-level), paper screening,
and structured data extraction using the Google Gemini API.
"""

import asyncio
import json
import logging
import os
import re
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

DEFAULT_GEMINI_MODEL = "gemini-flash-latest"


def _get_gemini_url(model: str | None = None) -> str:
    resolved_model = (model or os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL).strip()
    return f"https://generativelanguage.googleapis.com/v1beta/models/{resolved_model}:generateContent"


class SectionSummaryItem(BaseModel):
    id: str
    title: str = ""
    summary: str


class ManuscriptSummaryOutput(BaseModel):
    overall_summary: str
    section_summaries: list[SectionSummaryItem] = Field(default_factory=list)


class PaperInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    title: str = ""
    authors: str = ""
    year: str = ""
    abstract: str = Field(default="", max_length=12_000)


class ScreeningInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    papers: list[PaperInput] = Field(min_length=1, max_length=20)
    inclusion_criteria: str = Field(alias="inclusionCriteria", min_length=1)
    exclusion_criteria: str = Field(default="", alias="exclusionCriteria")


class ScreeningResult(BaseModel):
    id: str
    score: int = Field(ge=0, le=10)
    rationale: str


class ScreeningOutput(BaseModel):
    results: list[ScreeningResult]


def _is_valid_gemini_key(api_key: str | None) -> bool:
    """Check if Gemini API key is configured with a real key value."""
    if not api_key:
        return False
    stripped = api_key.strip()
    return bool(stripped and stripped.lower() not in ("your_gemini_api_key", "your_api_key", "none", ""))


def _extract_json_string(raw_text: str) -> str:
    """
    Extract clean JSON substring from model output that might contain markdown fences
    (e.g., ```json ... ```) or conversational preamble/postscript.
    """
    text = raw_text.strip()

    # Match ```json ... ``` or ``` ... ```
    code_block_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if code_block_match:
        text = code_block_match.group(1).strip()

    # Direct JSON object or array
    if (text.startswith("{") and text.endswith("}")) or (text.startswith("[") and text.endswith("]")):
        return text

    # Search for outermost JSON object { ... }
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        return text[first_brace : last_brace + 1].strip()

    # Search for outermost JSON array [ ... ]
    first_bracket = text.find("[")
    last_bracket = text.rfind("]")
    if first_bracket != -1 and last_bracket != -1 and last_bracket > first_bracket:
        return text[first_bracket : last_bracket + 1].strip()

    return text


_NON_SUMMARIZABLE_PATTERNS = [
    re.compile(r"^acknowledg(e)?ments?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^references?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^bibliograph(y|ies)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(literature|works|citations?)\s+cited(\b|:|$)", re.IGNORECASE),
    re.compile(r"^author(s)?[\x27\x22\u2019\u2018s]*\s+(contributions?|information|details|affiliations?|notes?)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^credit(\s+authorship)?\s+contribution(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(conflict|conflicts|competing)\s+(of\s+)?interests?(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^declaration(s)?\s+of\s+(competing\s+)?interests?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^disclosures?(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(financial\s+)?funding(\s+information|\s+statement|\s+sources?|\s+and\s+acknowledgments?)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(financial|grant)\s+(support|disclosure)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(data|code|software)(\s+and\s+(code|data|materials?))?\s+availability(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^availability\s+of\s+(data|materials?|supporting\s+data|data\s+and\s+materials?)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(ethics|ethical)(\s+approval|\s+statement|\s+considerations?)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(patient\s+|informed\s+)?consent(\s+for\s+publication)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(institutional\s+review\s+board|irb)(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(supplementary|supplemental|supporting)\s+(materials?|information|files?|data)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(abbreviations?|acronyms?|glossary|nomenclature)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(keywords?|index\s+terms?)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(publisher[\x27\x22\u2019\u2018]?s\s+note|disclaimer|copyright|license)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^about\s+the\s+authors?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^biograph(y|ies)(\b|:|$)", re.IGNORECASE),
]


def normalize_section_title(title: str) -> str:
    """Strip section numbering and markers to get canonical heading title."""
    cleaned = title.strip()
    return re.sub(
        r"^(?:section\s+)?(?:[0-9]+(?:\.[0-9]+)*|[A-Z]|[IVXLCDM]+)[\.\:\-\–\s]+\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()


def is_valid_summarizable_section(
    title: str,
    text: str = "",
    has_children: bool = False,
    min_text_length: int = 15,
) -> bool:
    """Determine if a section is a substantive scientific section suitable for AI summarization."""
    if not title:
        return False
    norm_title = normalize_section_title(title)
    if not norm_title:
        norm_title = title.strip()

    for pattern in _NON_SUMMARIZABLE_PATTERNS:
        if pattern.search(norm_title):
            return False

    # Exclude leaf sections with virtually no body text
    if not has_children and text and len(text.strip()) < min_text_length:
        return False

    return True


def clean_unwanted_section_summaries(sections: list[dict[str, Any]]) -> None:
    """Recursively ensure that unwanted sections do not carry summary text."""
    for s in sections:
        title = s.get("title", "")
        has_children = bool(s.get("children"))
        if not is_valid_summarizable_section(title, has_children=has_children):
            s.pop("summary", None)
        if s.get("children"):
            clean_unwanted_section_summaries(s["children"])


def _build_lines_lookup(pages: list[dict[str, Any]]) -> dict[tuple[int, int], str]:
    """Map (page_number, line_number) to text line."""
    lookup = {}
    for page in pages:
        p_num = page.get("page_number", 1)
        for line in page.get("lines", []):
            l_num = line.get("line_number", 1)
            lookup[(p_num, l_num)] = line.get("text", "")
    return lookup


def _flatten_sections_for_llm(
    sections: list[dict[str, Any]],
    lines_lookup: dict[tuple[int, int], str],
    prefix: str = "sec",
) -> list[dict[str, Any]]:
    """Flatten the recursive section tree into a list of valid items for the LLM."""
    flattened: list[dict[str, Any]] = []
    for idx, sec in enumerate(sections):
        sec_id = f"{prefix}_{idx}"
        title = sec.get("title", f"Section {idx + 1}")
        body_refs = sec.get("line_refs", [])[1:]
        text_lines = [lines_lookup.get((r["page_number"], r["line_number"]), "") for r in body_refs]
        full_text = " ".join(t for t in text_lines if t).strip()

        has_children = bool(sec.get("children"))
        is_summarizable = is_valid_summarizable_section(title, full_text, has_children=has_children)

        # Clear any summary if section is not summarizable
        if not is_summarizable:
            sec.pop("summary", None)
        else:
            item = {
                "id": sec_id,
                "title": title,
                "level": sec.get("level", 1),
                "text_sample": full_text[:3000],
                "node": sec,
            }
            flattened.append(item)

        if sec.get("children"):
            flattened.extend(
                _flatten_sections_for_llm(sec["children"], lines_lookup, prefix=sec_id)
            )
    return flattened


def _extract_first_sentences(text: str, max_sentences: int = 2) -> str:
    """Extract first N sentences from text."""
    if not text:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    clean = [s.strip() for s in sentences if len(s.strip()) > 10]
    return " ".join(clean[:max_sentences])


def generate_dummy_summaries(document: dict[str, Any]) -> dict[str, Any]:
    """Generate realistic fallback/dummy summaries when LLM is unavailable or for testing."""
    pages = document.get("pages", [])
    sections = document.get("sections", [])
    file_name = document.get("file_name", "Manuscript")
    page_count = document.get("page_count", len(pages))
    lines_lookup = _build_lines_lookup(pages)

    # Generate section-level summaries
    def _populate_dummy_section_summaries(sec_list: list[dict[str, Any]]) -> None:
        for sec in sec_list:
            title = sec.get("title", "").strip()
            body_refs = sec.get("line_refs", [])[1:]
            text_lines = [lines_lookup.get((r["page_number"], r["line_number"]), "") for r in body_refs]
            text = " ".join(t for t in text_lines if t).strip()
            has_children = bool(sec.get("children"))

            if not is_valid_summarizable_section(title, text, has_children=has_children):
                sec.pop("summary", None)
            else:
                snippet = _extract_first_sentences(text, 2)
                if snippet:
                    sec["summary"] = f"Key points from {title}: {snippet}"
                elif sec.get("children"):
                    child_titles = [c.get("title", "") for c in sec.get("children", []) if c.get("title") and is_valid_summarizable_section(c.get("title", ""))]
                    if child_titles:
                        sec["summary"] = f"Comprehensive overview covering: {', '.join(child_titles[:4])}."
                    else:
                        sec["summary"] = f"Foundational discussion on {title}."
                else:
                    sec["summary"] = f"Presents foundational details and analytical discussion on {title}."

            if sec.get("children"):
                _populate_dummy_section_summaries(sec["children"])

    _populate_dummy_section_summaries(sections)

    # Generate overall summary using valid top-level sections
    valid_top_sections = [s for s in sections if is_valid_summarizable_section(s.get("title", ""), has_children=bool(s.get("children")))]
    top_titles = [s.get("title", "") for s in valid_top_sections if s.get("title")]
    intro_snippet = ""
    if valid_top_sections:
        intro_refs = valid_top_sections[0].get("line_refs", [])[1:]
        intro_text = " ".join(lines_lookup.get((r["page_number"], r["line_number"]), "") for r in intro_refs).strip()
        intro_snippet = _extract_first_sentences(intro_text, 2)

    if intro_snippet:
        document["overall_summary"] = (
            f"This {page_count}-page manuscript investigates key research objectives across {len(top_titles)} main sections. "
            f"{intro_snippet} It establishes methodology, presents empirical evaluations, and discusses practical implications."
        )
    else:
        document["overall_summary"] = (
            f"Structured scientific manuscript ({page_count} pages) detailing experimental design, data analysis, "
            f"and core findings across: {', '.join(top_titles[:5]) or 'core research sections'}."
        )

    return document


async def _call_gemini_json(
    prompt: str,
    response_schema: dict[str, Any],
    api_key: str,
    model: str | None = None,
    timeout: float = 120.0,
) -> str:
    """Call Google Gemini API with JSON structured response schema."""
    url = _get_gemini_url(model)
    gemini_request = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
        },
    }
    client_timeout = httpx.Timeout(timeout, connect=15.0, read=timeout, write=30.0)
    async with httpx.AsyncClient(timeout=client_timeout) as client:
        response = await client.post(
            url,
            params={"key": api_key},
            json=gemini_request,
        )
    if response.is_error:
        raise httpx.HTTPStatusError(
            f"Gemini API returned HTTP {response.status_code}: {response.text}",
            request=response.request,
            response=response,
        )
    response_json = response.json()
    candidates = response_json.get("candidates", [])
    if not candidates:
        feedback = response_json.get("promptFeedback", {})
        raise RuntimeError(f"Gemini API returned no candidates. Prompt feedback: {feedback}")
    parts = candidates[0].get("content", {}).get("parts", [])
    if not parts or "text" not in parts[0]:
        raise RuntimeError(f"Gemini API response format was unexpected: {response_json}")
    return parts[0]["text"]


async def _call_gemini_text(
    prompt: str,
    api_key: str,
    model: str | None = None,
    timeout: float = 60.0,
) -> str:
    """Call Google Gemini API for freeform text generation (e.g. Markdown synthesis)."""
    url = _get_gemini_url(model)
    gemini_request = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
    }
    client_timeout = httpx.Timeout(timeout, connect=15.0, read=timeout, write=30.0)
    async with httpx.AsyncClient(timeout=client_timeout) as client:
        response = await client.post(
            url,
            params={"key": api_key},
            json=gemini_request,
        )
    if response.is_error:
        raise httpx.HTTPStatusError(
            f"Gemini API returned HTTP {response.status_code}: {response.text}",
            request=response.request,
            response=response,
        )
    response_json = response.json()
    candidates = response_json.get("candidates", [])
    if not candidates:
        feedback = response_json.get("promptFeedback", {})
        raise RuntimeError(f"Gemini API returned no candidates. Prompt feedback: {feedback}")
    parts = candidates[0].get("content", {}).get("parts", [])
    if not parts or "text" not in parts[0]:
        raise RuntimeError(f"Gemini API response format was unexpected: {response_json}")
    return parts[0]["text"]


async def get_llm_status() -> dict[str, Any]:
    """Check configuration for Google Gemini backend."""
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    has_gemini = _is_valid_gemini_key(gemini_key)
    gemini_model = (os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL).strip()

    return {
        "active_provider": "gemini" if has_gemini else "none",
        "gemini": {
            "configured": has_gemini,
            "model": gemini_model,
        },
    }


async def generate_manuscript_summaries(
    document: dict[str, Any],
    api_key: str | None = None,
    use_mock: bool = False,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """
    Generate overall and section-level summaries for a manuscript using Google Gemini API.
    If Gemini fails or is unconfigured, gracefully falls back to structured dummy summaries
    and records a warning on the document so the upload never crashes.
    """
    provider_pref = os.getenv("LLM_PROVIDER", "auto").lower()

    if use_mock or provider_pref == "mock":
        return generate_dummy_summaries(document)

    pages = document.get("pages", [])
    sections = document.get("sections", [])
    if not sections:
        return generate_dummy_summaries(document)

    lines_lookup = _build_lines_lookup(pages)
    flat_sections = _flatten_sections_for_llm(sections, lines_lookup)
    if not flat_sections:
        return generate_dummy_summaries(document)

    sections_payload = [
        {
            "id": item["id"],
            "title": item["title"],
            "level": item["level"],
            "content_sample": item["text_sample"],
        }
        for item in flat_sections
    ]

    prompt = (
        "You are an expert scientific manuscript analyst and researcher. "
        "Analyze the provided academic manuscript sections and generate two levels of summaries:\n"
        "1. 'overall_summary': A clear, high-level summary (3-5 sentences) capturing the core research question, "
        "methodology, key findings, and scientific significance of the entire paper.\n"
        "2. 'section_summaries': A list of objects for EACH input section (matching its 'id'), providing a concise, "
        "informative 1-3 sentence summary of that section's key arguments, methodology, or results.\n\n"
        "Important: Only summarize valid substantive research sections (e.g., Introduction, Methodology, Results, "
        "Discussion, Conclusions). Do not generate summaries for administrative or metadata sections (e.g., "
        "Acknowledgements, References, Funding, Author Contributions, Disclosures, Data Availability).\n\n"
        f"Document: {document.get('file_name', 'Manuscript.pdf')}\n"
        f"Sections to summarize:\n{json.dumps(sections_payload, ensure_ascii=False, indent=2)}\n\n"
        "Return ONLY a JSON object with this exact structure:\n"
        "{\n"
        '  "overall_summary": "...",\n'
        '  "section_summaries": [\n'
        '    {"id": "sec_0", "title": "...", "summary": "..."}\n'
        "  ]\n"
        "}"
    )

    resolved_api_key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()
    if _is_valid_gemini_key(resolved_api_key):
        gemini_schema = {
            "type": "OBJECT",
            "properties": {
                "overall_summary": {"type": "STRING"},
                "section_summaries": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "id": {"type": "STRING"},
                            "title": {"type": "STRING"},
                            "summary": {"type": "STRING"},
                        },
                        "required": ["id", "summary"],
                    },
                },
            },
            "required": ["overall_summary", "section_summaries"],
        }
        try:
            raw_text = await _call_gemini_json(prompt, gemini_schema, resolved_api_key, timeout=timeout)
            clean_json = _extract_json_string(raw_text)
            parsed = ManuscriptSummaryOutput.model_validate_json(clean_json)
            return _apply_summaries_to_document(document, flat_sections, parsed)
        except Exception as exc:
            logger.error("Gemini summarization failed: %s", exc)
            document.setdefault("warnings", []).append(f"AI Summarization notice: Could not generate summaries with Gemini ({exc}).")
            return generate_dummy_summaries(document)

    logger.info("No valid Gemini API key configured. Generating heuristic summaries.")
    return generate_dummy_summaries(document)


def _apply_summaries_to_document(
    document: dict[str, Any],
    flat_sections: list[dict[str, Any]],
    parsed: ManuscriptSummaryOutput,
) -> dict[str, Any]:
    """Apply parsed summary output onto the document sections hierarchy."""
    document["overall_summary"] = parsed.overall_summary

    summary_by_id = {item.id: item.summary for item in parsed.section_summaries if item.id and item.summary}
    for item in flat_sections:
        sec_node = item["node"]
        title = sec_node.get("title", "")
        has_children = bool(sec_node.get("children"))
        if not is_valid_summarizable_section(title, has_children=has_children):
            sec_node.pop("summary", None)
            continue

        if item["id"] in summary_by_id:
            sec_node["summary"] = summary_by_id[item["id"]]
        elif not sec_node.get("summary"):
            sec_node["summary"] = f"Covers detailed analysis regarding {title}."

    def _fill_missing_parent_summaries(sec_list: list[dict[str, Any]]) -> None:
        for s in sec_list:
            title = s.get("title", "")
            has_children = bool(s.get("children"))
            if not is_valid_summarizable_section(title, has_children=has_children):
                s.pop("summary", None)
            elif not s.get("summary") and s.get("children"):
                child_titles = [c.get("title", "") for c in s["children"] if c.get("title") and is_valid_summarizable_section(c.get("title", ""))]
                if child_titles:
                    s["summary"] = f"Section overview covering: {', '.join(child_titles)}."
            if s.get("children"):
                _fill_missing_parent_summaries(s["children"])

    _fill_missing_parent_summaries(document.get("sections", []))
    clean_unwanted_section_summaries(document.get("sections", []))
    return document


async def screen_papers_with_llm(screen_request: ScreeningInput, timeout: float = 90.0) -> list[dict[str, Any]]:
    """
    Screen scientific papers against inclusion/exclusion criteria using Google Gemini API.
    Returns a list of dicts with {"id": ..., "score": ..., "rationale": ...}.
    """
    papers = [paper.model_dump() for paper in screen_request.papers]
    paper_ids = [p["id"] for p in papers]
    exclusion_criteria = screen_request.exclusion_criteria.strip() or "None provided"

    provider_pref = os.getenv("LLM_PROVIDER", "auto").lower()
    if provider_pref == "mock":
        return [
            {"id": pid, "score": 8, "rationale": "Mock screening match."}
            for pid in paper_ids
        ]

    prompt = (
        "Screen each scientific paper for a systematic review. Use title and abstract only. "
        "Score confidence that it belongs in the next review stage from 0 (clearly exclude) "
        "to 10 (strongly include). Exclusion criteria override inclusion criteria. If abstract "
        "is missing, be cautious and say so. Do not infer unsupported facts.\n\n"
        f"Inclusion criteria:\n{screen_request.inclusion_criteria.strip()}\n\n"
        f"Exclusion criteria:\n{exclusion_criteria}\n\n"
        f"Papers:\n{json.dumps(papers, ensure_ascii=False, indent=2)}\n\n"
        "Return ONLY a JSON object with this exact structure:\n"
        "{\n"
        '  "results": [\n'
        '    {"id": "paper_id", "score": 8, "rationale": "brief evidence-based reason"}\n'
        "  ]\n"
        "}\n"
        "Include exactly one result for every input paper id."
    )

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not _is_valid_gemini_key(api_key):
        raise RuntimeError("Gemini API key is not configured. Please set GEMINI_API_KEY in .env.")

    gemini_schema = {
        "type": "OBJECT",
        "properties": {
            "results": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "id": {"type": "STRING"},
                        "score": {"type": "INTEGER"},
                        "rationale": {"type": "STRING"},
                    },
                    "required": ["id", "score", "rationale"],
                },
            },
        },
        "required": ["results"],
    }
    try:
        raw_text = await _call_gemini_json(prompt, gemini_schema, api_key, timeout=timeout)
        clean_json = _extract_json_string(raw_text)
        screening_output = ScreeningOutput.model_validate_json(clean_json)
        return _format_screening_results(paper_ids, screening_output)
    except Exception as exc:
        logger.error("Gemini screening failed: %s", exc)
        raise RuntimeError(f"Gemini screening failed: {exc}") from exc


def _format_screening_results(paper_ids: list[str], screening_output: ScreeningOutput) -> list[dict[str, Any]]:
    """Format and validate screening results against expected paper IDs."""
    results_by_id = {result.id: result for result in screening_output.results}
    formatted = []
    for paper_id in paper_ids:
        if paper_id in results_by_id:
            formatted.append(results_by_id[paper_id].model_dump())
        else:
            formatted.append({
                "id": paper_id,
                "score": 5,
                "rationale": "Model provided evaluation across batch without specific ID match.",
            })
    return formatted


class FieldDefinition(BaseModel):
    name: str = Field(min_length=1)
    description: str = Field(default="")


class PaperExtractionInput(BaseModel):
    id: str
    title: str = ""
    manuscript: dict[str, Any] | None = None


class DataExtractionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    papers: list[PaperExtractionInput]
    fields: list[FieldDefinition] = Field(min_length=1)


class PaperExtractionResult(BaseModel):
    id: str
    data: dict[str, Any] = Field(default_factory=dict)
    has_manuscript: bool = True
    error: str | None = None


class DataExtractionOutput(BaseModel):
    results: list[PaperExtractionResult]


def _normalize_extracted_field_dict(
    raw_data: Any,
    fields: list[FieldDefinition],
) -> dict[str, str]:
    """
    Normalize extracted fields into standard dictionary format:
    { "FieldName": "Extracted value string" }
    Supports both JSON array and JSON object outputs from the LLM.
    """
    lookup: dict[str, str] = {}

    if isinstance(raw_data, list):
        for item in raw_data:
            if isinstance(item, dict):
                fname = str(item.get("field") or item.get("name") or item.get("field_name") or "").strip()
                val = str(item.get("value") or "").strip()
                if fname:
                    lookup[fname.lower()] = val
                    lookup[fname.lower().replace("_", " ").replace("-", " ")] = val
    elif isinstance(raw_data, dict):
        for k, v in raw_data.items():
            if isinstance(v, dict):
                val = str(v.get("value") or "").strip()
            else:
                val = str(v).strip()
            lookup[str(k).strip().lower()] = val
            lookup[str(k).strip().lower().replace("_", " ").replace("-", " ")] = val

    normalized: dict[str, str] = {}
    for f in fields:
        canonical_name = f.name.strip()
        norm_key = canonical_name.lower()
        alt_key = norm_key.replace("_", " ").replace("-", " ")
        val = lookup.get(norm_key) or lookup.get(alt_key) or "Not reported"
        normalized[canonical_name] = val or "Not reported"

    return normalized


async def extract_paper_data_with_llm(
    paper_id: str,
    title: str,
    manuscript: dict[str, Any],
    fields: list[FieldDefinition],
    timeout: float = 30.0,
) -> dict[str, str]:
    """
    Extract specific target fields from a parsed manuscript document.
    Returns a dictionary mapping field name to extracted text value.
    """
    lines: list[str] = []
    for page in manuscript.get("pages", []):
        for line in page.get("lines", []):
            text = line.get("text", "").strip()
            if text:
                lines.append(text)

    if not lines:
        return {f.name: "Not reported" for f in fields}

    # Slice text on complete line boundaries up to 24,000 characters for sub-3s LLM latency
    accumulated: list[str] = []
    current_len = 0
    for line_str in lines:
        if current_len + len(line_str) + 1 > 24000:
            break
        accumulated.append(line_str)
        current_len += len(line_str) + 1

    sample_text = "\n".join(accumulated) if accumulated else "\n".join(lines[:100])

    prompt = (
        "You are an expert scientific researcher and data extraction specialist. "
        "Carefully extract the requested scientific target fields from the provided manuscript text.\n"
        "If a field is not discussed or mentioned in the manuscript, state 'Not reported'.\n\n"
        f"Manuscript Title: {title or manuscript.get('file_name', 'Research Manuscript')}\n"
        f"File: {manuscript.get('file_name', 'Manuscript.pdf')}\n\n"
        "Requested Fields to Extract:\n"
        + "\n".join(f'- "{f.name}": {f.description or "Extract details for " + f.name}' for f in fields)
        + "\n\n"
        "Manuscript Text:\n"
        f"{sample_text}\n\n"
        "Extraction Rules:\n"
        "1. For each requested field, provide:\n"
        "   - \"field\": The exact field name as requested.\n"
        "   - \"value\": A concise, accurate, evidence-based value extracted directly from the text (or 'Not reported' if not mentioned).\n"
        "2. Return ONLY a JSON array containing one object for each requested field with keys 'field' and 'value'."
    )

    provider_pref = os.getenv("LLM_PROVIDER", "auto").lower()
    if provider_pref == "mock":
        extracted: dict[str, str] = {}
        for f in fields:
            field_word = f.name.lower()
            matching = [l for l in lines if field_word in l.lower()]
            if matching:
                extracted[f.name] = matching[0][:200]
            else:
                extracted[f.name] = lines[0][:200] if lines else "Reported in manuscript"
        return extracted

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not _is_valid_gemini_key(api_key):
        raise RuntimeError("Gemini API key is not configured. Please set GEMINI_API_KEY in .env.")

    gemini_schema = {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "field": {"type": "STRING"},
                "value": {"type": "STRING"},
            },
            "required": ["field", "value"],
        },
    }

    try:
        raw_text = await _call_gemini_json(prompt, gemini_schema, api_key, timeout=timeout)
        clean_json = _extract_json_string(raw_text)
        parsed_data = json.loads(clean_json)
        return _normalize_extracted_field_dict(parsed_data, fields)
    except Exception as exc:
        logger.error("Gemini data extraction failed for paper %s: %s", paper_id, exc)
        raise RuntimeError(f"Gemini data extraction failed: {exc}") from exc


async def extract_batch_data_with_llm(
    papers_with_manuscript: list[dict[str, Any]],
    fields: list[FieldDefinition],
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """
    Process data extraction for a batch of papers concurrently.
    Papers without parsed manuscript are marked with has_manuscript=False and empty data.
    """
    sem = asyncio.Semaphore(4)

    async def _extract_single(item: dict[str, Any]) -> dict[str, Any]:
        paper_id = item["id"]
        title = item.get("title", "")
        manuscript = item.get("manuscript")

        if not manuscript or not manuscript.get("pages"):
            return {
                "id": paper_id,
                "data": {},
                "has_manuscript": False,
                "error": "No parsed manuscript attached.",
            }

        async with sem:
            try:
                data = await extract_paper_data_with_llm(paper_id, title, manuscript, fields, timeout=timeout)
                return {
                    "id": paper_id,
                    "data": data,
                    "has_manuscript": True,
                    "error": None,
                }
            except Exception as exc:
                logger.exception("Failed data extraction for paper %s: %s", paper_id, exc)
                return {
                    "id": paper_id,
                    "data": {},
                    "has_manuscript": True,
                    "error": str(exc),
                }

    tasks = [_extract_single(item) for item in papers_with_manuscript]
    return await asyncio.gather(*tasks)


class SynthesisPaperItem(BaseModel):
    id: str
    title: str = ""
    authors: str = ""
    year: str = ""
    journal: str = ""
    doi: str = ""
    url: str = ""
    abstract: str = ""
    score: int | None = None
    rationale: str | None = None
    extracted_data: dict[str, Any] = Field(default_factory=dict, alias="extractedData")

    model_config = ConfigDict(populate_by_name=True)


class SynthesisRequest(BaseModel):
    papers: list[SynthesisPaperItem] = Field(min_length=1)
    source_stage_name: str = Field(default="Source Stage", alias="sourceStageName")
    synthesis_prompt: str = Field(default="", alias="synthesisPrompt")

    model_config = ConfigDict(populate_by_name=True)


async def synthesize_papers_with_llm(
    request: SynthesisRequest,
    timeout: float = 60.0,
) -> str:
    """
    Synthesize scientific literature review findings from selected papers and their extracted fields.
    Produces a publication-grade Systematic Literature Review synthesis document.
    """
    papers_data = []
    for p in request.papers:
        item: dict[str, Any] = {
            "id": p.id,
            "title": p.title,
            "authors": p.authors or "Unknown authors",
            "year": p.year or "n.d.",
            "journal": p.journal or "Unspecified journal",
            "abstract": p.abstract or "No abstract available",
        }
        if p.score is not None:
            item["screening_score"] = f"{p.score}/10"
        if p.rationale:
            item["screening_rationale"] = p.rationale
        if p.extracted_data:
            item["extracted_fields"] = p.extracted_data
        papers_data.append(item)

    custom_focus = f"\nUser Research Focus / Specific Instructions:\n{request.synthesis_prompt.strip()}\n" if request.synthesis_prompt.strip() else ""

    prompt = (
        "You are an expert scientific lead author and systematic literature review (SLR) research specialist. "
        f"You are preparing a comprehensive, publication-grade Systematic Literature Review Synthesis for {len(papers_data)} included studies "
        f"transferred from '{request.source_stage_name}'.\n\n"
        f"Target Studies & Extracted Data ({len(papers_data)} papers):\n"
        f"{json.dumps(papers_data, indent=2, ensure_ascii=False)}\n\n"
        f"{custom_focus}"
        "Task Guidelines:\n"
        "Synthesize the body of literature following formal systematic review conventions (PRISMA/SLR style):\n"
        "1. # Systematic Literature Review Synthesis\n"
        "2. ## 1. Executive Summary & Review Scope\n"
        "   - Synthesize the overarching research domain, objectives, and corpus of the included studies.\n"
        "3. ## 2. Thematic & Methodological Categorization\n"
        "   - Group and categorize the papers into distinct thematic/methodological clusters based on their core architectures, algorithms, data modalities, or approaches.\n"
        "   - Explicitly cite each paper (Author, Year) within its categorized group.\n"
        "4. ## 3. Cross-Study Synthesis: Common Methodologies & Similarities\n"
        "   - Detail the shared foundations, recurring modeling assumptions, common benchmark datasets, evaluation protocols, and mutual paradigms across studies.\n"
        "5. ## 4. Comparative & Differential Analysis (Differences & Trade-offs)\n"
        "   - Provide an in-depth, rigorous comparison of how the methods differ, contrasting architectural trade-offs, computational complexity, sample requirements, and performance variations.\n"
        "6. ## 5. Consolidated Synthesis Comparison Matrix\n"
        "   - Provide a comprehensive Markdown table comparing: Study (Author, Year), Methodological Category, Primary Architecture / Method, Data Modalities / Datasets, and Key Strengths / Outcomes.\n"
        "7. ## 6. Critical Gaps, Limitations & Future Research Directions\n"
        "   - Highlight common limitations identified across the collective evidence base and articulate concrete recommendations for future investigation.\n\n"
        "Formatting Requirements:\n"
        "- Write in an objective, academic scientific tone.\n"
        "- Use standard Markdown formatting with clear headers, bullet lists, bold emphasis, and formatted tables.\n"
        "- Do NOT output extraneous conversational text or preambles outside the synthesis document."
    )

    provider_pref = os.getenv("LLM_PROVIDER", "auto").lower()
    if provider_pref == "mock":
        first_authors = [f"{p.authors.split(',')[0]} ({p.year})" if p.authors else p.title[:25] for p in request.papers]
        return (
            f"# Systematic Literature Review Synthesis\n\n"
            f"## 1. Executive Summary & Review Scope\n"
            f"This review synthesizes {len(request.papers)} included studies transferred from {request.source_stage_name}. "
            f"The collective literature focuses on empirical and methodological advances across {', '.join(first_authors[:3])}.\n\n"
            f"## 2. Thematic & Methodological Categorization\n"
            f"The included studies can be categorized into major methodological paradigms based on their extracted characteristics:\n"
            f"- **Deep Learning & Graph Architectures**: {', '.join(first_authors[:2])}\n"
            f"- **Multimodal & Sequence Representations**: {', '.join(first_authors[2:4]) if len(first_authors) > 2 else first_authors[0]}\n\n"
            f"## 3. Cross-Study Synthesis: Common Methodologies & Similarities\n"
            f"All evaluated studies share common foundational principles including multi-source data integration, standard validation protocols, and iterative optimization.\n\n"
            f"## 4. Comparative & Differential Analysis\n"
            f"Key differences emerge in computational complexity, model depth, and handling of multi-omics data structures.\n\n"
            f"## 5. Consolidated Synthesis Comparison Matrix\n\n"
            f"| Study | Category | Architecture | Modalities | Key Outcomes |\n"
            f"|---|---|---|---|---|\n"
            + "\n".join(f"| {p.authors or 'Study'} ({p.year or 'n.d.'}) | Machine Learning | {p.title[:30]}… | Multimodal | Demonstrated significant empirical performance |" for p in request.papers[:5])
            + f"\n\n## 6. Critical Gaps & Future Directions\n"
            f"Future work requires standardized cross-benchmark evaluations and broader validation on clinical cohorts."
        )

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not _is_valid_gemini_key(api_key):
        raise RuntimeError("Gemini API key is not configured. Please set GEMINI_API_KEY in .env.")

    try:
        return await _call_gemini_text(prompt, api_key, timeout=timeout)
    except Exception as exc:
        logger.error("Gemini synthesis generation failed: %s", exc)
        raise RuntimeError(f"Gemini synthesis generation failed: {exc}") from exc

