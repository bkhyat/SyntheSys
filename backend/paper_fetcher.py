"""
backend/paper_fetcher.py

Automated full-text scientific manuscript retriever.
Queries open access repositories (Unpaywall, Europe PMC / PubMed Central, OpenAlex, Semantic Scholar, arXiv, bioRxiv/medRxiv)
using DOI, PubMed ID, arXiv ID, or title, downloads the PDF, and parses the structured document for SyntheSys.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any

import httpx

from backend import database
from backend.pdf_parser import extract_manuscript

logger = logging.getLogger("synthesys.paper_fetcher")

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36 SyntheSys-LiteratureReview/1.0 (mailto:fieldnote-research@synthesys.io)"
)
DEFAULT_CONTACT_EMAIL = "fieldnote-research@synthesys.io"
REQUEST_TIMEOUT = 25.0


def extract_doi(doi_or_url_or_text: str | None) -> str | None:
    """Extract and sanitize standard DOI from raw DOI string, URL, or mixed text."""
    if not doi_or_url_or_text:
        return None
    text = urllib.parse.unquote(str(doi_or_url_or_text).strip())
    match = re.search(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", text)
    if match:
        doi = match.group(0).rstrip(".,;)>] ")
        return doi.strip()
    return None


def extract_pmid_and_pmcid(text: str | None) -> tuple[str | None, str | None]:
    """Extract PMID or PMCID from URL or identifier string."""
    if not text:
        return None, None
    s = str(text).strip()
    pmcid = None
    pmid = None
    pmc_match = re.search(r"\bPMC\d+\b", s, re.IGNORECASE)
    if pmc_match:
        pmcid = pmc_match.group(0).upper()
    pmid_match = re.search(r"(?:pubmed\.ncbi\.nlm\.nih\.gov/|pmid:?\s*)(\d+)", s, re.IGNORECASE)
    if pmid_match:
        pmid = pmid_match.group(1)
    return pmid, pmcid


def extract_arxiv_id(text: str | None) -> str | None:
    """Extract arXiv ID from URL, DOI, or text."""
    if not text:
        return None
    s = str(text).strip()
    arxiv_match = re.search(
        r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:\s*|10\.48550/arXiv\.)(\d{4}\.\d{4,5}(?:v\d+)?)",
        s,
        re.IGNORECASE,
    )
    if arxiv_match:
        return arxiv_match.group(1)
    if re.match(r"^\d{4}\.\d{4,5}(?:v\d+)?$", s):
        return s
    return None


def sanitize_filename(title: str | None, paper_id: str) -> str:
    """Generate safe, clean PDF filename based on title or paper ID."""
    if not title:
        return f"paper_{paper_id[:8]}.pdf"
    clean = re.sub(r"[^A-Za-z0-9_\-\s]", "", title)
    clean = re.sub(r"\s+", "_", clean).strip("_")
    truncated = clean[:60] or f"paper_{paper_id[:8]}"
    return f"{truncated}.pdf"


async def query_unpaywall(
    doi: str,
    email: str,
    client: httpx.AsyncClient,
) -> list[tuple[str, str]]:
    """Query Unpaywall API for open access PDF locations."""
    candidates: list[tuple[str, str]] = []
    try:
        url = f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi)}?email={urllib.parse.quote(email)}"
        resp = await client.get(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("is_oa"):
                best = data.get("best_oa_location")
                if best and best.get("url_for_pdf"):
                    candidates.append((best["url_for_pdf"], "Unpaywall (Open Access)"))
                for loc in data.get("oa_locations", []):
                    pdf_url = loc.get("url_for_pdf")
                    if pdf_url and pdf_url != (best.get("url_for_pdf") if best else None):
                        host = loc.get("host_type", "repo")
                        candidates.append((pdf_url, f"Unpaywall ({host})"))
    except Exception as exc:
        logger.debug("Unpaywall query failed for DOI %s: %s", doi, exc)
    return candidates


async def query_europe_pmc(
    doi: str | None,
    pmid: str | None,
    pmcid: str | None,
    title: str | None,
    client: httpx.AsyncClient,
) -> list[tuple[str, str]]:
    """Query Europe PMC / PubMed Central for open access PDFs."""
    candidates: list[tuple[str, str]] = []

    # If PMCID already known, construct direct download links immediately
    if pmcid:
        candidates.append((
            f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf",
            f"Europe PMC ({pmcid})",
        ))
        candidates.append((
            f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/pdf/",
            f"PubMed Central ({pmcid})",
        ))

    query = ""
    if doi:
        query = f'DOI:"{doi}"'
    elif pmid:
        query = f"EXT_ID:{pmid} AND SRC:MED"
    elif title and len(title.strip()) > 10:
        clean_title = re.sub(r'["\\]', '', title.strip())
        query = f'TITLE:"{clean_title}"'

    if not query:
        return candidates

    try:
        url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={urllib.parse.quote(query)}&format=json&resultType=core"
        resp = await client.get(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            results = data.get("resultList", {}).get("result", [])
            if results:
                res = results[0]
                found_pmcid = res.get("pmcid")
                if found_pmcid and found_pmcid != pmcid:
                    candidates.append((
                        f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={found_pmcid}&blobtype=pdf",
                        f"Europe PMC ({found_pmcid})",
                    ))
                    candidates.append((
                        f"https://www.ncbi.nlm.nih.gov/pmc/articles/{found_pmcid}/pdf/",
                        f"PubMed Central ({found_pmcid})",
                    ))
                url_list = res.get("fullTextUrlList", {}).get("fullTextUrl", [])
                for u_item in url_list:
                    if u_item.get("documentStyle") == "pdf" and u_item.get("url"):
                        candidates.append((u_item["url"], f"Europe PMC ({u_item.get('site', 'OA')})"))
    except Exception as exc:
        logger.debug("Europe PMC query failed for query %s: %s", query, exc)
    return candidates


async def query_openalex(
    doi: str | None,
    email: str,
    client: httpx.AsyncClient,
) -> list[tuple[str, str]]:
    """Query OpenAlex API for open access PDF links."""
    candidates: list[tuple[str, str]] = []
    if not doi:
        return candidates
    try:
        headers = {"User-Agent": f"SyntheSys/1.0 (mailto:{email})"}
        url = f"https://api.openalex.org/works/https://doi.org/{urllib.parse.quote(doi)}"
        resp = await client.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            best = data.get("best_oa_location") or {}
            if best.get("pdf_url"):
                candidates.append((best["pdf_url"], "OpenAlex (Best OA)"))
            primary = data.get("primary_location") or {}
            if primary.get("pdf_url") and primary.get("pdf_url") != best.get("pdf_url"):
                candidates.append((primary["pdf_url"], "OpenAlex (Primary OA)"))
            for loc in data.get("locations", []):
                p_url = loc.get("pdf_url")
                if p_url and p_url not in [c[0] for c in candidates]:
                    candidates.append((p_url, "OpenAlex (Repository OA)"))
    except Exception as exc:
        logger.debug("OpenAlex query failed for DOI %s: %s", doi, exc)
    return candidates


async def query_semanticscholar(
    doi: str | None,
    title: str | None,
    api_key: str | None,
    client: httpx.AsyncClient,
) -> list[tuple[str, str]]:
    """Query Semantic Scholar Graph API for open access PDF links."""
    candidates: list[tuple[str, str]] = []
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key

    try:
        if doi:
            url = f"https://api.semanticscholar.org/graph/v1/paper/DOI:{urllib.parse.quote(doi)}?fields=openAccessPdf,externalIds,title"
            resp = await client.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                data = resp.json()
                oa_pdf = data.get("openAccessPdf")
                if oa_pdf and oa_pdf.get("url"):
                    candidates.append((oa_pdf["url"], "Semantic Scholar (Open Access)"))
                ext = data.get("externalIds") or {}
                if ext.get("PubMedCentral"):
                    pmc = f"PMC{ext['PubMedCentral']}"
                    candidates.append((
                        f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmc}&blobtype=pdf",
                        f"Semantic Scholar -> PMC ({pmc})",
                    ))
                if ext.get("ArXiv"):
                    candidates.append((f"https://arxiv.org/pdf/{ext['ArXiv']}.pdf", "arXiv Preprint"))
        elif title and len(title.strip()) > 10:
            url = f"https://api.semanticscholar.org/graph/v1/paper/search?query={urllib.parse.quote(title)}&limit=1&fields=openAccessPdf,externalIds,title"
            resp = await client.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                data = resp.json()
                papers = data.get("data", [])
                if papers:
                    p = papers[0]
                    oa_pdf = p.get("openAccessPdf")
                    if oa_pdf and oa_pdf.get("url"):
                        candidates.append((oa_pdf["url"], "Semantic Scholar (Search OA)"))
    except Exception as exc:
        logger.debug("Semantic Scholar query failed: %s", exc)
    return candidates


async def download_valid_pdf(
    candidate_urls: list[tuple[str, str]],
    client: httpx.AsyncClient,
) -> tuple[bytes | None, str | None, str | None]:
    """
    Attempt to download PDF bytes from candidate URLs in order.
    Returns (pdf_bytes, provider_label, source_url) upon first valid PDF.
    """
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "application/pdf,application/octet-stream,text/html;q=0.1,*/*;q=0.8",
    }
    seen_urls: set[str] = set()

    for url, label in candidate_urls:
        clean_url = url.strip()
        if not clean_url or clean_url in seen_urls:
            continue
        seen_urls.add(clean_url)

        try:
            resp = await client.get(clean_url, headers=headers, follow_redirects=True, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200 and resp.content:
                content = resp.content
                # Check for standard PDF header %PDF-
                if content.startswith(b"%PDF-") and len(content) > 1000:
                    return content, label, clean_url

                # Check if PDF header is offset by leading bytes/BOM
                pdf_idx = content[:2048].find(b"%PDF-")
                if pdf_idx != -1 and len(content) - pdf_idx > 1000:
                    return content[pdf_idx:], label, clean_url
        except Exception as exc:
            logger.debug("Failed download from %s (%s): %s", clean_url, label, exc)

    return None, None, None


async def fetch_paper_pdf(
    paper: dict[str, Any],
    email: str | None = None,
) -> dict[str, Any]:
    """
    Given paper metadata (id, title, doi, url, authors, etc.), discover candidate OA PDF URLs
    and download the actual manuscript PDF.
    """
    paper_id = str(paper.get("id", "")).strip()
    title = str(paper.get("title", "")).strip()
    raw_doi = paper.get("doi") or ""
    raw_url = paper.get("url") or ""

    clean_doi = extract_doi(raw_doi) or extract_doi(raw_url) or extract_doi(title)
    pmid, pmcid = extract_pmid_and_pmcid(f"{raw_url} {raw_doi}")
    arxiv_id = extract_arxiv_id(raw_doi) or extract_arxiv_id(raw_url) or extract_arxiv_id(title)

    contact_email = (
        email
        or os.getenv("UNPAYWALL_EMAIL")
        or os.getenv("OPENALEX_EMAIL")
        or DEFAULT_CONTACT_EMAIL
    ).strip()
    s2_api_key = os.getenv("SEMANTIC_SCHOLAR_API_KEY", "").strip() or None

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
        # Build candidate list across providers
        candidates: list[tuple[str, str]] = []

        # 1. arXiv direct if ID available
        if arxiv_id:
            candidates.append((f"https://arxiv.org/pdf/{arxiv_id}.pdf", f"arXiv ({arxiv_id})"))

        # 2. bioRxiv / medRxiv direct if CSH DOI
        if clean_doi and clean_doi.startswith("10.1101/"):
            candidates.append((f"https://www.biorxiv.org/content/{clean_doi}.full.pdf", "bioRxiv Direct"))
            candidates.append((f"https://www.medrxiv.org/content/{clean_doi}.full.pdf", "medRxiv Direct"))

        # 3. Query open access APIs concurrently
        tasks = []
        if clean_doi:
            tasks.append(query_unpaywall(clean_doi, contact_email, client))
            tasks.append(query_openalex(clean_doi, contact_email, client))
        tasks.append(query_europe_pmc(clean_doi, pmid, pmcid, title, client))
        tasks.append(query_semanticscholar(clean_doi, title, s2_api_key, client))

        api_results = await asyncio.gather(*tasks, return_exceptions=True)
        for res in api_results:
            if isinstance(res, list):
                candidates.extend(res)

        if not candidates:
            return {
                "id": paper_id,
                "success": False,
                "error": "No open access locations found. (Paper may be behind publisher paywall or missing DOI/PMID).",
                "doi": clean_doi,
                "title": title,
            }

        # Attempt downloading PDF
        pdf_bytes, provider_label, source_url = await download_valid_pdf(candidates, client)

        if pdf_bytes:
            filename = sanitize_filename(title, paper_id)
            return {
                "id": paper_id,
                "success": True,
                "pdf_bytes": pdf_bytes,
                "file_name": filename,
                "source": provider_label,
                "url": source_url,
                "doi": clean_doi,
                "title": title,
            }
        else:
            return {
                "id": paper_id,
                "success": False,
                "error": f"Open access links identified ({len(candidates)} candidates), but PDF downloads returned paywalls or landing pages.",
                "doi": clean_doi,
                "title": title,
            }


async def fetch_and_store_paper_manuscript(
    paper: dict[str, Any],
    email: str | None = None,
) -> dict[str, Any]:
    """
    Fetch open-access PDF for a paper, parse sections with extract_manuscript,
    and persist into SQLite database.
    """
    paper_id = str(paper.get("id", "")).strip()
    title = str(paper.get("title", "")).strip()

    fetch_res = await fetch_paper_pdf(paper, email=email)
    if not fetch_res.get("success"):
        return {
            "id": paper_id,
            "title": title,
            "success": False,
            "error": fetch_res.get("error", "Could not retrieve full text."),
            "doi": fetch_res.get("doi"),
        }

    pdf_bytes: bytes = fetch_res["pdf_bytes"]
    file_name: str = fetch_res["file_name"]
    source: str = fetch_res["source"]
    source_url: str = fetch_res["url"]

    # Parse manuscript document structure
    try:
        document = await asyncio.to_thread(extract_manuscript, pdf_bytes, paper_id, file_name)
    except Exception as exc:
        logger.warning("PDF extraction failed for paper %s: %s", paper_id, exc)
        return {
            "id": paper_id,
            "title": title,
            "success": False,
            "error": f"Downloaded PDF from {source} but text extraction failed: {exc}",
        }

    extracted_at = datetime.now(timezone.utc).isoformat()
    document["extracted_at"] = extracted_at

    # Render figure previews if possible
    previews = []
    try:
        from backend.main import _render_figure_previews
        previews = await asyncio.to_thread(_render_figure_previews, document, pdf_bytes)
    except Exception:
        previews = []

    # Persist in DB
    await asyncio.to_thread(database.save_manuscript, document, pdf_bytes, previews)

    return {
        "id": paper_id,
        "title": title,
        "success": True,
        "source": source,
        "sourceUrl": source_url,
        "fileName": file_name,
        "pageCount": document["page_count"],
        "lineCount": document["line_count"],
        "warnings": document["warnings"],
        "document": document,
    }


async def batch_fetch_manuscripts(
    papers: list[dict[str, Any]],
    max_concurrency: int = 4,
    email: str | None = None,
) -> dict[str, Any]:
    """
    Fetch and persist full text manuscripts for a batch of papers with controlled concurrency.
    """
    semaphore = asyncio.Semaphore(max_concurrency)

    async def _fetch_worker(paper: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await fetch_and_store_paper_manuscript(paper, email=email)

    tasks = [_fetch_worker(p) for p in papers]
    results = await asyncio.gather(*tasks, return_exceptions=False)

    succeeded = [r for r in results if r.get("success")]
    failed = [r for r in results if not r.get("success")]

    return {
        "total": len(papers),
        "succeededCount": len(succeeded),
        "failedCount": len(failed),
        "results": results,
    }
