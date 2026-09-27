import unittest

from backend.pdf_parser import extract_manuscript


def make_test_pdf() -> bytes:
    commands = []

    def text(x: int, y: int, size: int, value: str) -> None:
        escaped = value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        commands.append(f"BT /F1 {size} Tf {x} {y} Td ({escaped}) Tj ET")

    text(72, 745, 18, "A Mixed Column Study")
    text(72, 700, 14, "1. Introduction")
    text(72, 675, 12, "1.1. Study population")
    text(72, 655, 10, "Left column content starts here.")
    text(72, 639, 10, "A second line in the left column.")
    text(305, 655, 10, "Right column content starts here.")
    text(305, 639, 10, "It should remain tied to page one.")
    text(72, 600, 10, "Table 1. Study characteristics")
    for x in (72, 190, 310):
        commands.append(f"{x} 520 m {x} 570 l S")
    for y in (520, 545, 570):
        commands.append(f"72 {y} m 310 {y} l S")
    text(80, 552, 9, "Group")
    text(200, 552, 9, "N")
    text(80, 528, 9, "Control")
    text(200, 528, 9, "24")
    text(72, 470, 10, "Figure 1. Screening flow diagram")
    text(72, 300, 14, "References")
    text(72, 275, 9, "[1] Smith A. Example study. 2024.")

    content = "\n".join(commands).encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return bytes(pdf)


class ManuscriptParserTests(unittest.TestCase):
    def test_extracts_columns_sections_captions_tables_and_references(self):
        result = extract_manuscript(make_test_pdf(), "paper-1", "study.pdf")

        self.assertEqual(result["page_count"], 1)
        introduction = next(section for section in result["sections"] if section["title"] == "1. Introduction")
        self.assertEqual(introduction["children"][0]["title"], "1.1. Study population")
        self.assertEqual(result["figures"][0]["label"], "Figure 1")
        self.assertEqual(result["figures"][0]["caption"], "Screening flow diagram")
        self.assertEqual(result["tables"][0]["caption"], "Study characteristics")
        self.assertEqual(result["tables"][0]["cells"], [["Group", "N"], ["Control", "24"]])
        self.assertEqual(result["references"][0]["label"], "1")
        left_index = next(index for index, line in enumerate(result["pages"][0]["lines"]) if line["text"].startswith("Left column"))
        right_index = next(index for index, line in enumerate(result["pages"][0]["lines"]) if line["text"].startswith("Right column"))
        self.assertEqual(result["pages"][0]["lines"][left_index]["text"], "Left column content starts here.")
        self.assertEqual(result["pages"][0]["lines"][right_index]["text"], "Right column content starts here.")
        self.assertLess(left_index, right_index)
        citation = result["references"][0]["line_refs"][0]
        cited_line = result["pages"][citation["page_number"] - 1]["lines"][citation["line_number"] - 1]
        self.assertEqual(cited_line["text"], "[1] Smith A. Example study. 2024.")
        self.assertIn("x0", cited_line["bbox"])

    def test_unpack_multiline_table(self):
        from backend.pdf_parser import _unpack_multiline_table
        collapsed = [
            ["Header A", "Header B"],
            ["Row 1 Col A\nRow 2 Col A", "Row 1 Col B\nRow 2 Col B"],
        ]
        unpacked = _unpack_multiline_table(collapsed)
        self.assertEqual(len(unpacked), 3)
        self.assertEqual(unpacked[0], ["Header A", "Header B"])
        self.assertEqual(unpacked[1], ["Row 1 Col A", "Row 1 Col B"])
        self.assertEqual(unpacked[2], ["Row 2 Col A", "Row 2 Col B"])


if __name__ == "__main__":
    unittest.main()