"""
Standard Section Matcher and Catalog for SyntheSys
Provides standardized canonical scientific sections, synonym mappings,
administrative section filtering for LLM calls, and section hierarchy annotation.
"""

import re
from typing import Any

# Canonical Standard Sections with valuable scientific content
STANDARD_SECTIONS = [
    "Abstract",
    "Introduction",
    "Methods",
    "Results",
    "Discussion",
    "Conclusion",
    "Limitations",
    "Future Directions",
    "References",
]

# Comprehensive synonyms and alias dictionaries
_STANDARD_SYNONYMS: dict[str, list[str]] = {
    "Abstract": [
        "abstract",
        "summary",
        "overview",
        "executive summary",
        "structured abstract",
        "graphical abstract",
        "abstract and keywords",
        "paper summary",
    ],
    "Introduction": [
        "introduction",
        "background",
        "background and motivation",
        "motivation",
        "context",
        "context and background",
        "literature review",
        "related work",
        "related works",
        "prior work",
        "prior works",
        "state of the art",
        "theoretical background",
        "problem statement",
        "problem formulation",
        "preliminaries",
        "background and related work",
    ],
    "Methods": [
        "methods",
        "method",
        "methodology",
        "materials and methods",
        "materials & methods",
        "experimental setup",
        "experimental design",
        "experimental methods",
        "experimental procedure",
        "experimental procedures",
        "proposed method",
        "proposed methods",
        "proposed approach",
        "proposed model",
        "proposed framework",
        "proposed architecture",
        "model architecture",
        "system architecture",
        "system model",
        "implementation",
        "implementation details",
        "system design",
        "data collection",
        "data and methods",
        "dataset and methods",
        "study design",
        "interventions",
        "subjects and methods",
        "patients and methods",
        "methodological framework",
        "algorithm",
        "algorithms",
        "materials",
        "measurements",
        "protocol",
    ],
    "Results": [
        "results",
        "experimental results",
        "findings",
        "evaluation",
        "experiments",
        "experiments and results",
        "empirical evaluation",
        "empirical results",
        "performance evaluation",
        "benchmark results",
        "benchmarking",
        "outcomes",
        "analysis and results",
        "case study",
        "case studies",
        "observations",
        "experimental validation",
        "simulations",
        "simulation results",
        "numerical results",
        "ablation study",
        "ablation studies",
    ],
    "Discussion": [
        "discussion",
        "results and discussion",
        "interpretation",
        "implications",
        "comparative analysis",
        "discussion and analysis",
        "general discussion",
    ],
    "Conclusion": [
        "conclusion",
        "conclusions",
        "concluding remarks",
        "summary and conclusions",
        "final remarks",
        "concluding discussion",
        "conclusions and outlook",
        "concluding summary",
        "closing remarks",
    ],
    "Limitations": [
        "limitation",
        "limitations",
        "threats to validity",
        "study limitations",
        "potential limitations",
        "scope and limitations",
        "weaknesses",
        "delimitations",
        "limitations and threats to validity",
    ],
    "Future Directions": [
        "future directions",
        "future work",
        "future works",
        "future research",
        "future prospects",
        "future perspectives",
        "open problems",
        "open challenges",
        "extensions",
        "outlook",
        "next steps",
        "conclusions and future work",
        "limitations and future work",
    ],
    "References": [
        "references",
        "reference",
        "bibliography",
        "literature cited",
        "works cited",
        "citations",
        "references and notes",
        "cited literature",
    ],
}

# Administrative / Non-Substantive section patterns to exclude from LLM calls
_EXCLUDED_SECTION_PATTERNS = [
    re.compile(r"^acknowledg(e)?ments?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(financial\s+)?funding(\s+information|\s+statement|\s+sources?|\s+and\s+acknowledgments?)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(financial|grant)\s+(support|disclosure)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^author(s)?[\x27\x22\u2019\u2018s]*\s+(contributions?|information|details|affiliations?|notes?)(\b|:|$)", re.IGNORECASE),
    re.compile(r"^credit(\s+authorship)?\s+contribution(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^(conflict|conflicts|competing)\s+(of\s+)?interests?(\s+statement)?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^declaration(s)?\s+of\s+(competing\s+)?interests?(\b|:|$)", re.IGNORECASE),
    re.compile(r"^disclosures?(\s+statement)?(\b|:|$)", re.IGNORECASE),
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
    re.compile(r"^appendix(\b|:|$|\s+[a-z0-9])", re.IGNORECASE),
    re.compile(r"^appendices(\b|:|$)", re.IGNORECASE),
]


def clean_section_heading(title: str) -> str:
    """
    Clean section heading by stripping numbering, punctuation, roman numerals,
    colons, and excess whitespace.
    """
    cleaned = title.strip()
    # Strip leading numbering (e.g. "1.", "1.2", "Section 2:", "III.", "[1]", etc.)
    cleaned = re.sub(
        r"^(?:section\s+)?(?:\[?\d+(?:\.\d+)*\]?|[A-Z]|[IVXLCDM]+)[\.\:\-\–\)\s]+\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()
    # Strip trailing punctuation/colons
    cleaned = re.sub(r"[\s\:\-\–\.]+$", "", cleaned).strip()
    return cleaned


def match_standard_section(title: str) -> tuple[str | None, bool]:
    """
    Match a manuscript section title to canonical standard sections.
    Returns:
        (standard_section_name, is_excluded_from_llm)
        - standard_section_name: e.g. "Methods", "Results", "Introduction", etc. (or None if unmapped)
        - is_excluded_from_llm: True if section is References or Administrative (Funding, Acknowledgment, etc.)
    """
    cleaned = clean_section_heading(title)
    casefolded = cleaned.casefold()

    # 1. Check if administrative excluded section
    for pattern in _EXCLUDED_SECTION_PATTERNS:
        if pattern.search(cleaned) or pattern.search(title.strip()):
            return None, True

    # 2. Exact synonym match against canonical standard sections
    for std_name, synonyms in _STANDARD_SYNONYMS.items():
        if casefolded in synonyms:
            is_excluded = (std_name == "References")
            return std_name, is_excluded

    # 3. Normalized phrase / regex heuristic matches
    # References
    if any(ref_word in casefolded for ref_word in ["references", "bibliography", "literature cited", "works cited"]):
        return "References", True

    # Limitations
    if any(kw in casefolded for kw in ["limitation", "limitations", "threats to validity"]):
        return "Limitations", False

    # Future Directions
    if any(kw in casefolded for kw in ["future work", "future direction", "future research", "future prospect", "future perspective"]):
        return "Future Directions", False

    # Conclusion
    if any(kw in casefolded for kw in ["conclusion", "conclusions", "concluding remark", "concluding discussion"]):
        return "Conclusion", False

    # Discussion
    if "discussion" in casefolded:
        return "Discussion", False

    # Results / Findings / Evaluation
    if any(kw in casefolded for kw in ["results", "findings", "evaluation", "experimental validation", "benchmark result", "ablation study", "ablation studies"]):
        return "Results", False

    # Methods / Methodology / Proposed
    if any(kw in casefolded for kw in [
        "materials and methods", "materials & methods", "methodology", "methods", "method",
        "proposed approach", "proposed method", "proposed framework", "proposed model",
        "model architecture", "implementation detail", "experimental setup", "study design",
        "data collection", "subjects and methods", "patients and methods",
    ]):
        return "Methods", False

    # Introduction / Background / Related Work
    if any(kw in casefolded for kw in ["introduction", "background", "related work", "prior work", "state of the art", "preliminaries", "problem formulation"]):
        return "Introduction", False

    # Abstract
    if "abstract" in casefolded:
        return "Abstract", False

    # Unmapped regular scientific content (NOT excluded from LLM)
    return None, False


def annotate_section_tree(sections: list[dict[str, Any]]) -> None:
    """
    Recursively annotate each section node in-place with:
    - original_title: original heading title
    - standard_section: matched canonical standard section name (or None)
    - is_excluded_from_llm: boolean flag
    """
    for sec in sections:
        original = sec.get("original_title") or sec.get("title", "")
        sec["original_title"] = original
        std_sec, is_excluded = match_standard_section(original)
        sec["standard_section"] = std_sec
        sec["is_excluded_from_llm"] = is_excluded

        if sec.get("children"):
            annotate_section_tree(sec["children"])


def extract_section_mappings_summary(document: dict[str, Any]) -> dict[str, Any]:
    """
    Produce a structured mapping overview for the manuscript:
    - mapped_sections: list of mapped canonical sections with their original names and page/line locations
    - unmatched_sections: list of original section titles that could not be mapped to standard sections
    - references_section: references mapping detail
    """
    mapped: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    ref_info: dict[str, Any] | None = None

    seen_standard: set[str] = set()

    def _collect(nodes: list[dict[str, Any]]) -> None:
        nonlocal ref_info
        for node in nodes:
            original = node.get("original_title") or node.get("title", "")
            std = node.get("standard_section")
            is_excluded = node.get("is_excluded_from_llm", False)

            if std:
                if std == "References":
                    ref_info = {
                        "original_title": original,
                        "page": node.get("start_page"),
                        "line": node.get("start_line"),
                        "line_count": len(node.get("line_refs", [])),
                    }
                else:
                    mapped.append({
                        "standard_section": std,
                        "original_title": original,
                        "page": node.get("start_page"),
                        "line": node.get("start_line"),
                        "level": node.get("level", 1),
                    })
                    seen_standard.add(std)
            elif not is_excluded:
                cleaned = clean_section_heading(original)
                if cleaned and cleaned.lower() not in ("title & overview", "full document"):
                    unmatched.append({
                        "original_title": original,
                        "page": node.get("start_page"),
                        "line": node.get("start_line"),
                        "level": node.get("level", 1),
                    })

            if node.get("children"):
                _collect(node["children"])

    _collect(document.get("sections", []))

    return {
        "mapped_sections": mapped,
        "unmatched_sections": unmatched,
        "references_section": ref_info,
    }


def get_substantive_lines(document: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Extract all DocumentLines from the manuscript that belong to substantive scientific sections
    (excluding References, Funding, Acknowledgments, Contributions, Data Availability, etc.)
    for use in LLM prompts.
    """
    sections = document.get("sections", [])
    all_pages = document.get("pages", [])

    # Map of "page:line" -> DocumentLine
    lines_by_ref: dict[str, dict[str, Any]] = {}
    for page in all_pages:
        p_num = page.get("page_number", 1)
        for line in page.get("lines", []):
            l_num = line.get("line_number", 1)
            lines_by_ref[f"{p_num}:{l_num}"] = line

    excluded_refs: set[str] = set()

    def _find_excluded(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if node.get("is_excluded_from_llm") or node.get("standard_section") == "References":
                for ref in node.get("line_refs", []):
                    excluded_refs.add(f"{ref.get('page_number')}:{ref.get('line_number')}")
            if node.get("children"):
                _find_excluded(node["children"])

    _find_excluded(sections)

    # Collect valid lines in sequential order
    substantive_lines: list[dict[str, Any]] = []
    for page in all_pages:
        p_num = page.get("page_number", 1)
        for line in page.get("lines", []):
            l_num = line.get("line_number", 1)
            ref_key = f"{p_num}:{l_num}"
            if ref_key not in excluded_refs:
                substantive_lines.append(line)

    return substantive_lines


def build_substantive_manuscript_text(
    document: dict[str, Any],
    max_chars: int = 24000,
) -> str:
    """
    Construct a clean text excerpt of the manuscript containing only substantive sections,
    strictly omitting References, Acknowledgments, Funding, Author Contributions, etc.
    """
    substantive_lines = get_substantive_lines(document)
    if not substantive_lines:
        # Fallback to scanning lines directly
        lines: list[str] = []
        for page in document.get("pages", []):
            for line in page.get("lines", []):
                t = line.get("text", "").strip()
                if t:
                    lines.append(t)
        return "\n".join(lines[:100])

    accumulated: list[str] = []
    current_len = 0
    for line in substantive_lines:
        text = line.get("text", "").strip()
        if not text:
            continue
        if current_len + len(text) + 1 > max_chars:
            break
        accumulated.append(text)
        current_len += len(text) + 1

    return "\n".join(accumulated)


def apply_manual_section_mappings(
    document: dict[str, Any],
    manual_mappings: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Apply user-defined manual mappings to the document's section tree.
    manual_mappings item format:
    {
        "page": int (optional),
        "line": int (optional),
        "original_title": str,
        "standard_section": str | None,
        "is_excluded": bool | None,
    }
    """
    mapping_lookup: dict[Any, dict[str, Any]] = {}
    for m in manual_mappings:
        orig = m.get("original_title", "").strip()
        page = m.get("page")
        line = m.get("line")
        if page is not None and line is not None:
            mapping_lookup[(page, line)] = m
        if orig:
            mapping_lookup[orig.casefold()] = m

    def _update_node(node: dict[str, Any]) -> None:
        orig = node.get("original_title") or node.get("title", "")
        page = node.get("start_page")
        line = node.get("start_line")

        target_mapping = None
        if (page, line) in mapping_lookup:
            target_mapping = mapping_lookup[(page, line)]
        elif orig.strip().casefold() in mapping_lookup:
            target_mapping = mapping_lookup[orig.strip().casefold()]

        if target_mapping:
            std = target_mapping.get("standard_section")
            if std in ("", "None", "Unmapped", "null", None):
                std = None
            elif std == "Administrative (Excluded)":
                std = None
                target_mapping["is_excluded"] = True

            node["standard_section"] = std

            if "is_excluded" in target_mapping and target_mapping["is_excluded"] is not None:
                node["is_excluded_from_llm"] = bool(target_mapping["is_excluded"])
            elif std == "References":
                node["is_excluded_from_llm"] = True
            elif std:
                node["is_excluded_from_llm"] = False

        if node.get("children"):
            for child in node["children"]:
                _update_node(child)

    for sec in document.get("sections", []):
        _update_node(sec)

    summary = extract_section_mappings_summary(document)
    document["mapped_sections"] = summary["mapped_sections"]
    document["unmatched_sections"] = summary["unmatched_sections"]
    document["references_section"] = summary["references_section"]
    return document
