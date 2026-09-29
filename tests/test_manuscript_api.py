import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.main as backend
from backend import database
from backend.pdf_parser import extract_manuscript
from tests.test_pdf_parser import make_test_pdf


class ManuscriptApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        self.database_path_patch = patch.object(database, "DATABASE_PATH", root / "fieldnote.sqlite3")
        self.manuscript_path_patch = patch.object(backend, "MANUSCRIPT_ROOT", root / "manuscripts")
        self.env_patch = patch.dict("os.environ", {"LLM_PROVIDER": "mock"})
        self.database_path_patch.start()
        self.manuscript_path_patch.start()
        self.env_patch.start()
        database.initialize_database()
        database.replace_projects([{
            "id": "project-1",
            "name": "Test project",
            "createdAt": "2026-09-26T00:00:00Z",
            "lists": [{
                "id": "list-1",
                "name": "List 1",
                "minScore": 9,
                "papers": [{"id": "paper-1", "title": "Test manuscript", "abstract": "Abstract."}],
            }],
        }])

    def tearDown(self):
        self.env_patch.stop()
        self.manuscript_path_patch.stop()
        self.database_path_patch.stop()
        self.temporary_directory.cleanup()

    def test_upload_stores_pdf_and_structured_document(self):
        pdf_bytes = make_test_pdf()
        client = TestClient(backend.app)
        response = client.post(
            "/api/papers/paper-1/manuscript",
            files={"file": ("study.pdf", pdf_bytes, "application/pdf")},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["page_count"], 1)

        document_response = client.get("/api/papers/paper-1/manuscript")
        self.assertEqual(document_response.status_code, 200)
        doc_json = document_response.json()
        self.assertIn("mapped_sections", doc_json)
        self.assertEqual(doc_json["figures"][0]["label"], "Figure 1")
        self.assertIn("bbox", doc_json["pages"][0]["lines"][0])

        # Test on-demand summarization endpoint
        summarize_response = client.post("/api/papers/paper-1/summarize")
        self.assertEqual(summarize_response.status_code, 200)
        self.assertIn("overall_summary", summarize_response.json())
        self.assertIn("summary", summarize_response.json()["sections"][0])

        document = summarize_response.json()
        document["figures"][0]["image_bbox"] = {"x0": 72, "top": 520, "x1": 310, "bottom": 570}
        preview_bytes = b"\x89PNG\r\n\x1a\nfixture"
        database.save_manuscript(document, pdf_bytes, [(0, preview_bytes)])

        figure_response = client.get("/api/papers/paper-1/figures/0.png")
        self.assertEqual(figure_response.status_code, 200)
        self.assertEqual(figure_response.headers["content-type"], "image/png")
        self.assertEqual(figure_response.content, preview_bytes)

        pdf_response = client.get("/api/papers/paper-1/manuscript.pdf")
        self.assertEqual(pdf_response.status_code, 200)
        self.assertEqual(pdf_response.content, pdf_bytes)
        with database.session() as connection:
            stored_pdf = connection.execute(
                "SELECT pdf_blob FROM manuscripts WHERE paper_id = ?", ("paper-1",)
            ).fetchone()[0]
        self.assertEqual(stored_pdf, pdf_bytes)

        projects_response = client.get("/api/projects")
        self.assertEqual(projects_response.json()[0]["lists"][0]["papers"][0]["manuscript"]["fileName"], "study.pdf")

    def test_rejects_non_pdf_upload(self):
        response = TestClient(backend.app).post(
            "/api/papers/paper-1/manuscript",
            files={"file": ("notes.pdf", b"not a PDF", "application/pdf")},
        )

        self.assertEqual(response.status_code, 415)

    def test_legacy_manuscript_upgrade_survives_project_snapshot_saves(self):
        pdf_bytes = make_test_pdf()
        legacy_document = extract_manuscript(pdf_bytes, "paper-1", "study.pdf")
        legacy_document["schema_version"] = 1
        legacy_document["extracted_at"] = "2026-01-01T00:00:00+00:00"
        legacy_directory = Path(backend.MANUSCRIPT_ROOT) / "paper-1"
        legacy_directory.mkdir(parents=True)
        (legacy_directory / "manuscript.pdf").write_bytes(pdf_bytes)
        (legacy_directory / "document.json").write_text("{}", encoding="utf-8")
        database.save_manuscript(legacy_document, pdf_bytes)

        client = TestClient(backend.app)
        upgraded = client.get("/api/papers/paper-1/manuscript")
        self.assertEqual(upgraded.status_code, 200, upgraded.text)
        self.assertEqual(upgraded.json()["schema_version"], 3)

        projects = client.get("/api/projects").json()
        snapshot = client.put("/api/projects", json=projects)
        self.assertEqual(snapshot.status_code, 200, snapshot.text)
        persisted = database.get_manuscript("paper-1")
        self.assertEqual(persisted["schema_version"], 3)

    def test_projects_round_trip_and_preserve_shared_paper_copies(self):
        projects = [{
            "id": "project-2",
            "name": "Relational review",
            "createdAt": "2026-09-26T00:00:00Z",
            "lists": [
                {"id": "source", "name": "Search", "minScore": 9, "papers": [{"id": "shared", "title": "Shared paper", "score": 8, "manualVisibility": "hide"}]},
                {"id": "screened", "name": "Screened", "minScore": 7, "papers": [{"id": "shared", "score": 8, "rationale": "Strong match.", "manualVisibility": "show"}]},
            ],
        }]
        response = TestClient(backend.app).put("/api/projects", json=projects)

        self.assertEqual(response.status_code, 200, response.text)
        loaded = response.json()
        self.assertEqual(len(loaded), 1)
        self.assertEqual([paper["id"] for paper in loaded[0]["lists"][1]["papers"]], ["shared"])
        self.assertEqual(loaded[0]["lists"][0]["papers"][0]["manualVisibility"], "hide")
        self.assertEqual(loaded[0]["lists"][1]["papers"][0]["manualVisibility"], "show")
        self.assertEqual(loaded[0]["lists"][1]["papers"][0]["score"], 8)
        self.assertEqual(loaded[0]["lists"][1]["papers"][0]["rationale"], "Strong match.")
        self.assertIn("title", loaded[0]["lists"][0]["papers"][0])
        self.assertNotIn("title", loaded[0]["lists"][1]["papers"][0])
        with database.session() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM list_papers").fetchone()[0], 2)
            row = connection.execute("SELECT manual_visibility FROM list_papers WHERE list_id = 'source'").fetchone()
            self.assertEqual(row[0], "hide")

    def test_synthesis_stage_round_trip(self):
        projects = [{
            "id": "proj-synthesis",
            "name": "Synthesis Project",
            "createdAt": "2026-09-26T00:00:00Z",
            "lists": [
                {
                    "id": "stage-1",
                    "name": "Stage 1",
                    "stageType": "standard",
                    "minScore": 9,
                    "papers": [{"id": "paper-1", "title": "Paper 1"}],
                },
                {
                    "id": "stage-4",
                    "name": "Stage 4 (SLR Synthesis)",
                    "stageType": "synthesis",
                    "synthesisText": "# Systematic Literature Review\n\nComparative synthesis text...",
                    "synthesisPrompt": "Focus on deep learning architectures",
                    "minScore": 9,
                    "papers": [{"id": "paper-1"}],
                },
            ],
        }]
        client = TestClient(backend.app)
        put_res = client.put("/api/projects", json=projects)
        self.assertEqual(put_res.status_code, 200, put_res.text)

        loaded = client.get("/api/projects").json()
        self.assertEqual(len(loaded), 1)
        synthesis_list = loaded[0]["lists"][1]
        self.assertEqual(synthesis_list["stageType"], "synthesis")
        self.assertEqual(synthesis_list["synthesisText"], "# Systematic Literature Review\n\nComparative synthesis text...")
        self.assertEqual(synthesis_list["synthesisPrompt"], "Focus on deep learning architectures")

    def test_extract_data_endpoint(self):
        pdf_bytes = make_test_pdf()
        client = TestClient(backend.app)

        # Upload manuscript for paper-1
        client.post(
            "/api/papers/paper-1/manuscript",
            files={"file": ("study.pdf", pdf_bytes, "application/pdf")},
        )

        # Request extraction for paper-1 (has manuscript) and paper-999 (no manuscript)
        response = client.post(
            "/api/extract-data",
            json={
                "fields": [
                    {"name": "Architecture", "description": "Architecture used"},
                    {"name": "Data Modalities", "description": "Modality of data"},
                ],
                "papers": [
                    {"id": "paper-1", "title": "Test manuscript"},
                    {"id": "paper-999", "title": "Paper 999"},
                ],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIn("results", data)
        self.assertEqual(len(data["results"]), 2)

        # paper-1 has manuscript
        p1 = next(r for r in data["results"] if r["id"] == "paper-1")
        self.assertTrue(p1["has_manuscript"])
        self.assertIn("Architecture", p1["data"])
        self.assertIn("Data Modalities", p1["data"])

        # paper-999 has no manuscript
        p999 = next(r for r in data["results"] if r["id"] == "paper-999")
        self.assertFalse(p999["has_manuscript"])
        self.assertEqual(p999["data"], {})

    def test_synthesize_endpoint(self):
        client = TestClient(backend.app)
        response = client.post(
            "/api/synthesize",
            json={
                "papers": [
                    {
                        "id": "p1",
                        "title": "Quantum Attention Networks for Multi-Omics",
                        "authors": "Smith et al.",
                        "year": "2024",
                        "journal": "Nature Machine Intelligence",
                        "extractedData": {
                            "Architecture": "Quantum Variational Circuit",
                            "Data Modalities": "Transcriptomics and Proteomics"
                        }
                    },
                    {
                        "id": "p2",
                        "title": "Graph Convolution for Drug Synergy",
                        "authors": "Chen et al.",
                        "year": "2023",
                        "journal": "Bioinformatics",
                        "extractedData": {
                            "Architecture": "Dual GCN",
                            "Data Modalities": "PPI and Chemical Structures"
                        }
                    }
                ],
                "sourceStageName": "Stage 3 (Data Extraction)",
                "synthesisPrompt": "Focus on methodological differences"
            }
        )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIn("synthesis", data)
        self.assertTrue(len(data["synthesis"]) > 100)
        self.assertIn("Systematic Literature Review", data["synthesis"])
        self.assertIn("Smith et al.", data["synthesis"])

    def test_delete_project_endpoint(self):
        client = TestClient(backend.app)
        get_res = client.get("/api/projects")
        self.assertEqual(len(get_res.json()), 1)

        del_res = client.delete("/api/projects/project-1")
        self.assertEqual(del_res.status_code, 200)
        self.assertEqual(del_res.json(), {"status": "deleted", "id": "project-1"})

        get_res_after = client.get("/api/projects")
        self.assertEqual(len(get_res_after.json()), 0)

    def test_manual_section_mappings_endpoint(self):
        pdf_bytes = make_test_pdf()
        client = TestClient(backend.app)
        upload_res = client.post(
            "/api/papers/paper-1/manuscript",
            files={"file": ("study.pdf", pdf_bytes, "application/pdf")},
        )
        self.assertEqual(upload_res.status_code, 200)
        self.assertIn("document", upload_res.json())

        # Update section mappings manually: map "1.1. Study population" to "Methods"
        update_res = client.put(
            "/api/papers/paper-1/section-mappings",
            json={
                "mappings": [
                    {
                        "original_title": "1.1. Study population",
                        "page": 1,
                        "line": 3,
                        "standard_section": "Methods",
                        "is_excluded": False,
                    },
                ]
            },
        )
        self.assertEqual(update_res.status_code, 200, update_res.text)
        updated_doc = update_res.json()
        self.assertIn("mapped_sections", updated_doc)

        # Verify mapped section
        has_methods_mapping = any(
            m["standard_section"] == "Methods" and "Study population" in m["original_title"]
            for m in updated_doc.get("mapped_sections", [])
        )
        self.assertTrue(has_methods_mapping)

        # Verify get endpoint returns updated document
        get_res = client.get("/api/papers/paper-1/manuscript")
        self.assertEqual(get_res.status_code, 200)
        self.assertTrue(any(
            m["standard_section"] == "Methods" and "Study population" in m["original_title"]
            for m in get_res.json().get("mapped_sections", [])
        ))


if __name__ == "__main__":
    unittest.main()