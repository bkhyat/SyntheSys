import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import backend.main as backend
from backend import database
from backend.paper_fetcher import (
    extract_arxiv_id,
    extract_doi,
    extract_pmid_and_pmcid,
    fetch_and_store_paper_manuscript,
    fetch_paper_pdf,
    sanitize_filename,
)
from tests.test_pdf_parser import make_test_pdf


class PaperFetcherTests(unittest.IsolatedAsyncioTestCase):
    def test_extract_doi(self):
        self.assertEqual(extract_doi("10.1038/s41586-020-2649-2"), "10.1038/s41586-020-2649-2")
        self.assertEqual(extract_doi("https://doi.org/10.1016/j.cell.2021.05.001"), "10.1016/j.cell.2021.05.001")
        self.assertEqual(extract_doi("doi: 10.1371/journal.pone.0289123."), "10.1371/journal.pone.0289123")
        self.assertEqual(extract_doi("http://dx.doi.org/10.1101%2F2023.01.01.123456"), "10.1101/2023.01.01.123456")
        self.assertIsNone(extract_doi("No DOI here"))

    def test_extract_pmid_and_pmcid(self):
        pmid, pmcid = extract_pmid_and_pmcid("https://pubmed.ncbi.nlm.nih.gov/37258671/ and PMC8123456")
        self.assertEqual(pmid, "37258671")
        self.assertEqual(pmcid, "PMC8123456")

        pmid2, pmcid2 = extract_pmid_and_pmcid("PMID: 12345678")
        self.assertEqual(pmid2, "12345678")
        self.assertIsNone(pmcid2)

    def test_extract_arxiv_id(self):
        self.assertEqual(extract_arxiv_id("https://arxiv.org/abs/1706.03762"), "1706.03762")
        self.assertEqual(extract_arxiv_id("arXiv:2305.12345v2"), "2305.12345v2")
        self.assertEqual(extract_arxiv_id("10.48550/arXiv.2104.08653"), "2104.08653")
        self.assertEqual(extract_arxiv_id("2305.12345"), "2305.12345")
        self.assertIsNone(extract_arxiv_id("random title"))

    def test_sanitize_filename(self):
        self.assertEqual(
            sanitize_filename("A Deep Learning Approach to Cancer: Review & Insights?", "paper-1"),
            "A_Deep_Learning_Approach_to_Cancer_Review_Insights.pdf",
        )
        self.assertEqual(sanitize_filename("", "p123456789"), "paper_p1234567.pdf")

    @patch("backend.paper_fetcher.download_valid_pdf")
    @patch("backend.paper_fetcher.query_unpaywall")
    async def test_fetch_paper_pdf_via_unpaywall(self, mock_unpaywall, mock_download):
        pdf_bytes = make_test_pdf()
        mock_unpaywall.return_value = [("https://example.com/paper.pdf", "Unpaywall (Open Access)")]
        mock_download.return_value = (pdf_bytes, "Unpaywall (Open Access)", "https://example.com/paper.pdf")

        paper = {
            "id": "p1",
            "title": "Open Access Trial",
            "doi": "10.1371/journal.pone.0289123",
        }

        res = await fetch_paper_pdf(paper)
        self.assertTrue(res["success"])
        self.assertEqual(res["source"], "Unpaywall (Open Access)")
        self.assertEqual(res["pdf_bytes"], pdf_bytes)

    @patch("backend.paper_fetcher.download_valid_pdf")
    async def test_fetch_paper_pdf_not_found(self, mock_download):
        mock_download.return_value = (None, None, None)
        paper = {
            "id": "p2",
            "title": "Closed Paywalled Paper",
            "doi": "10.1000/closed.access",
        }

        res = await fetch_paper_pdf(paper)
        self.assertFalse(res["success"])
        self.assertIn("error", res)


class PaperFetcherApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.db_patch = patch.object(database, "DATABASE_PATH", root / "fieldnote.sqlite3")
        self.ms_patch = patch.object(backend, "MANUSCRIPT_ROOT", root / "manuscripts")
        self.db_patch.start()
        self.ms_patch.start()
        database.initialize_database()
        database.replace_projects([{
            "id": "project-1",
            "name": "Test project",
            "createdAt": "2026-09-26T00:00:00Z",
            "lists": [{
                "id": "list-1",
                "name": "List 1",
                "minScore": 9,
                "papers": [
                    {"id": "paper-1", "title": "Transformer Study", "doi": "10.48550/arXiv.1706.03762", "abstract": "Abstract."},
                    {"id": "paper-2", "title": "Paywalled Paper", "doi": "10.1000/paywalled", "abstract": "Abstract."},
                ],
            }],
        }])

    def tearDown(self):
        self.ms_patch.stop()
        self.db_patch.stop()
        self.temp_dir.cleanup()

    @patch("backend.paper_fetcher.fetch_paper_pdf")
    def test_batch_fetch_manuscripts_endpoint(self, mock_fetch_pdf):
        pdf_bytes = make_test_pdf()

        async def _mock_fetch(paper, email=None):
            if paper["id"] == "paper-1":
                return {
                    "id": "paper-1",
                    "success": True,
                    "pdf_bytes": pdf_bytes,
                    "file_name": "transformer.pdf",
                    "source": "arXiv Preprint",
                    "url": "https://arxiv.org/pdf/1706.03762.pdf",
                    "doi": "10.48550/arXiv.1706.03762",
                    "title": paper.get("title", ""),
                }
            else:
                return {
                    "id": "paper-2",
                    "success": False,
                    "error": "No open access PDF found.",
                    "doi": "10.1000/paywalled",
                    "title": paper.get("title", ""),
                }

        mock_fetch_pdf.side_effect = _mock_fetch

        client = TestClient(backend.app)
        response = client.post(
            "/api/papers/batch-fetch-manuscripts",
            json={
                "papers": [
                    {"id": "paper-1", "title": "Transformer Study", "doi": "10.48550/arXiv.1706.03762"},
                    {"id": "paper-2", "title": "Paywalled Paper", "doi": "10.1000/paywalled"},
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["succeededCount"], 1)
        self.assertEqual(data["failedCount"], 1)

        # Check that paper-1 now has a stored manuscript in DB
        doc = database.get_manuscript("paper-1")
        self.assertIsNotNone(doc)
        self.assertEqual(doc["paper_id"], "paper-1")

        # Now do a second batch request with paper-1; mock_fetch_pdf should NOT be called for paper-1
        mock_fetch_pdf.reset_mock()
        response2 = client.post(
            "/api/papers/batch-fetch-manuscripts",
            json={
                "skipExisting": True,
                "papers": [
                    {"id": "paper-1", "title": "Transformer Study", "doi": "10.48550/arXiv.1706.03762"},
                ]
            },
        )
        self.assertEqual(response2.status_code, 200)
        data2 = response2.json()
        self.assertEqual(data2["alreadyExistsCount"], 1)
        mock_fetch_pdf.assert_not_called()
