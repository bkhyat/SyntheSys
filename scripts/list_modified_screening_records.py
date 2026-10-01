#!/usr/bin/env python3
"""
list_modified_screening_records.py

Lists out all records in a specified screening stage (default: "Title/Abstract 2nd")
for which the decision or screening remarks were manually modified.

Usage:
    python scripts/list_modified_screening_records.py
    python scripts/list_modified_screening_records.py --stage "Title/Abstract 2nd" --csv modified_records.csv
"""

import argparse
import csv
import json
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "fieldnote.sqlite3"


def get_manually_modified_records(db_path: Path, stage_name: str = "Title/Abstract 2nd"):
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at: {db_path}")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    # 1. Find the target stage/list
    stage = con.execute(
        "SELECT id, project_id, name, stage_type FROM paper_lists WHERE name = ? COLLATE NOCASE",
        (stage_name,),
    ).fetchone()

    if not stage:
        # Fallback: check matching stage names
        all_stages = [r["name"] for r in con.execute("SELECT name FROM paper_lists").fetchall()]
        raise ValueError(
            f"Stage '{stage_name}' not found. Available stages in DB: {all_stages}"
        )

    # 2. Check available columns in list_papers
    columns = {r["name"] for r in con.execute("PRAGMA table_info(list_papers)").fetchall()}

    # 3. Query all papers in this stage with paper metadata
    query = f"""
        SELECT 
            lp.paper_id,
            lp.position,
            lp.score,
            lp.rationale,
            lp.decision,
            lp.explanation,
            lp.manual_visibility,
            {"lp.ai_decision, lp.ai_explanation, lp.manual_decision, lp.manual_explanation, lp.decision_source," if "ai_decision" in columns else ""}
            p.title,
            p.authors,
            p.year,
            p.journal,
            p.doi,
            p.url,
            p.abstract
        FROM list_papers lp
        JOIN papers p ON p.id = lp.paper_id
        WHERE lp.list_id = ?
        ORDER BY lp.position ASC
    """

    rows = con.execute(query, (stage["id"],)).fetchall()

    modified_records = []
    for row in rows:
        r = dict(row)
        reasons = []

        # Criteria 1: Explicit decision_source == 'manual'
        if r.get("decision_source") == "manual":
            reasons.append("Decision Source: Manual Override")

        # Criteria 2: Explicit manual_decision or manual_explanation
        if r.get("manual_decision") is not None:
            reasons.append(f"Manual Decision: {r['manual_decision']}")
        if r.get("manual_explanation") is not None and r.get("manual_explanation").strip():
            reasons.append(f"Manual Remarks: {r['manual_explanation']}")

        # Criteria 3: Manual visibility override ('show' or 'hide')
        if r.get("manual_visibility") is not None:
            reasons.append(f"Manual Visibility: {r['manual_visibility']}")

        # Criteria 4: Reviewer comments / custom rationale (heuristic for legacy entries)
        expl = (r.get("explanation") or r.get("rationale") or "").strip()
        custom_notes = [
            "Conference Abstract",
            "Not a research study",
            "Not a research Study",
            "Couldn't be found",
            "Looks like a DT paper",
        ]
        if any(expl.lower() == note.lower() for note in custom_notes):
            if not any("Manual Remarks" in reason for reason in reasons):
                reasons.append(f'Reviewer Note: "{expl}"')

        # If any manual criteria matched
        if reasons:
            r["detection_reasons"] = reasons
            modified_records.append(r)

    con.close()
    return stage, len(rows), modified_records


def main():
    parser = argparse.ArgumentParser(
        description="List manually modified screening records from SyntheSys SQLite database."
    )
    parser.add_argument(
        "--stage",
        type=str,
        default="Title/Abstract 2nd",
        help='Target stage name (default: "Title/Abstract 2nd")',
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=Path(os.getenv("FIELDNOTE_DATABASE_PATH", DEFAULT_DB_PATH)),
        help="Path to fieldnote.sqlite3 database file",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Optional path to export results to a CSV file",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON array of modified records",
    )

    args = parser.parse_args()

    try:
        stage, total_count, modified_records = get_manually_modified_records(
            args.db, args.stage
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(modified_records, indent=2))
        return

    print("=" * 80)
    print(f"STAGE: {stage['name']} (ID: {stage['id']})")
    print(f"TOTAL RECORDS IN STAGE: {total_count}")
    print(f"MANUALLY MODIFIED RECORDS: {len(modified_records)}")
    print("=" * 80)

    if not modified_records:
        print("No manually modified records found in this stage.")
        return

    for idx, r in enumerate(modified_records, 1):
        dec = r.get("decision") or r.get("include") or "Unscreened"
        expl = r.get("explanation") or r.get("rationale") or "—"
        vis = r.get("manual_visibility") or "default"

        print(f"\n[{idx}] {r.get('title')}")
        print(f"    Paper ID:           {r.get('paper_id')}")
        print(f"    Authors:            {r.get('authors') or 'N/A'}")
        print(f"    Year / Journal:     {r.get('year') or '—'} | {r.get('journal') or '—'}")
        print(f"    DOI:                {r.get('doi') or '—'}")
        print(f"    Decision:           {dec}")
        print(f"    Remarks / Rationale:{expl}")
        print(f"    Manual Visibility:  {vis}")
        print(f"    Trigger(s):         {', '.join(r.get('detection_reasons', []))}")

    # CSV Export if requested
    if args.csv:
        fieldnames = [
            "paper_id",
            "title",
            "authors",
            "year",
            "journal",
            "doi",
            "url",
            "decision",
            "explanation",
            "manual_visibility",
            "detection_triggers",
        ]
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for r in modified_records:
                writer.writerow(
                    {
                        "paper_id": r.get("paper_id"),
                        "title": r.get("title"),
                        "authors": r.get("authors"),
                        "year": r.get("year"),
                        "journal": r.get("journal"),
                        "doi": r.get("doi"),
                        "url": r.get("url"),
                        "decision": r.get("decision") or r.get("include"),
                        "explanation": r.get("explanation") or r.get("rationale"),
                        "manual_visibility": r.get("manual_visibility"),
                        "detection_triggers": "; ".join(r.get("detection_reasons", [])),
                    }
                )
        print(f"\n[+] Exported {len(modified_records)} records to CSV: {args.csv.resolve()}")


if __name__ == "__main__":
    main()
