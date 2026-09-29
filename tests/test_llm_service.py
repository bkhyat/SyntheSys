import json
import unittest
from unittest.mock import AsyncMock, patch

from backend.llm_service import (
    PaperInput,
    ScreeningInput,
    _extract_json_string,
    generate_dummy_summaries,
    generate_manuscript_summaries,
    get_llm_status,
    screen_papers_with_llm,
)
from backend.pdf_parser import extract_manuscript
from tests.test_pdf_parser import make_test_pdf


class LLMServiceTests(unittest.IsolatedAsyncioTestCase):
    def test_json_string_extractor(self):
        # 1. Plain json
        raw = '{"overall_summary": "Test", "section_summaries": []}'
        self.assertEqual(_extract_json_string(raw), raw)

        # 2. Markdown json code fence
        wrapped = f"```json\n{raw}\n```"
        self.assertEqual(_extract_json_string(wrapped), raw)

        # 3. Code fence without language tag
        wrapped_no_lang = f"```\n{raw}\n```"
        self.assertEqual(_extract_json_string(wrapped_no_lang), raw)

        # 4. JSON with leading and trailing text
        conversational = f"Here is your summary JSON:\n{raw}\nI hope this helps!"
        self.assertEqual(_extract_json_string(conversational), raw)

        # 5. Array JSON
        array_json = '[{"id": "p1", "score": 8, "rationale": "Relevant"}]'
        wrapped_array = f"```json\n{array_json}\n```"
        self.assertEqual(_extract_json_string(wrapped_array), array_json)

    def test_dummy_summaries_generation(self):
        pdf_bytes = make_test_pdf()
        document = extract_manuscript(pdf_bytes, "paper-1", "study.pdf")
        summarized = generate_dummy_summaries(document)

        self.assertIn("overall_summary", summarized)
        self.assertIsInstance(summarized["overall_summary"], str)
        self.assertTrue(len(summarized["overall_summary"]) > 20)

        # Check section summaries: Introduction has summary, References does not
        self.assertTrue(len(summarized["sections"]) > 0)
        intro = next(s for s in summarized["sections"] if "Introduction" in s["title"])
        self.assertIn("summary", intro)
        self.assertTrue(len(intro["summary"]) > 0)
        for child in intro.get("children", []):
            self.assertIn("summary", child)
            self.assertTrue(len(child["summary"]) > 0)

        references = next((s for s in summarized["sections"] if "References" in s["title"]), None)
        if references:
            self.assertNotIn("summary", references)

    async def test_generate_manuscript_summaries_fallback(self):
        pdf_bytes = make_test_pdf()
        document = extract_manuscript(pdf_bytes, "paper-1", "study.pdf")
        summarized = await generate_manuscript_summaries(document, api_key="", use_mock=True)

        self.assertIn("overall_summary", summarized)
        self.assertTrue(len(summarized["overall_summary"]) > 0)
        intro = next(s for s in summarized["sections"] if "Introduction" in s["title"])
        self.assertIn("summary", intro)
        self.assertTrue(len(intro["summary"]) > 0)

    @patch("backend.llm_service._call_gemini_json")
    async def test_generate_manuscript_summaries_via_gemini(self, mock_gemini_json):
        mock_gemini_json.return_value = json.dumps({
            "overall_summary": "Gemini generated overall summary for the manuscript.",
            "section_summaries": [
                {"id": "sec_0", "title": "Introduction", "summary": "Gemini summary of introduction."},
            ],
        })

        pdf_bytes = make_test_pdf()
        document = extract_manuscript(pdf_bytes, "paper-1", "study.pdf")

        with patch.dict("os.environ", {"GEMINI_API_KEY": "valid_mock_gemini_key", "LLM_PROVIDER": "auto"}):
            summarized = await generate_manuscript_summaries(document)

        self.assertEqual(summarized["overall_summary"], "Gemini generated overall summary for the manuscript.")
        intro = next(s for s in summarized["sections"] if "Introduction" in s["title"])
        self.assertEqual(intro["summary"], "Gemini summary of introduction.")
        mock_gemini_json.assert_called_once()

    @patch("backend.llm_service._call_gemini_json")
    async def test_screen_papers_with_gemini(self, mock_gemini_json):
        mock_gemini_json.return_value = json.dumps({
            "results": [
                {"id": "paper-1", "include": "Yes", "explanation": "High quality randomized trial on topic."},
                {"id": "paper-2", "include": "No", "explanation": "Animal study, clearly excluded."},
                {"id": "paper-3", "include": "Not Sure", "explanation": "Abstract lacks dosage details."},
            ]
        })

        screen_req = ScreeningInput(
            inclusionCriteria="Randomized controlled trials in adults",
            exclusionCriteria="Animal models",
            papers=[
                PaperInput(id="paper-1", title="RCT Study in Adults", abstract="Abstract 1"),
                PaperInput(id="paper-2", title="Mouse Study", abstract="Abstract 2"),
                PaperInput(id="paper-3", title="Pilot Study", abstract="Abstract 3"),
            ],
        )

        with patch.dict("os.environ", {"GEMINI_API_KEY": "valid_mock_gemini_key", "LLM_PROVIDER": "auto"}):
            results = await screen_papers_with_llm(screen_req)

        self.assertEqual(len(results), 3)
        self.assertEqual(results[0]["id"], "paper-1")
        self.assertEqual(results[0]["include"], "Yes")
        self.assertEqual(results[0]["decision"], "Yes")
        self.assertEqual(results[0]["explanation"], "High quality randomized trial on topic.")
        self.assertEqual(results[1]["id"], "paper-2")
        self.assertEqual(results[1]["include"], "No")
        self.assertEqual(results[1]["decision"], "No")
        self.assertEqual(results[1]["explanation"], "Animal study, clearly excluded.")
        self.assertEqual(results[2]["id"], "paper-3")
        self.assertEqual(results[2]["include"], "Not Sure")
        self.assertEqual(results[2]["decision"], "Not Sure")
        self.assertEqual(results[2]["explanation"], "Abstract lacks dosage details.")
        mock_gemini_json.assert_called_once()

    async def test_get_llm_status_structure(self):
        with patch.dict("os.environ", {"GEMINI_API_KEY": "valid_mock_gemini_key"}):
            status = await get_llm_status()
            self.assertEqual(status["active_provider"], "gemini")
            self.assertTrue(status["gemini"]["configured"])
            self.assertIn("model", status["gemini"])

    def test_unwanted_sections_are_not_summarized(self):
        from backend.llm_service import is_valid_summarizable_section, clean_unwanted_section_summaries

        unwanted = [
            "Acknowledgments",
            "5. Acknowledgements",
            "References",
            "VI. REFERENCES",
            "Conflict of Interest",
            "Declaration of Competing Interest",
            "Author Contributions",
            "Authors' Contributions",
            "Funding",
            "Financial Support",
            "Data Availability Statement",
            "Availability of data and materials",
            "Supplementary Material",
            "Ethics Approval and Consent",
            "Abbreviations",
            "Keywords",
        ]
        for title in unwanted:
            self.assertFalse(
                is_valid_summarizable_section(title, text="Some random text in the section"),
                f"Expected '{title}' to be recognized as non-summarizable",
            )

        valid = [
            "1. Introduction",
            "2. Materials and methods",
            "2.1 Data Collection",
            "3. Results",
            "4. Discussion",
            "IV. CONCLUSION",
            "Theoretical Framework",
        ]
        for title in valid:
            self.assertTrue(
                is_valid_summarizable_section(title, text="Substantive scientific findings and discussion details here."),
                f"Expected '{title}' to be recognized as summarizable",
            )

        # Test cleaning unwanted section summaries
        test_sections = [
            {"title": "1. Introduction", "summary": "Valid intro summary"},
            {"title": "Acknowledgments", "summary": "Should be removed"},
            {"title": "References", "summary": "Should also be removed"},
        ]
        clean_unwanted_section_summaries(test_sections)
        self.assertEqual(test_sections[0].get("summary"), "Valid intro summary")
        self.assertNotIn("summary", test_sections[1])
        self.assertNotIn("summary", test_sections[2])

    @patch("backend.llm_service._call_gemini_json")
    async def test_extract_paper_data_with_gemini(self, mock_gemini_json):
        from backend.llm_service import FieldDefinition, extract_paper_data_with_llm

        mock_gemini_json.return_value = json.dumps([
            {
                "field": "Architecture",
                "value": "Transformer with 12 layers and self-attention",
            },
            {
                "field": "Data Modalities",
                "value": "Text and image modalities (multimodal)",
            },
        ])

        fields = [
            FieldDefinition(name="Architecture", description="Architecture of downstream model"),
            FieldDefinition(name="Data Modalities", description="The modality of data used by the authors"),
        ]

        dummy_manuscript = {
            "file_name": "multimodal.pdf",
            "pages": [
                {
                    "page_number": 1,
                    "lines": [
                        {"line_number": 1, "text": "We use a 12-layer Transformer architecture on text and image data."}
                    ]
                }
            ]
        }

        with patch.dict("os.environ", {"GEMINI_API_KEY": "valid_mock_gemini_key", "LLM_PROVIDER": "auto"}):
            data = await extract_paper_data_with_llm("paper-1", "Multimodal Study", dummy_manuscript, fields)

        self.assertIn("Architecture", data)
        self.assertIsInstance(data["Architecture"], str)
        self.assertEqual(data["Architecture"], "Transformer with 12 layers and self-attention")
        self.assertEqual(data["Data Modalities"], "Text and image modalities (multimodal)")
        mock_gemini_json.assert_called_once()

    async def test_extract_batch_data_mock_fallback(self):
        from backend.llm_service import FieldDefinition, extract_batch_data_with_llm

        fields = [
            FieldDefinition(name="Architecture", description="Architecture of downstream model"),
            FieldDefinition(name="Sample Size", description="Number of samples"),
        ]

        papers_payload = [
            {
                "id": "paper-1",
                "title": "Deep Learning in Biology",
                "manuscript": {
                    "file_name": "bio.pdf",
                    "pages": [
                        {"lines": [{"text": "In this paper we evaluated 500 samples using a CNN Architecture."}]}
                    ]
                }
            },
            {
                "id": "paper-2",
                "title": "No manuscript paper",
                "manuscript": None,
            }
        ]

        with patch.dict("os.environ", {"LLM_PROVIDER": "mock"}):
            results = await extract_batch_data_with_llm(papers_payload, fields)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["id"], "paper-1")
        self.assertTrue(results[0]["has_manuscript"])
        self.assertIn("Architecture", results[0]["data"])
        self.assertIsInstance(results[0]["data"]["Architecture"], str)

        self.assertEqual(results[1]["id"], "paper-2")
        self.assertFalse(results[1]["has_manuscript"])
        self.assertEqual(results[1]["data"], {})

    @patch("backend.llm_service._call_gemini_text")
    async def test_synthesize_papers_with_gemini(self, mock_gemini_text):
        from backend.llm_service import SynthesisPaperItem, SynthesisRequest, synthesize_papers_with_llm

        mock_gemini_text.return_value = "# Systematic Literature Review Synthesis\n\n## 1. Executive Summary\nSynthesizing 2 papers."

        req = SynthesisRequest(
            papers=[
                SynthesisPaperItem(
                    id="p1",
                    title="Quantum Deep Learning",
                    authors="Smith et al.",
                    year="2024",
                    extractedData={"Architecture": "Quantum Circuit"}
                ),
                SynthesisPaperItem(
                    id="p2",
                    title="Graph Attention Networks",
                    authors="Chen et al.",
                    year="2023",
                    extractedData={"Architecture": "GAT"}
                ),
            ],
            sourceStageName="Stage 3 (Data Extraction)",
            synthesisPrompt="Focus on computational complexity"
        )

        with patch.dict("os.environ", {"GEMINI_API_KEY": "valid_mock_gemini_key", "LLM_PROVIDER": "auto"}):
            synthesis = await synthesize_papers_with_llm(req)

        self.assertIn("Systematic Literature Review Synthesis", synthesis)
        mock_gemini_text.assert_called_once()

    async def test_synthesize_papers_mock_fallback(self):
        from backend.llm_service import SynthesisPaperItem, SynthesisRequest, synthesize_papers_with_llm

        req = SynthesisRequest(
            papers=[
                SynthesisPaperItem(
                    id="p1",
                    title="Quantum Deep Learning",
                    authors="Smith et al.",
                    year="2024",
                    extractedData={"Architecture": "Quantum Circuit"}
                )
            ],
            sourceStageName="Stage 3",
        )

        with patch.dict("os.environ", {"LLM_PROVIDER": "mock"}):
            synthesis = await synthesize_papers_with_llm(req)

        self.assertIn("# Systematic Literature Review Synthesis", synthesis)
        self.assertIn("Smith et al.", synthesis)


if __name__ == "__main__":
    unittest.main()

