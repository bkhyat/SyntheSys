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
        "result",
        "experimental results",
        "experimental result",
        "findings",
        "finding",
        "evaluation",
        "evaluations",
        "experiments",
        "experiment",
        "experiments and results",
        "empirical evaluation",
        "empirical results",
        "empirical analysis",
        "performance evaluation",
        "performance analysis",
        "performance comparison",
        "benchmark results",
        "benchmarking",
        "benchmarking results",
        "outcomes",
        "outcome",
        "analysis and results",
        "case study",
        "case studies",
        "observations",
        "observation",
        "experimental validation",
        "validation results",
        "simulation results",
        "simulations",
        "numerical results",
        "numerical experiments",
        "ablation study",
        "ablation studies",
        "ablation experiment",
        "ablation experiments",
        "comparative results",
        "comparison results",
        "main results",
    ],
    "Discussion": [
        "discussion",
        "discussions",
        "results and discussion",
        "results & discussion",
        "interpretation",
        "implications",
        "comparative analysis",
        "discussion and analysis",
        "general discussion",
        "critical discussion",
    ],
    "Conclusion": [
        "conclusion",
        "conclusions",
        "concluding remarks",
        "concluding remark",
        "summary and conclusions",
        "summary and conclusion",
        "final remarks",
        "concluding discussion",
        "conclusions and outlook",
        "concluding summary",
        "closing remarks",
        "closing remark",
        "discussion and conclusion",
        "discussion and conclusions",
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
        "limitations of the study",
    ],
    "Future Directions": [
        "future directions",
        "future direction",
        "future work",
        "future works",
        "future research",
        "future prospects",
        "future perspectives",
        "future perspective",
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
    colons, excess whitespace, and separating concatenated / camelCase words.
    """
    cleaned = title.strip()
    # Strip leading numbering (e.g. "1.", "1.2", "Section 2:", "III.", "[1]", etc.)
    cleaned = re.sub(
        r"^(?:section\s+)?(?:\[?\d+(?:\.\d+)*\]?|[A-Z]|[IVXLCDM]+)[\.\:\-\–\)\s]+\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()
    # Separate concatenated 'and' (e.g., "ResultsandDiscussion" -> "Results and Discussion")
    cleaned = re.sub(r"(?i)\b(results?|materials?|methods?|findings?)(and)\b", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)(results?|materials?|methods?|findings?)(and)(discussion|methods?|materials?|results?|analysis)", r"\1 \2 \3", cleaned)
    # Separate camelCase words like "PerformanceComparison" -> "Performance Comparison"
    cleaned = re.sub(r"([a-z])([A-Z])", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)\b(results?|materials?|methods?|findings?)(and)\b", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)\b(related)(works?)\b", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)\b(prior)(works?)\b", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)\b(data)(preparation|preprocessing|collection|splitting)\b", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)\b(experimental)(setup|settings?|design|results?)\b", r"\1 \2", cleaned)
    cleaned = re.sub(r"(?i)\b(ablation)(study|studies|experiment|experiments)\b", r"\1 \2", cleaned)
    # Strip trailing punctuation/colons
    cleaned = re.sub(r"[\s\:\-\–\.]+$", "", cleaned).strip()
    return cleaned


def match_standard_section(title: str, is_top_level: bool = True) -> tuple[str | None, bool]:
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

    # 3. Explicit standalone or prefix heading pattern matches
    if re.search(r"^(references?|bibliograph(y|ies)|literature\s+cited|works\s+cited)(\b|:|$)", casefolded):
        return "References", True

    if re.search(r"\b(limitations?|threats\s+to\s+validity|study\s+limitations?)\b", casefolded):
        return "Limitations", False

    if re.search(r"\b(future\s+(work|works|direction|directions|research|prospects?|perspectives?)|next\s+steps|open\s+(problems|challenges))\b", casefolded):
        return "Future Directions", False

    if re.search(r"^(conclusions?|concluding\s+remarks?|closing\s+remarks?|summary\s+and\s+conclusions?)(\b|:|$)", casefolded):
        return "Conclusion", False

    if re.search(r"^(discussions?|results?\s+and\s+discussion|general\s+discussion)(\b|:|$)", casefolded):
        return "Discussion", False

    if is_top_level:
        if re.search(r"^(results?|findings?|experimental\s+results?|experiments?\s+and\s+results?|performance\s+evaluation|evaluation)(\b|:|$)", casefolded):
            return "Results", False

        if re.search(r"^(materials?\s+and\s+methods?|materials?\s+&\s+methods?|methodology|methodologies|methods?|experimental\s+(design|setup|methods?|procedures?)|proposed\s+(method|approach|model|framework|architecture)|model\s+architecture|implementation\s+details?)(\b|:|$)", casefolded):
            return "Methods", False

        if re.search(r"^(introductions?|background|background\s+and\s+motivation|related\s+works?|prior\s+work|preliminaries|problem\s+(formulation|statement))(\b|:|$)", casefolded):
            return "Introduction", False

        if re.search(r"^(abstract|executive\s+summary)(\b|:|$)", casefolded):
            return "Abstract", False

    # Unmapped regular scientific content (NOT excluded from LLM)
    return None, False


def annotate_section_tree(
    sections: list[dict[str, Any]],
    parent_std: str | None = None,
    parent_excl: bool = False,
) -> None:
    """
    Recursively annotate each section node in-place with:
    - original_title: original heading title
    - standard_section: matched canonical standard section name (or None)
    - is_excluded_from_llm: boolean flag
    Child subsections inherit parent canonical standard section if not explicitly matched.
    """
    for sec in sections:
        original = sec.get("original_title") or sec.get("title", "")
        sec["original_title"] = original
        is_top = (parent_std is None and not parent_excl)
        std_sec, is_excluded = match_standard_section(original, is_top_level=is_top)

        if std_sec is None and not is_excluded and parent_std is not None:
            # Child inherits parent canonical section
            std_sec = parent_std
            is_excluded = parent_excl
        elif is_excluded or std_sec == "References":
            is_excluded = True
        elif parent_excl:
            is_excluded = True

        sec["standard_section"] = std_sec
        sec["is_excluded_from_llm"] = is_excluded

        if sec.get("children"):
            annotate_section_tree(sec["children"], parent_std=std_sec, parent_excl=is_excluded)


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


def _is_node_excluded(node: dict[str, Any]) -> bool:
    """Check if a section node represents references, funding, acknowledgments, or other administrative content."""
    if node.get("is_excluded_from_llm"):
        return True
    std = node.get("standard_section")
    if std in ("References", "Administrative (Excluded)"):
        return True
    orig = (node.get("original_title") or node.get("title") or "").strip()
    cleaned = clean_section_heading(orig)
    for pattern in _EXCLUDED_SECTION_PATTERNS:
        if pattern.search(orig) or pattern.search(cleaned):
            return True
    for syn in _STANDARD_SYNONYMS.get("References", []):
        if orig.lower().startswith(syn) or cleaned.lower().startswith(syn):
            return True
    return False


def get_substantive_lines(document: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Extract all DocumentLines from the manuscript that belong to substantive scientific sections
    (strictly excluding References, Funding, Acknowledgments, Contributions, Data Availability, etc.)
    for use in LLM screening and data extraction prompts.
    """
    sections = document.get("sections", [])
    all_pages = document.get("pages", [])

    excluded_refs: set[str] = set()

    def _find_excluded(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if _is_node_excluded(node):
                for ref in node.get("line_refs", []):
                    excluded_refs.add(f"{ref.get('page_number')}:{ref.get('line_number')}")
            if node.get("children"):
                _find_excluded(node["children"])

    _find_excluded(sections)

    # Also exclude line_refs from document["references"] collection
    for ref_item in document.get("references", []):
        for ref in ref_item.get("line_refs", []):
            excluded_refs.add(f"{ref.get('page_number')}:{ref.get('line_number')}")

    # Collect valid lines in sequential order
    substantive_lines: list[dict[str, Any]] = []
    in_unmapped_excluded_block = False

    for page in all_pages:
        p_num = page.get("page_number", 1)
        for line in page.get("lines", []):
            l_num = line.get("line_number", 1)
            ref_key = f"{p_num}:{l_num}"

            if ref_key in excluded_refs:
                continue

            # Check if an unmapped line starts an obvious excluded section
            text = line.get("text", "").strip()
            if text:
                cleaned_text = clean_section_heading(text)
                is_excluded_heading = any(pattern.match(text) or pattern.match(cleaned_text) for pattern in _EXCLUDED_SECTION_PATTERNS)
                if not is_excluded_heading:
                    is_excluded_heading = any(text.lower().startswith(f"{syn}:") or text.lower() == syn for syn in _STANDARD_SYNONYMS.get("References", []))
                
                if is_excluded_heading:
                    in_unmapped_excluded_block = True
                    continue

                # Resume if a standard scientific heading is encountered
                std_match, _ = match_standard_section(cleaned_text, is_top_level=True)
                if std_match and std_match != "References":
                    in_unmapped_excluded_block = False

            if not in_unmapped_excluded_block:
                substantive_lines.append(line)

    return substantive_lines


def build_substantive_manuscript_text(
    document: dict[str, Any],
    max_chars: int = 32000,
) -> str:
    """
    Construct a clean, structured text excerpt of the manuscript containing only substantive sections,
    strictly omitting References, Acknowledgments, Funding, Author Contributions, Disclosures, etc.
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
        return "\n".join(lines[:120])

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
