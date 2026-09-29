import io
import re
import statistics
from typing import Any

import pdfplumber

_CAPTION_PATTERN = re.compile(r"^(?P<kind>figure|fig\.?|table)\s*(?P<label>\d+(?:\.\d+)*|[A-Z])(?:(?P<separator>[.:\-–])\s*(?P<caption>.*)|\s*)$", re.IGNORECASE)
_NUMBERED_HEADING = re.compile(r"^(?P<number>\d{1,2}(?:\.\d{1,2})*|I{1,3}|IV|V|VI{0,3}|IX|X)\.\s+\S", re.IGNORECASE)
_REFERENCE_NUMBER = re.compile(r"^\s*(?:\[(?P<bracket>\d+)\]|(?P<plain>\d+)[.)])\s+(?P<text>.+)$")
_REFERENCE_AUTHOR_YEAR = re.compile(r"^[A-Z][A-Za-z’'\-]+.{0,120}\b(?:19|20)\d{2}[a-z]?\b")
_REFERENCE_HEADINGS = {"references", "bibliography", "literature cited", "works cited"}
_NON_REFERENCE_HEADINGS = {"appendix", "appendices", "supplementary material", "supplemental material"}
_SECTION_HEADINGS = {
    "abstract", "introduction", "background", "related work", "materials and methods",
    "methods", "methodology", "results", "discussion", "conclusion", "conclusions",
    "acknowledgments", "acknowledgements", "references", "bibliography", "appendix",
    "appendices", "supplementary material", "supplemental material",
    "data availability", "availability of data and materials", "author contributions",
    "funding", "conflict of interest", "conflicts of interest", "competing interests",
}


def _line_font_size(line: dict[str, Any]) -> float:
    sizes = [float(char["size"]) for char in line.get("chars", []) if char.get("size")]
    return max(sizes, default=0.0)


def _split_text_line(
    line: dict[str, Any],
    page_width: float,
    page_words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    characters = sorted(line.get("chars", []), key=lambda char: (char["x0"], char["top"]))
    if not characters:
        return [line]

    gap_threshold = max(12.0, page_width * 0.025)
    word_gap_threshold = max(1.2, page_width * 0.003)
    character_groups: list[list[dict[str, Any]]] = []
    current_group = [characters[0]]
    for character in characters[1:]:
        if character["x0"] - current_group[-1]["x1"] > gap_threshold:
            character_groups.append(current_group)
            current_group = []
        current_group.append(character)
    character_groups.append(current_group)

    if len(character_groups) == 1:
        return [{**line, "font_size": _line_font_size(line)}]

    split_lines = []
    for group in character_groups:
        group_x0 = min(float(character["x0"]) for character in group)
        group_x1 = max(float(character["x1"]) for character in group)
        group_top = min(float(character["top"]) for character in group)
        group_bottom = max(float(character["bottom"]) for character in group)
        words = [
            word for word in page_words
            if group_x0 - 1 <= (float(word["x0"]) + float(word["x1"])) / 2 <= group_x1 + 1
            and abs((float(word["top"]) + float(word["bottom"])) / 2 - (group_top + group_bottom) / 2)
            <= max(2.5, (group_bottom - group_top) * 0.4)
        ]
        text = " ".join(str(word["text"]) for word in sorted(words, key=lambda word: word["x0"]))
        if not text:
            text_parts = []
            previous_character = None
            for character in group:
                if previous_character and character["x0"] - previous_character["x1"] > word_gap_threshold:
                    text_parts.append(" ")
                text_parts.append(character["text"])
                previous_character = character
            text = "".join(text_parts)
        text = text.strip()
        if text:
            split_lines.append({
                "text": text,
                "x0": group_x0,
                "x1": group_x1,
                "top": group_top,
                "bottom": group_bottom,
                "chars": group,
            })
    return split_lines


def _column_order(lines: list[dict[str, Any]], page_width: float, body_size: float) -> list[dict[str, Any]]:
    ordered = sorted(lines, key=lambda line: (line["top"], line["x0"]))
    anchors = [
        index for index, line in enumerate(ordered)
        if (line["x0"] < page_width * 0.18 and line["x1"] > page_width * 0.82)
        or (body_size > 0 and line["font_size"] >= body_size * 1.3 and len(line["text"]) < 150)
    ]

    def sort_segment(segment: list[dict[str, Any]]) -> list[dict[str, Any]]:
        left = [line for line in segment if line["x0"] < page_width * 0.48 and line["x1"] - line["x0"] < page_width * 0.72]
        right = [line for line in segment if line["x0"] >= page_width * 0.48 and line["x1"] - line["x0"] < page_width * 0.72]
        if len(left) >= 2 and len(right) >= 2:
            centered = [line for line in segment if line not in left and line not in right]
            return (
                sorted(left, key=lambda line: (line["top"], line["x0"]))
                + sorted(centered, key=lambda line: (line["top"], line["x0"]))
                + sorted(right, key=lambda line: (line["top"], line["x0"]))
            )
        return segment

    result: list[dict[str, Any]] = []
    start = 0
    for anchor_index in anchors:
        if anchor_index < start:
            continue
        result.extend(sort_segment(ordered[start:anchor_index]))
        result.append(ordered[anchor_index])
        start = anchor_index + 1
    result.extend(sort_segment(ordered[start:]))
    return result


def _heading_level(text: str, font_size: float, body_size: float) -> int | None:
    cleaned = text.strip().rstrip(":")
    if not cleaned or len(cleaned) > 140:
        return None

    numbered = _NUMBERED_HEADING.match(cleaned)
    if numbered:
        number = numbered.group("number")
        if number[0].isdigit():
            return min(number.count(".") + 1, 6)
        return 1

    if cleaned.casefold() in _SECTION_HEADINGS or cleaned.casefold() in _NON_REFERENCE_HEADINGS:
        return 1
    return None


def _reference_start(text: str) -> tuple[str, str] | None:
    numbered = _REFERENCE_NUMBER.match(text)
    if numbered:
        number = numbered.group("bracket") or numbered.group("plain")
        return number, numbered.group("text").strip()
    if len(text) >= 35 and _REFERENCE_AUTHOR_YEAR.match(text):
        return "", text.strip()
    return None


def _find_caption(lines: list[dict[str, Any]], start: int) -> tuple[str, list[dict[str, Any]], str] | None:
    match = _CAPTION_PATTERN.match(lines[start]["text"].strip())
    if not match:
        return None
    caption_lines = [lines[start]]
    caption = (match.group("caption") or "").strip()
    for line in lines[start + 1:start + 3]:
        if _CAPTION_PATTERN.match(line["text"].strip()) or _heading_level(line["text"], line["font_size"], 0):
            break
        if abs(line["x0"] - lines[start]["x0"]) > 24 or line["top"] - caption_lines[-1]["bottom"] > 18:
            break
        caption_lines.append(line)
        caption = f"{caption} {line['text']}".strip()
    label = match.group("label")
    kind = "Table" if match.group("kind").casefold() == "table" else "Figure"
    return f"{kind} {label}", caption_lines, caption.strip(" .:–-")


def _figure_image_bbox(
    page: Any,
    caption_lines: list[dict[str, Any]],
    all_captions: list[dict[str, Any]],
) -> dict[str, float] | None:
    c_top = min(float(line["top"]) for line in caption_lines)
    c_bottom = max(float(line["bottom"]) for line in caption_lines)
    c_x0 = min(float(line["x0"]) for line in caption_lines)
    c_x1 = max(float(line["x1"]) for line in caption_lines)
    page_w = float(page.width)
    page_h = float(page.height)

    mid_x = (c_x0 + c_x1) / 2.0
    is_full_width = (c_x1 - c_x0 > page_w * 0.55) or (c_x0 < page_w * 0.25 and c_x1 > page_w * 0.75)

    def in_column(x0: float, x1: float) -> bool:
        if is_full_width:
            return True
        if mid_x < page_w * 0.5:
            return x0 < page_w * 0.58
        return x1 > page_w * 0.42

    header_threshold = 72.0
    footer_threshold = page_h - 50.0

    other_above = [c for c in all_captions if c["bottom"] < c_top - 4]
    limit_top = max([c["bottom"] for c in other_above], default=40.0)
    other_below = [c for c in all_captions if c["top"] > c_bottom + 4]
    limit_bottom = min([c["top"] for c in other_below], default=page_h - 40.0)

    # 1. Raster Image Strategy
    valid_images = []
    for img in page.images:
        ix0, itop, ix1, ibottom = float(img["x0"]), float(img["top"]), float(img["x1"]), float(img["bottom"])
        w = ix1 - ix0
        h = ibottom - itop
        if w >= page_w * 0.95 and h >= page_h * 0.95:
            continue
        if not in_column(ix0, ix1):
            continue
        valid_images.append({"x0": ix0, "top": itop, "x1": ix1, "bottom": ibottom})

    # Images above caption
    images_above = [img for img in valid_images if limit_top - 15 <= img["top"] and img["bottom"] <= c_top + 15]
    if images_above:
        images_above.sort(key=lambda img: img["bottom"], reverse=True)
        img_cluster = []
        curr_top = c_top
        for img in images_above:
            gap = (curr_top - img["bottom"]) if img_cluster else (c_top - img["bottom"])
            if gap <= 65:
                img_cluster.append(img)
                curr_top = min(curr_top, img["top"])
        if img_cluster:
            min_x0 = min(img["x0"] for img in img_cluster)
            min_top = min(img["top"] for img in img_cluster)
            max_x1 = max(img["x1"] for img in img_cluster)
            max_bottom = max(img["bottom"] for img in img_cluster)
            pad = 3.0
            return {
                "x0": round(max(0.0, min_x0 - pad), 2),
                "top": round(max(0.0, min_top - pad), 2),
                "x1": round(min(page_w, max_x1 + pad), 2),
                "bottom": round(min(page_h, max_bottom + pad), 2),
            }

    # Images below caption
    images_below = [img for img in valid_images if c_bottom - 15 <= img["top"] and img["bottom"] <= limit_bottom + 15]
    if images_below:
        images_below.sort(key=lambda img: img["top"])
        img_cluster = []
        curr_bottom = c_bottom
        for img in images_below:
            gap = (img["top"] - curr_bottom) if img_cluster else (img["top"] - c_bottom)
            if gap <= 65:
                img_cluster.append(img)
                curr_bottom = max(curr_bottom, img["bottom"])
        if img_cluster:
            min_x0 = min(img["x0"] for img in img_cluster)
            min_top = min(img["top"] for img in img_cluster)
            max_x1 = max(img["x1"] for img in img_cluster)
            max_bottom = max(img["bottom"] for img in img_cluster)
            pad = 3.0
            return {
                "x0": round(max(0.0, min_x0 - pad), 2),
                "top": round(max(0.0, min_top - pad), 2),
                "x1": round(min(page_w, max_x1 + pad), 2),
                "bottom": round(min(page_h, max_bottom + pad), 2),
            }

    # 2. Vector shapes strategy
    shapes = []
    for s in page.curves + page.rects + page.lines + getattr(page, "figures", []):
        sx0, stop, sx1, sbottom = float(s["x0"]), float(s["top"]), float(s["x1"]), float(s["bottom"])
        w = sx1 - sx0
        h = sbottom - stop
        if w >= page_w * 0.92 and h >= page_h * 0.92:
            continue
        if (stop <= header_threshold and h <= 1.5 and w > page_w * 0.6) or (sbottom >= footer_threshold and h <= 1.5 and w > page_w * 0.6):
            continue
        if stop < 40 or sbottom > page_h - 35:
            continue
        if not in_column(sx0, sx1):
            continue
        shapes.append({"x0": sx0, "top": stop, "x1": sx1, "bottom": sbottom})

    # Vector shapes above caption
    shapes_above = [s for s in shapes if limit_top - 15 <= s["top"] and s["bottom"] <= c_top + 15]
    if shapes_above:
        shapes_above.sort(key=lambda s: s["bottom"], reverse=True)
        cluster = []
        curr_top = c_top
        for s in shapes_above:
            gap = (curr_top - s["bottom"]) if cluster else (c_top - s["bottom"])
            max_gap = 55 if not cluster else 36
            if gap > max_gap:
                break
            cluster.append(s)
            curr_top = min(curr_top, s["top"])

        if cluster:
            min_x0 = min(s["x0"] for s in cluster)
            min_top = min(s["top"] for s in cluster)
            max_x1 = max(s["x1"] for s in cluster)
            max_bottom = max(s["bottom"] for s in cluster)

            words = page.extract_words()
            fig_words = [
                w for w in words
                if (min_x0 - 15 <= float(w["x0"]) <= max_x1 + 15)
                and (min_top - 15 <= float(w["top"]) <= max_bottom + 15)
                and float(w["bottom"]) < c_top - 2
                and in_column(float(w["x0"]), float(w["x1"]))
            ]
            if fig_words:
                min_x0 = min(min_x0, min(float(w["x0"]) for w in fig_words))
                min_top = min(min_top, min(float(w["top"]) for w in fig_words))
                max_x1 = max(max_x1, max(float(w["x1"]) for w in fig_words))
                max_bottom = max(max_bottom, max(float(w["bottom"]) for w in fig_words))

            if (max_x1 - min_x0 >= 30) and (max_bottom - min_top >= 30):
                pad = 4.0
                return {
                    "x0": round(max(0.0, min_x0 - pad), 2),
                    "top": round(max(0.0, min_top - pad), 2),
                    "x1": round(min(page_w, max_x1 + pad), 2),
                    "bottom": round(min(page_h, max_bottom + pad), 2),
                }

    # Vector shapes below caption
    shapes_below = [s for s in shapes if c_bottom - 15 <= s["top"] and s["bottom"] <= limit_bottom + 15]
    if shapes_below:
        shapes_below.sort(key=lambda s: s["top"])
        cluster = []
        curr_bottom = c_bottom
        for s in shapes_below:
            gap = (s["top"] - curr_bottom) if cluster else (s["top"] - c_bottom)
            max_gap = 55 if not cluster else 36
            if gap > max_gap:
                break
            cluster.append(s)
            curr_bottom = max(curr_bottom, s["bottom"])

        if cluster:
            min_x0 = min(s["x0"] for s in cluster)
            min_top = min(s["top"] for s in cluster)
            max_x1 = max(s["x1"] for s in cluster)
            max_bottom = max(s["bottom"] for s in cluster)

            words = page.extract_words()
            fig_words = [
                w for w in words
                if (min_x0 - 15 <= float(w["x0"]) <= max_x1 + 15)
                and (min_top - 15 <= float(w["top"]) <= max_bottom + 15)
                and float(w["top"]) > c_bottom + 2
                and in_column(float(w["x0"]), float(w["x1"]))
            ]
            if fig_words:
                min_x0 = min(min_x0, min(float(w["x0"]) for w in fig_words))
                min_top = min(min_top, min(float(w["top"]) for w in fig_words))
                max_x1 = max(max_x1, max(float(w["x1"]) for w in fig_words))
                max_bottom = max(max_bottom, max(float(w["bottom"]) for w in fig_words))

            if (max_x1 - min_x0 >= 30) and (max_bottom - min_top >= 30):
                pad = 4.0
                return {
                    "x0": round(max(0.0, min_x0 - pad), 2),
                    "top": round(max(0.0, min_top - pad), 2),
                    "x1": round(min(page_w, max_x1 + pad), 2),
                    "bottom": round(min(page_h, max_bottom + pad), 2),
                }

    return None


def _build_outline(lines: list[dict[str, Any]], body_size: float) -> list[dict[str, Any]]:
    roots: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    preamble_lines: list[dict[str, Any]] = []

    for line in lines:
        level = _heading_level(line["text"], line["font_size"], body_size)
        reference_heading = line["text"].strip().rstrip(":").casefold() in _REFERENCE_HEADINGS
        is_numbered_reference_heading = reference_heading and _NUMBERED_HEADING.match(line["text"])
        if level is not None and not is_numbered_reference_heading:
            if preamble_lines and not roots:
                # Add preamble node for lines preceding the first formal section
                preamble_node = {
                    "title": "Title & Overview",
                    "level": 1,
                    "start_page": preamble_lines[0]["page_number"],
                    "end_page": preamble_lines[-1]["page_number"],
                    "start_line": preamble_lines[0]["line_number"],
                    "line_refs": [
                        {"page_number": l["page_number"], "line_number": l["line_number"]}
                        for l in preamble_lines
                    ],
                    "children": [],
                }
                roots.append(preamble_node)
                preamble_lines = []

            while stack and stack[-1]["level"] >= level:
                stack.pop()
            node = {
                "title": line["text"],
                "level": level,
                "start_page": line["page_number"],
                "end_page": line["page_number"],
                "start_line": line["line_number"],
                "line_refs": [{"page_number": line["page_number"], "line_number": line["line_number"]}],
                "children": [],
            }
            (stack[-1]["children"] if stack else roots).append(node)
            stack.append(node)
        elif stack:
            reference = {"page_number": line["page_number"], "line_number": line["line_number"]}
            stack[-1]["line_refs"].append(reference)
            for node in stack:
                node["end_page"] = line["page_number"]
        else:
            preamble_lines.append(line)

    if preamble_lines and not roots:
        roots.append({
            "title": "Full Document",
            "level": 1,
            "start_page": preamble_lines[0]["page_number"],
            "end_page": preamble_lines[-1]["page_number"],
            "start_line": preamble_lines[0]["line_number"],
            "line_refs": [
                {"page_number": l["page_number"], "line_number": l["line_number"]}
                for l in preamble_lines
            ],
            "children": [],
        })

    return roots


def _clean_cell_text(text: Any) -> str:
    if text is None:
        return ""
    text = str(text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def _unpack_multiline_table(cells: list[list[Any]]) -> list[list[str]]:
    """Unpack pdfplumber multi-line collapsed cells into individual rows."""
    if not cells:
        return []
    cleaned = [[_clean_cell_text(cell) for cell in row] for row in cells]
    unpacked_rows: list[list[str]] = []
    for row in cleaned:
        cell_lines = [cell.split("\n") for cell in row]
        max_lines = max((len(cl) for cl in cell_lines), default=1)
        non_empty_counts = [len(cl) for cl in cell_lines if cl and cl != ['']]
        if max_lines > 1 and len(non_empty_counts) >= 2 and max_lines == max(non_empty_counts):
            for line_idx in range(max_lines):
                unpacked_row = []
                for cl in cell_lines:
                    val = cl[line_idx].strip() if line_idx < len(cl) else ""
                    unpacked_row.append(val)
                if any(unpacked_row):
                    unpacked_rows.append(unpacked_row)
        else:
            unpacked_rows.append(row)
    return unpacked_rows


def _extract_spatial_table(crop_page) -> list[list[str]]:
    """Extract structured 2D table cells from a cropped page region using spatial word clustering."""
    words = sorted(crop_page.extract_words(), key=lambda w: (float(w["top"]), float(w["x0"])))
    if not words:
        return []

    # 1. Cluster words into rows by vertical midpoints
    rows: list[dict[str, Any]] = []
    for w in words:
        w_mid_y = (float(w["top"]) + float(w["bottom"])) / 2
        w_height = float(w["bottom"]) - float(w["top"])
        matched_row = None
        for r in rows:
            r_mid_y = (r["top"] + r["bottom"]) / 2
            r_height = r["bottom"] - r["top"]
            if abs(w_mid_y - r_mid_y) <= max(3.0, min(w_height, r_height) * 0.55):
                matched_row = r
                break
        if matched_row is not None:
            matched_row["words"].append(w)
            matched_row["top"] = min(matched_row["top"], float(w["top"]))
            matched_row["bottom"] = max(matched_row["bottom"], float(w["bottom"]))
            matched_row["x0"] = min(matched_row["x0"], float(w["x0"]))
            matched_row["x1"] = max(matched_row["x1"], float(w["x1"]))
        else:
            rows.append({
                "top": float(w["top"]),
                "bottom": float(w["bottom"]),
                "x0": float(w["x0"]),
                "x1": float(w["x1"]),
                "words": [w],
            })

    rows = sorted(rows, key=lambda r: r["top"])
    if not rows:
        return []

    min_x = min(float(w["x0"]) for w in words)
    max_x = max(float(w["x1"]) for w in words)
    total_w = max_x - min_x
    if total_w <= 0:
        return []

    # Check header row (row 0)
    header_row = rows[0]
    header_words = sorted(header_row["words"], key=lambda w: float(w["x0"]))
    header_col_starts = []
    if header_words:
        cur_h = [header_words[0]]
        for hw in header_words[1:]:
            prev = cur_h[-1]
            if float(hw["x0"]) - float(prev["x1"]) > 16.0:
                header_col_starts.append(cur_h)
                cur_h = [hw]
            else:
                cur_h.append(hw)
        header_col_starts.append(cur_h)

    col_bounds = []
    if len(header_col_starts) >= 2:
        col_bounds = [min_x - 1]
        for i in range(len(header_col_starts) - 1):
            h1_right = max(float(w["x1"]) for w in header_col_starts[i])
            h2_left = min(float(w["x0"]) for w in header_col_starts[i+1])
            mid = (h1_right + h2_left) / 2
            col_bounds.append(mid)
        col_bounds.append(max_x + 1)
    else:
        row_gaps = []
        for r in rows:
            r_words = sorted(r["words"], key=lambda w: float(w["x0"]))
            for i in range(len(r_words) - 1):
                gap_start = float(r_words[i]["x1"])
                gap_end = float(r_words[i+1]["x0"])
                gap_size = gap_end - gap_start
                if gap_size > 8.0:
                    row_gaps.append((gap_start, gap_end, (gap_start + gap_end) / 2))

        gap_clusters: list[dict[str, Any]] = []
        for g_start, g_end, g_mid in sorted(row_gaps, key=lambda g: g[2]):
            placed = False
            for gc in gap_clusters:
                if abs(gc["mid"] - g_mid) < 14.0:
                    gc["items"].append((g_start, g_end, g_mid))
                    gc["mid"] = sum(item[2] for item in gc["items"]) / len(gc["items"])
                    placed = True
                    break
            if not placed:
                gap_clusters.append({"mid": g_mid, "items": [(g_start, g_end, g_mid)]})

        strong_gaps = [gc["mid"] for gc in gap_clusters if len(gc["items"]) >= 2]
        col_bounds = [min_x - 1] + sorted(strong_gaps) + [max_x + 1]

    num_cols = len(col_bounds) - 1
    grid: list[list[str]] = []
    for r in rows:
        row_cells = [""] * num_cols
        for w in sorted(r["words"], key=lambda w: float(w["x0"])):
            w_mid_x = (float(w["x0"]) + float(w["x1"])) / 2
            col_idx = 0
            for i in range(num_cols):
                if col_bounds[i] <= w_mid_x < col_bounds[i+1]:
                    col_idx = i
                    break
            if row_cells[col_idx]:
                row_cells[col_idx] += " " + w["text"]
            else:
                row_cells[col_idx] = w["text"]
        if any(row_cells):
            grid.append(row_cells)

    # Remove all-empty columns
    if grid:
        active_col_indices = [
            col_idx for col_idx in range(num_cols)
            if any(grid[r_idx][col_idx].strip() for r_idx in range(len(grid)))
        ]
        if active_col_indices and len(active_col_indices) < num_cols:
            grid = [[row[col_idx] for col_idx in active_col_indices] for row in grid]

    return grid


def extract_manuscript(pdf_bytes: bytes, paper_id: str, file_name: str) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    all_lines: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    figures: list[dict[str, Any]] = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        if not pdf.pages:
            raise ValueError("The PDF has no pages.")
        if len(pdf.pages) > 500:
            raise ValueError("PDF manuscripts are limited to 500 pages.")

        for page_number, page in enumerate(pdf.pages, start=1):
            raw_lines = []
            page_words = page.extract_words()
            for extracted_line in page.extract_text_lines(strip=True, return_chars=True):
                for raw_line in _split_text_line(extracted_line, float(page.width), page_words):
                    text = " ".join(raw_line.get("text", "").split())
                    if not text:
                        continue
                    raw_lines.append({
                        "text": text,
                        "x0": float(raw_line["x0"]),
                        "x1": float(raw_line["x1"]),
                        "top": float(raw_line["top"]),
                        "bottom": float(raw_line["bottom"]),
                        "font_size": _line_font_size(raw_line),
                    })

            sizes = [line["font_size"] for line in raw_lines if line["font_size"] > 0]
            body_size = statistics.median(sizes) if sizes else 0.0
            ordered_lines = _column_order(raw_lines, float(page.width), body_size)
            page_lines = []
            for line_number, line in enumerate(ordered_lines, start=1):
                line_record = {
                    "page_number": page_number,
                    "line_number": line_number,
                    "text": line["text"],
                    "bbox": {"x0": round(line["x0"], 2), "top": round(line["top"], 2), "x1": round(line["x1"], 2), "bottom": round(line["bottom"], 2)},
                    "font_size": round(line["font_size"], 2),
                }
                page_lines.append(line_record)
                all_lines.append(line_record)

            detected_captions: list[dict[str, Any]] = []
            for index, line in enumerate(ordered_lines):
                caption_match = _CAPTION_PATTERN.match(line["text"].strip())
                if not caption_match:
                    continue
                caption_result = _find_caption(ordered_lines, index)
                if not caption_result:
                    continue
                label, caption_lines, caption_text = caption_result
                detected_captions.append({
                    "label": label,
                    "kind": caption_match.group("kind").casefold(),
                    "caption_lines": caption_lines,
                    "caption_text": caption_text,
                    "index": index,
                    "top": min(float(l["top"]) for l in caption_lines),
                    "bottom": max(float(l["bottom"]) for l in caption_lines),
                    "x0": min(float(l["x0"]) for l in caption_lines),
                    "x1": max(float(l["x1"]) for l in caption_lines),
                })

            for caption_info in detected_captions:
                label = caption_info["label"]
                caption_lines = caption_info["caption_lines"]
                caption_text = caption_info["caption_text"]
                caption_refs = [
                    {"page_number": page_number, "line_number": ordered_lines.index(item) + 1}
                    for item in caption_lines
                ]
                item = {
                    "label": label,
                    "caption": caption_text,
                    "page_number": page_number,
                    "line_refs": caption_refs,
                }
                if label.startswith("Figure"):
                    image_bbox = _figure_image_bbox(page, caption_lines, detected_captions)
                    if image_bbox:
                        item["image_bbox"] = image_bbox
                    existing_idx = next((i for i, f in enumerate(figures) if f["label"] == label), None)
                    if existing_idx is not None:
                        if image_bbox and not figures[existing_idx].get("image_bbox"):
                            figures[existing_idx] = item
                        elif not image_bbox:
                            pass
                        else:
                            figures.append(item)
                    else:
                        figures.append(item)

            # Table extraction on current page
            table_captions = [c for c in detected_captions if c["kind"] == "table" or c["label"].startswith("Table")]
            grid_tables = []
            for t in page.find_tables():
                raw_cells = t.extract()
                if not raw_cells or len(raw_cells) < 2 or max((len(r) for r in raw_cells), default=0) < 2:
                    continue
                unpacked = _unpack_multiline_table(raw_cells)
                if len(unpacked) >= 2 and max((len(r) for r in unpacked), default=0) >= 2:
                    grid_tables.append({
                        "bbox": t.bbox,
                        "cells": unpacked,
                    })

            processed_grid_indices = set()
            page_w = float(page.width)
            page_h = float(page.height)

            for caption_info in table_captions:
                label = caption_info["label"]
                caption_text = caption_info["caption_text"]
                c_top = caption_info["top"]
                c_bottom = caption_info["bottom"]
                c_x0 = caption_info["x0"]
                c_x1 = caption_info["x1"]
                c_line = ordered_lines.index(caption_info["caption_lines"][0]) + 1

                nearby_lines = []
                for l in page.lines:
                    l_w = float(l["x1"]) - float(l["x0"])
                    l_top = float(l["top"])
                    if l_w > 40:
                        if (c_bottom - 10 <= l_top <= c_bottom + 450) or (c_top - 350 <= l_top <= c_top + 10):
                            l_x0 = float(l["x0"])
                            l_x1 = float(l["x1"])
                            overlap = min(c_x1, l_x1) - max(c_x0, l_x0)
                            if overlap > 0 or abs(l_x0 - c_x0) < 60 or l_w > page_w * 0.4:
                                nearby_lines.append(l)

                spatial_cells = []
                spatial_bbox = None
                if len(nearby_lines) >= 2:
                    t_top = min(float(l["top"]) for l in nearby_lines) - 2
                    t_bottom = max(float(l["bottom"]) for l in nearby_lines) + 2
                    t_x0 = min(float(l["x0"]) for l in nearby_lines) - 2
                    t_x1 = max(float(l["x1"]) for l in nearby_lines) + 2
                    crop = page.crop((max(0.0, t_x0), max(0.0, t_top), min(page_w, t_x1), min(page_h, t_bottom)))
                    spatial_cells = _extract_spatial_table(crop)
                    spatial_bbox = {
                        "x0": round(t_x0, 2), "top": round(t_top, 2),
                        "x1": round(t_x1, 2), "bottom": round(t_bottom, 2),
                    }

                matching_grid_idx = None
                for idx, gt in enumerate(grid_tables):
                    if idx in processed_grid_indices:
                        continue
                    gx0, gtop, gx1, gbottom = gt["bbox"]
                    dist = min(abs(c_top - gbottom), abs(c_bottom - gtop))
                    if dist <= 120:
                        matching_grid_idx = idx
                        break

                chosen_cells = []
                chosen_bbox = None
                if spatial_cells and len(spatial_cells) >= 2 and max((len(r) for r in spatial_cells), default=0) >= 2:
                    if matching_grid_idx is not None and len(grid_tables[matching_grid_idx]["cells"]) > len(spatial_cells):
                        chosen_cells = grid_tables[matching_grid_idx]["cells"]
                        gx0, gtop, gx1, gbottom = grid_tables[matching_grid_idx]["bbox"]
                        chosen_bbox = {"x0": round(gx0, 2), "top": round(gtop, 2), "x1": round(gx1, 2), "bottom": round(gbottom, 2)}
                        processed_grid_indices.add(matching_grid_idx)
                    else:
                        chosen_cells = spatial_cells
                        chosen_bbox = spatial_bbox
                        if matching_grid_idx is not None:
                            processed_grid_indices.add(matching_grid_idx)
                elif matching_grid_idx is not None:
                    chosen_cells = grid_tables[matching_grid_idx]["cells"]
                    gx0, gtop, gx1, gbottom = grid_tables[matching_grid_idx]["bbox"]
                    chosen_bbox = {"x0": round(gx0, 2), "top": round(gtop, 2), "x1": round(gx1, 2), "bottom": round(gbottom, 2)}
                    processed_grid_indices.add(matching_grid_idx)

                if chosen_cells and len(chosen_cells) >= 2:
                    tables.append({
                        "label": label,
                        "caption": caption_text,
                        "page_number": page_number,
                        "bbox": chosen_bbox or {"x0": round(c_x0, 2), "top": round(c_bottom, 2), "x1": round(c_x1, 2), "bottom": round(min(page_h, c_bottom + 200), 2)},
                        "line_refs": [{"page_number": page_number, "line_number": c_line}],
                        "cells": chosen_cells,
                    })

            for idx, gt in enumerate(grid_tables):
                if idx not in processed_grid_indices:
                    gx0, gtop, gx1, gbottom = gt["bbox"]
                    tables.append({
                        "label": f"Table (Page {page_number})",
                        "caption": None,
                        "page_number": page_number,
                        "bbox": {"x0": round(gx0, 2), "top": round(gtop, 2), "x1": round(gx1, 2), "bottom": round(gbottom, 2)},
                        "line_refs": [],
                        "cells": gt["cells"],
                    })

            pages.append({
                "page_number": page_number,
                "width": round(float(page.width), 2),
                "height": round(float(page.height), 2),
                "lines": page_lines,
            })

    all_sizes = [line["font_size"] for line in all_lines if line["font_size"] > 0]
    body_size = statistics.median(all_sizes) if all_sizes else 0.0
    outline = _build_outline(all_lines, body_size)

    references: list[dict[str, Any]] = []
    in_references = False
    active_reference: dict[str, Any] | None = None
    for line in all_lines:
        normalized_heading = line["text"].strip().rstrip(":").casefold()
        if normalized_heading in _REFERENCE_HEADINGS:
            in_references = True
            active_reference = None
            continue
        if in_references and normalized_heading in _NON_REFERENCE_HEADINGS:
            in_references = False
            active_reference = None
        if not in_references:
            continue
        start = _reference_start(line["text"])
        if start:
            label, text = start
            active_reference = {
                "label": label,
                "text": text,
                "page_number": line["page_number"],
                "line_refs": [{"page_number": line["page_number"], "line_number": line["line_number"]}],
            }
            references.append(active_reference)
        elif active_reference and line["text"]:
            active_reference["text"] = f"{active_reference['text']} {line['text']}"
            active_reference["line_refs"].append({"page_number": line["page_number"], "line_number": line["line_number"]})

    warnings = []
    if not all_lines:
        warnings.append("No selectable text was found. This may be a scanned PDF and require OCR.")

    return {
        "schema_version": 3,
        "paper_id": paper_id,
        "file_name": file_name,
        "page_count": len(pages),
        "line_count": len(all_lines),
        "sections": outline,
        "pages": pages,
        "figures": figures,
        "tables": tables,
        "references": references,
        "warnings": warnings,
    }