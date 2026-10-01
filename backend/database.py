import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DEFAULT_DATABASE_PATH = Path(__file__).resolve().parent.parent / "data" / "fieldnote.sqlite3"
DATABASE_PATH = Path(os.getenv("FIELDNOTE_DATABASE_PATH", DEFAULT_DATABASE_PATH))


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with session() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS paper_lists (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                min_score INTEGER NOT NULL DEFAULT 9 CHECK (min_score BETWEEN 0 AND 10),
                position INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                authors TEXT NOT NULL DEFAULT '',
                year TEXT NOT NULL DEFAULT '',
                journal TEXT NOT NULL DEFAULT '',
                doi TEXT NOT NULL DEFAULT '',
                url TEXT NOT NULL DEFAULT '',
                abstract TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS list_papers (
                list_id TEXT NOT NULL REFERENCES paper_lists(id) ON DELETE CASCADE,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 10),
                rationale TEXT,
                PRIMARY KEY (list_id, paper_id)
            );
            CREATE INDEX IF NOT EXISTS list_papers_paper_id_idx ON list_papers(paper_id);
            CREATE TABLE IF NOT EXISTS manuscripts (
                paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
                file_name TEXT NOT NULL,
                page_count INTEGER NOT NULL,
                line_count INTEGER NOT NULL,
                extracted_at TEXT NOT NULL,
                warnings_json TEXT NOT NULL DEFAULT '[]',
                document_json TEXT NOT NULL,
                pdf_blob BLOB
            );
            CREATE TABLE IF NOT EXISTS manuscript_figure_previews (
                paper_id TEXT NOT NULL REFERENCES manuscripts(paper_id) ON DELETE CASCADE,
                figure_index INTEGER NOT NULL,
                image_blob BLOB NOT NULL,
                PRIMARY KEY (paper_id, figure_index)
            );
            """
        )
        list_paper_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(list_papers)")
        }
        if "manual_visibility" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN manual_visibility TEXT")
        if "extracted_data" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN extracted_data TEXT")
        if "decision" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN decision TEXT")
        if "explanation" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN explanation TEXT")
        if "ai_decision" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN ai_decision TEXT")
        if "ai_explanation" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN ai_explanation TEXT")
        if "manual_decision" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN manual_decision TEXT")
        if "manual_explanation" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN manual_explanation TEXT")
        if "decision_source" not in list_paper_columns:
            connection.execute("ALTER TABLE list_papers ADD COLUMN decision_source TEXT")

        paper_list_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(paper_lists)")
        }
        if "stage_type" not in paper_list_columns:
            connection.execute("ALTER TABLE paper_lists ADD COLUMN stage_type TEXT DEFAULT 'standard'")
        if "inclusion_criteria" not in paper_list_columns:
            connection.execute("ALTER TABLE paper_lists ADD COLUMN inclusion_criteria TEXT DEFAULT ''")
        if "exclusion_criteria" not in paper_list_columns:
            connection.execute("ALTER TABLE paper_lists ADD COLUMN exclusion_criteria TEXT DEFAULT ''")
        if "extraction_fields" not in paper_list_columns:
            connection.execute("ALTER TABLE paper_lists ADD COLUMN extraction_fields TEXT DEFAULT '[]'")
        if "synthesis_text" not in paper_list_columns:
            connection.execute("ALTER TABLE paper_lists ADD COLUMN synthesis_text TEXT DEFAULT ''")
        if "synthesis_prompt" not in paper_list_columns:
            connection.execute("ALTER TABLE paper_lists ADD COLUMN synthesis_prompt TEXT DEFAULT ''")


def _manuscript_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None or row["file_name"] is None:
        return None
    return {
        "fileName": row["file_name"],
        "pageCount": row["page_count"],
        "lineCount": row["line_count"],
        "extractedAt": row["extracted_at"],
        "warnings": json.loads(row["warnings_json"]),
    }


def get_projects() -> list[dict[str, Any]]:
    with session() as connection:
        projects = connection.execute("SELECT * FROM projects ORDER BY position").fetchall()
        result = []
        for project in projects:
            lists = connection.execute(
                "SELECT * FROM paper_lists WHERE project_id = ? ORDER BY position",
                (project["id"],),
            ).fetchall()
            project_lists = []
            for list_position, paper_list in enumerate(lists):
                entries = connection.execute(
                    """
                    SELECT papers.*, list_papers.score, list_papers.rationale, list_papers.decision, list_papers.explanation, list_papers.manual_visibility, list_papers.extracted_data,
                           list_papers.ai_decision, list_papers.ai_explanation, list_papers.manual_decision, list_papers.manual_explanation, list_papers.decision_source,
                           manuscripts.file_name, manuscripts.page_count,
                           manuscripts.line_count, manuscripts.extracted_at,
                           manuscripts.warnings_json
                    FROM list_papers
                    JOIN papers ON papers.id = list_papers.paper_id
                    LEFT JOIN manuscripts ON manuscripts.paper_id = papers.id
                    WHERE list_papers.list_id = ?
                    ORDER BY list_papers.position
                    """,
                    (paper_list["id"],),
                ).fetchall()
                papers = []
                for paper in entries:
                    paper_dict = dict(paper)
                    dec = paper_dict.get("decision")
                    expl = paper_dict.get("explanation") or paper_dict.get("rationale")
                    if dec is None and paper_dict.get("score") is not None:
                        s = paper_dict["score"]
                        dec = "Yes" if s >= 8 else "Not Sure" if s >= 5 else "No"
                    
                    if list_position == 0:
                        # Primary/master list (Stage 1 by default): full record
                        record = {
                            "id": paper["id"],
                            "title": paper["title"],
                            "authors": paper["authors"],
                            "year": paper["year"],
                            "journal": paper["journal"],
                            "doi": paper["doi"],
                            "url": paper["url"],
                            "abstract": paper["abstract"],
                        }
                        if dec is not None:
                            record["include"] = dec
                            record["decision"] = dec
                        if expl is not None:
                            record["explanation"] = expl
                            record["rationale"] = expl
                        if paper["score"] is not None:
                            record["score"] = paper["score"]
                        if paper["manual_visibility"] is not None:
                            record["manualVisibility"] = paper["manual_visibility"]
                        if paper_dict.get("ai_decision") is not None:
                            record["aiDecision"] = paper_dict["ai_decision"]
                        if paper_dict.get("ai_explanation") is not None:
                            record["aiExplanation"] = paper_dict["ai_explanation"]
                        if paper_dict.get("manual_decision") is not None:
                            record["manualDecision"] = paper_dict["manual_decision"]
                        if paper_dict.get("manual_explanation") is not None:
                            record["manualExplanation"] = paper_dict["manual_explanation"]
                        if paper_dict.get("decision_source") is not None:
                            record["decisionSource"] = paper_dict["decision_source"]
                        if paper["extracted_data"]:
                            try:
                                record["extractedData"] = json.loads(paper["extracted_data"])
                            except Exception:
                                pass
                        manuscript = _manuscript_dict(paper)
                        if manuscript:
                            record["manuscript"] = manuscript
                        papers.append(record)
                    else:
                        # Additional lists/stages: store reference and stage-specific score/rationale/manualVisibility/extractedData only
                        record = {
                            "id": paper["id"],
                        }
                        if dec is not None:
                            record["include"] = dec
                            record["decision"] = dec
                        if expl is not None:
                            record["explanation"] = expl
                            record["rationale"] = expl
                        if paper["score"] is not None:
                            record["score"] = paper["score"]
                        if paper["manual_visibility"] is not None:
                            record["manualVisibility"] = paper["manual_visibility"]
                        if paper_dict.get("ai_decision") is not None:
                            record["aiDecision"] = paper_dict["ai_decision"]
                        if paper_dict.get("ai_explanation") is not None:
                            record["aiExplanation"] = paper_dict["ai_explanation"]
                        if paper_dict.get("manual_decision") is not None:
                            record["manualDecision"] = paper_dict["manual_decision"]
                        if paper_dict.get("manual_explanation") is not None:
                            record["manualExplanation"] = paper_dict["manual_explanation"]
                        if paper_dict.get("decision_source") is not None:
                            record["decisionSource"] = paper_dict["decision_source"]
                        if paper["extracted_data"]:
                            try:
                                record["extractedData"] = json.loads(paper["extracted_data"])
                            except Exception:
                                pass
                        papers.append(record)
                
                raw_extraction_fields = paper_list["extraction_fields"] if "extraction_fields" in paper_list.keys() and paper_list["extraction_fields"] else "[]"
                try:
                    parsed_extraction_fields = json.loads(raw_extraction_fields)
                except Exception:
                    parsed_extraction_fields = []

                synthesis_text = paper_list["synthesis_text"] if "synthesis_text" in paper_list.keys() and paper_list["synthesis_text"] else ""
                synthesis_prompt = paper_list["synthesis_prompt"] if "synthesis_prompt" in paper_list.keys() and paper_list["synthesis_prompt"] else ""

                project_lists.append({
                    "id": paper_list["id"],
                    "name": paper_list["name"],
                    "minScore": paper_list["min_score"],
                    "stageType": paper_list["stage_type"] if "stage_type" in paper_list.keys() and paper_list["stage_type"] else "standard",
                    "inclusionCriteria": paper_list["inclusion_criteria"] if "inclusion_criteria" in paper_list.keys() and paper_list["inclusion_criteria"] else "",
                    "exclusionCriteria": paper_list["exclusion_criteria"] if "exclusion_criteria" in paper_list.keys() and paper_list["exclusion_criteria"] else "",
                    "extractionFields": parsed_extraction_fields,
                    "synthesisText": synthesis_text,
                    "synthesisPrompt": synthesis_prompt,
                    "papers": papers,
                })
            result.append({
                "id": project["id"],
                "name": project["name"],
                "createdAt": project["created_at"],
                "lists": project_lists,
            })
        return result


def replace_projects(projects: list[dict[str, Any]]) -> None:
    with session() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM projects")
        for project_position, project in enumerate(projects):
            connection.execute(
                "INSERT INTO projects (id, name, created_at, position) VALUES (?, ?, ?, ?)",
                (project["id"], project["name"], project["createdAt"], project_position),
            )
            for list_position, paper_list in enumerate(project["lists"]):
                stage_type = paper_list.get("stageType", "standard") or "standard"
                inclusion_criteria = paper_list.get("inclusionCriteria", "") or ""
                exclusion_criteria = paper_list.get("exclusionCriteria", "") or ""
                synthesis_text = paper_list.get("synthesisText", "") or ""
                synthesis_prompt = paper_list.get("synthesisPrompt", "") or ""
                extraction_fields_json = json.dumps(paper_list.get("extractionFields", []))

                connection.execute(
                    """
                    INSERT INTO paper_lists (id, project_id, name, min_score, position, stage_type, inclusion_criteria, exclusion_criteria, extraction_fields, synthesis_text, synthesis_prompt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        paper_list["id"],
                        project["id"],
                        paper_list["name"],
                        paper_list.get("minScore", 9),
                        list_position,
                        stage_type,
                        inclusion_criteria,
                        exclusion_criteria,
                        extraction_fields_json,
                        synthesis_text,
                        synthesis_prompt,
                    ),
                )
                for paper_position, paper in enumerate(paper_list["papers"]):
                    if paper.get("title"):
                        connection.execute(
                            """
                            INSERT INTO papers (id, title, authors, year, journal, doi, url, abstract)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                title = excluded.title, authors = excluded.authors,
                                year = excluded.year, journal = excluded.journal,
                                doi = excluded.doi, url = excluded.url, abstract = excluded.abstract
                            """,
                            (
                                paper["id"], paper["title"], paper.get("authors", ""),
                                paper.get("year", ""), paper.get("journal", ""),
                                paper.get("doi", ""), paper.get("url", ""), paper.get("abstract", ""),
                            ),
                        )
                    extracted_data_json = json.dumps(paper.get("extractedData")) if paper.get("extractedData") is not None else None
                    dec_val = paper.get("include") or paper.get("decision")
                    expl_val = paper.get("explanation") or paper.get("rationale")
                    score_val = paper.get("score")
                    if score_val is None and dec_val is not None:
                        score_val = 10 if dec_val == "Yes" else 0 if dec_val == "No" else 5
                    connection.execute(
                        """
                        INSERT INTO list_papers (
                            list_id, paper_id, position, score, rationale, decision, explanation,
                            manual_visibility, extracted_data, ai_decision, ai_explanation,
                            manual_decision, manual_explanation, decision_source
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            paper_list["id"], paper["id"], paper_position, score_val, expl_val,
                            dec_val, expl_val, paper.get("manualVisibility"), extracted_data_json,
                            paper.get("aiDecision"), paper.get("aiExplanation"),
                            paper.get("manualDecision"), paper.get("manualExplanation"),
                            paper.get("decisionSource"),
                        ),
                    )
                    manuscript = paper.get("manuscript")
                    if manuscript:
                        document_path = DATABASE_PATH.parent / "manuscripts" / paper["id"] / "document.json"
                        pdf_path = DATABASE_PATH.parent / "manuscripts" / paper["id"] / "manuscript.pdf"
                        existing_manuscript = connection.execute(
                            "SELECT document_json, pdf_blob FROM manuscripts WHERE paper_id = ?",
                            (paper["id"],),
                        ).fetchone()
                        if existing_manuscript:
                            document_json = existing_manuscript["document_json"]
                            pdf_blob = existing_manuscript["pdf_blob"]
                        else:
                            document_json = document_path.read_text(encoding="utf-8") if document_path.is_file() else "{}"
                            pdf_blob = pdf_path.read_bytes() if pdf_path.is_file() else None
                        connection.execute(
                            """
                            INSERT INTO manuscripts
                                (paper_id, file_name, page_count, line_count, extracted_at, warnings_json, document_json, pdf_blob)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(paper_id) DO UPDATE SET
                                file_name = excluded.file_name,
                                page_count = excluded.page_count,
                                line_count = excluded.line_count,
                                extracted_at = excluded.extracted_at,
                                warnings_json = excluded.warnings_json,
                                document_json = CASE WHEN excluded.document_json = '{}' THEN manuscripts.document_json ELSE excluded.document_json END,
                                pdf_blob = COALESCE(excluded.pdf_blob, manuscripts.pdf_blob)
                            """,
                            (
                                paper["id"], manuscript["fileName"], manuscript["pageCount"],
                                manuscript["lineCount"], manuscript["extractedAt"],
                                json.dumps(manuscript.get("warnings", [])), document_json, pdf_blob,
                            ),
                        )
        connection.execute("DELETE FROM papers WHERE id NOT IN (SELECT paper_id FROM list_papers)")


def delete_project(project_id: str) -> None:
    with session() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        connection.execute("DELETE FROM papers WHERE id NOT IN (SELECT paper_id FROM list_papers)")


def paper_exists(paper_id: str) -> bool:
    with session() as connection:
        return connection.execute("SELECT 1 FROM papers WHERE id = ?", (paper_id,)).fetchone() is not None


def save_manuscript(
    document: dict[str, Any],
    pdf_bytes: bytes,
    figure_previews: list[tuple[int, bytes]] | None = None,
) -> None:
    with session() as connection:
        connection.execute(
            """
            INSERT INTO manuscripts
                (paper_id, file_name, page_count, line_count, extracted_at, warnings_json, document_json, pdf_blob)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(paper_id) DO UPDATE SET
                file_name = excluded.file_name,
                page_count = excluded.page_count,
                line_count = excluded.line_count,
                extracted_at = excluded.extracted_at,
                warnings_json = excluded.warnings_json,
                document_json = excluded.document_json,
                pdf_blob = excluded.pdf_blob
            """,
            (
                document["paper_id"], document["file_name"], document["page_count"],
                document["line_count"], document["extracted_at"],
                json.dumps(document["warnings"]),
                json.dumps(document, ensure_ascii=False, separators=(",", ":")),
                sqlite3.Binary(pdf_bytes),
            ),
        )
        if figure_previews is not None:
            connection.execute(
                "DELETE FROM manuscript_figure_previews WHERE paper_id = ?",
                (document["paper_id"],),
            )
            connection.executemany(
                "INSERT INTO manuscript_figure_previews (paper_id, figure_index, image_blob) VALUES (?, ?, ?)",
                [(document["paper_id"], index, sqlite3.Binary(image)) for index, image in figure_previews],
            )


def get_manuscript(paper_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            "SELECT document_json FROM manuscripts WHERE paper_id = ?", (paper_id,)
        ).fetchone()
    return json.loads(row["document_json"]) if row else None


def get_manuscript_pdf(paper_id: str) -> bytes | None:
    with session() as connection:
        row = connection.execute(
            "SELECT pdf_blob FROM manuscripts WHERE paper_id = ?", (paper_id,)
        ).fetchone()
    return bytes(row["pdf_blob"]) if row and row["pdf_blob"] is not None else None


def get_figure_preview(paper_id: str, figure_index: int) -> bytes | None:
    with session() as connection:
        row = connection.execute(
            "SELECT image_blob FROM manuscript_figure_previews WHERE paper_id = ? AND figure_index = ?",
            (paper_id, figure_index),
        ).fetchone()
    return bytes(row["image_blob"]) if row else None


def save_figure_preview(paper_id: str, figure_index: int, image: bytes) -> None:
    with session() as connection:
        connection.execute(
            """
            INSERT INTO manuscript_figure_previews (paper_id, figure_index, image_blob)
            VALUES (?, ?, ?)
            ON CONFLICT(paper_id, figure_index) DO UPDATE SET image_blob = excluded.image_blob
            """,
            (paper_id, figure_index, sqlite3.Binary(image)),
        )


initialize_database()
