import { useEffect, useState } from 'react'
import { ChevronRight, ExternalLink, FileText, Image, LoaderCircle, Maximize2, Sparkles, Table2, X } from 'lucide-react'
import './ManuscriptPanel.css'
import type { ManuscriptMetadata } from './types'

type LineReference = { page_number: number; line_number: number }
type BoundingBox = { x0: number; top: number; x1: number; bottom: number }
type DocumentLine = { page_number: number; line_number: number; text: string; bbox: BoundingBox; font_size: number }
type Section = {
  title: string; level: number; start_page: number; end_page: number
  start_line: number; line_refs: LineReference[]; children: Section[]
  summary?: string
}
type Figure = { label: string; caption: string; page_number: number; line_refs: LineReference[]; image_bbox?: BoundingBox }
type Table = {
  label: string; caption: string | null; page_number: number; bbox: BoundingBox
  line_refs: LineReference[]; cells: (string | null)[][]
}
type Reference = { label: string; text: string; page_number: number; line_refs: LineReference[] }
type ManuscriptDocument = {
  file_name: string; page_count: number; line_count: number; extracted_at: string
  overall_summary?: string
  sections: Section[]; pages: { page_number: number; width: number; height: number; lines: DocumentLine[] }[]
  figures: Figure[]; tables: Table[]; references: Reference[]; warnings: string[]
}

type ExtractedFieldValue = string | { value?: string }

type Props = {
  paper: {
    id: string
    title: string
    manuscript: ManuscriptMetadata
    extractedData?: Record<string, ExtractedFieldValue>
  }
  onClose: () => void
}

type Tab = 'outline' | 'extracted' | 'figures' | 'tables' | 'references' | 'pages'

function pdfPageUrl(paperId: string, pageNumber: number) {
  return `/api/papers/${encodeURIComponent(paperId)}/manuscript.pdf#page=${pageNumber}`
}

function PageCitation({ paperId, page, line, lineEnd }: { paperId: string; page: number; line?: number; lineEnd?: number }) {
  return <a className="document-citation" href={pdfPageUrl(paperId, page)} target="_blank" rel="noreferrer">
    Open PDF · p. {page}{line ? ` · L${line}${lineEnd && lineEnd !== line ? `–${lineEnd}` : ''}` : ''} <ExternalLink size={11} />
  </a>
}

function FigurePreview({ paperId, index, label, caption }: { paperId: string; index: number; label: string; caption: string }) {
  const [failed, setFailed] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const imageUrl = `/api/papers/${encodeURIComponent(paperId)}/figures/${index}.png`

  useEffect(() => {
    if (!lightboxOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [lightboxOpen])

  if (failed) return <div className="figure-preview-unavailable">Figure preview unavailable. Open the PDF at its cited location.</div>

  return (
    <>
      <div
        className="figure-preview-container"
        onClick={() => setLightboxOpen(true)}
        title="Click to inspect high-resolution figure"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setLightboxOpen(true) }}
      >
        <img
          className="figure-preview"
          src={imageUrl}
          alt={`${label}: ${caption}`}
          loading="lazy"
          onError={() => setFailed(true)}
        />
        <div className="figure-preview-overlay">
          <span className="figure-preview-badge"><Maximize2 size={11} /> High-Res Preview</span>
        </div>
      </div>

      {lightboxOpen && (
        <div className="figure-lightbox-backdrop" onClick={() => setLightboxOpen(false)}>
          <div className="figure-lightbox-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="figure-lightbox-header">
              <div className="figure-lightbox-title">
                <strong>{label}</strong>
                {caption && <span className="figure-lightbox-caption">{caption}</span>}
              </div>
              <div className="figure-lightbox-actions">
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="figure-lightbox-btn"
                  title="Open original image in new tab"
                >
                  <ExternalLink size={12} /> Open in Tab
                </a>
                <button
                  type="button"
                  className="figure-lightbox-close"
                  onClick={() => setLightboxOpen(false)}
                  title="Close (Esc)"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div className="figure-lightbox-body">
              <img
                src={imageUrl}
                alt={`${label}: ${caption}`}
                className="figure-lightbox-img"
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function isUnwantedSectionSummary(title: string): boolean {
  const normalized = title.trim().replace(/^(?:section\s+)?(?:[0-9]+(?:\.[0-9]+)*|[a-z]|[ivxldm]+)[\.\:\-\–\s]+\s*/i, '').trim()
  return /^(acknowledg(e)?ments?|references?|bibliograph(y|ies)|(literature|works|citations?)\s+cited|author(s)?['’s]*\s+(contributions?|information|details|affiliations?|notes?)|credit(\s+authorship)?\s+contribution|(conflict|conflicts|competing)\s+(of\s+)?interests?|declaration(s)?\s+of\s+(competing\s+)?interests?|disclosures?|(financial\s+)?funding|(financial|grant)\s+(support|disclosure)|(data|code|software)(\s+and\s+(code|data|materials?))?\s+availability|availability\s+of\s+(data|materials?|supporting\s+data)|(ethics|ethical)(\s+approval|\s+statement|\s+considerations?)|(patient\s+|informed\s+)?consent|(institutional\s+review\s+board|irb)|(supplementary|supplemental|supporting)\s+(materials?|information|files?|data)|abbreviations?|acronyms?|glossary|nomenclature|keywords?|index\s+terms?|publisher['’]?s\s+note|disclaimer|copyright|license|about\s+the\s+authors?|biograph(y|ies))(\b|:|$)/i.test(normalized)
}

function OutlineItems({ items, paperId, linesByReference, firstOpen = false }: {
  items: Section[]
  paperId: string
  linesByReference: Map<string, DocumentLine>
  firstOpen?: boolean
}) {
  return <ol className="outline-list">{items.map((section, index) => {
    const bodyLines = section.line_refs.slice(1)
      .map((reference) => linesByReference.get(`${reference.page_number}:${reference.line_number}`))
      .filter((line): line is DocumentLine => Boolean(line))
    const pageGroups = bodyLines.reduce<{ page: number; lines: DocumentLine[] }[]>((groups, line) => {
      const current = groups[groups.length - 1]
      if (current?.page === line.page_number) current.lines.push(line)
      else groups.push({ page: line.page_number, lines: [line] })
      return groups
    }, [])

    return <li key={`${section.start_page}-${section.start_line}-${index}`}>
      <details className="outline-node" open={firstOpen && index === 0}>
        <summary className="outline-item">
          <span className="outline-level">{String(section.level).padStart(2, '0')}</span>
          <span className="outline-title">{section.title}</span>
          <span className="outline-line-count">{bodyLines.length} lines</span>
        </summary>
        <div className="outline-section-body">
          {section.summary && !isUnwantedSectionSummary(section.title) && <div className="section-summary-box">
            <div className="section-summary-header">
              <Sparkles size={11} className="summary-sparkle" />
              <span>SECTION SUMMARY</span>
            </div>
            <p className="section-summary-text">{section.summary}</p>
          </div>}
          <div className="section-source-bar">
            <PageCitation paperId={paperId} page={section.start_page} line={section.start_line} />
          </div>
          {pageGroups.length > 0 && <details className="section-source-details">
            <summary>
              <ChevronRight size={11} />
              <span>Full extracted text ({bodyLines.length} lines)</span>
            </summary>
            <div className="section-paragraphs-wrap">
              {pageGroups.map((group) => <p className="section-text-paragraph" key={`${section.start_page}-${group.page}-${group.lines[0].line_number}`}>
                <span>{group.lines.map((line) => line.text).join(' ')}</span>
                <PageCitation paperId={paperId} page={group.page} line={group.lines[0].line_number} lineEnd={group.lines[group.lines.length - 1].line_number} />
              </p>)}
            </div>
          </details>}
          {section.children.length > 0 && <OutlineItems items={section.children} paperId={paperId} linesByReference={linesByReference} />}
        </div>
      </details>
    </li>
  })}</ol>
}

export default function ManuscriptPanel({ paper, onClose }: Props) {
  const [document, setDocument] = useState<ManuscriptDocument | null>(null)
  const [tab, setTab] = useState<Tab>('outline')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(`/api/papers/${encodeURIComponent(paper.id)}/manuscript`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ManuscriptDocument & { detail?: string }
        if (!response.ok) throw new Error(payload.detail || 'Could not load the parsed manuscript.')
        return payload
      })
      .then(setDocument)
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Could not load the parsed manuscript.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [paper.id])

  const extractedEntries = Object.entries(paper.extractedData ?? {})
  const hasExtracted = extractedEntries.length > 0

  const tabs: { id: Tab; label: string; count?: number; icon: typeof FileText }[] = [
    { id: 'outline', label: 'Outline & Summaries', icon: FileText },
    ...(hasExtracted ? [{ id: 'extracted' as const, label: 'Extracted Fields', count: extractedEntries.length, icon: Sparkles }] : []),
    { id: 'figures', label: 'Figures', count: document?.figures.length, icon: Image },
    { id: 'tables', label: 'Tables', count: document?.tables.length, icon: Table2 },
    { id: 'references', label: 'References', count: document?.references.length, icon: FileText },
    { id: 'pages', label: 'Page text', icon: FileText },
  ]

  return <div className="manuscript-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="manuscript-panel" aria-label="Parsed manuscript">
      <header className="manuscript-header">
        <div className="manuscript-heading-copy">
          <div className="manuscript-eyebrow">ATTACHED MANUSCRIPT</div>
          <h2>{paper.title}</h2>
          <p>{paper.manuscript.fileName} · {paper.manuscript.pageCount} pages · {paper.manuscript.lineCount.toLocaleString()} extracted lines</p>
        </div>
        <div className="manuscript-header-actions">
          <a className="manuscript-pdf-link" href={pdfPageUrl(paper.id, 1)} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open PDF</a>
          <button className="icon-button" type="button" onClick={onClose} title="Close manuscript"><X size={17} /></button>
        </div>
      </header>

      <nav className="manuscript-tabs" role="tablist" aria-label="Manuscript sections">
        {tabs.map(({ id, label, count, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id} className={`manuscript-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
          <Icon size={14} /><span>{label}</span>{count !== undefined && <span className="manuscript-tab-count">{count}</span>}
        </button>)}
      </nav>

      <main className="manuscript-content">
        {loading && <div className="manuscript-loading"><LoaderCircle size={18} className="spin" /> Loading extracted manuscript…</div>}
        {!loading && error && <div className="manuscript-message manuscript-error">{error}</div>}
        {!loading && document && <>
          {document.warnings.map((warning) => <div className="manuscript-message manuscript-warning" key={warning}>{warning}</div>)}
          {tab === 'outline' && <section className="document-section">
            {document.overall_summary && <div className="manuscript-overall-summary">
              <div className="overall-summary-badge">
                <Sparkles size={13} />
                <span>OVERALL MANUSCRIPT SUMMARY</span>
              </div>
              <p className="overall-summary-content">{document.overall_summary}</p>
            </div>}
            <div className="document-section-heading"><span>SECTIONS &amp; SUMMARIES</span><span>{document.sections.length} top-level sections</span></div>
            {document.sections.length ? <OutlineItems items={document.sections} paperId={paper.id} linesByReference={new Map(document.pages.flatMap((page) => page.lines.map((line) => [`${page.page_number}:${line.line_number}`, line] as const)))} firstOpen /> : <p className="document-empty">No headings were detected in this PDF.</p>}
          </section>}
          {tab === 'extracted' && <section className="document-section">
            <div className="document-section-heading"><span>STRUCTURED DATA EXTRACTIONS</span><span>{extractedEntries.length} fields</span></div>
            {extractedEntries.length ? (
              <div className="extracted-fields-grid">
                {extractedEntries.map(([name, raw]) => {
                  const val = typeof raw === 'string' ? raw : (raw?.value || 'Not reported')
                  return (
                    <article key={name} className="extracted-detail-card">
                      <header className="extracted-detail-header">
                        <div className="extracted-detail-title-badge">
                          <Sparkles size={12} />
                          <span>{name}</span>
                        </div>
                      </header>
                      <div className="extracted-detail-value-box">
                        <span className="extracted-detail-label">Extracted Value</span>
                        <div className="extracted-detail-val">{val}</div>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : (
              <p className="document-empty">No extracted fields available for this paper yet.</p>
            )}
          </section>}
          {tab === 'figures' && <section className="document-section">
            <div className="document-section-heading"><span>FIGURE CAPTIONS</span><span>{document.figures.length} found</span></div>
            {document.figures.length ? document.figures.map((figure, index) => <article className="figure-entry" key={`${figure.page_number}-${index}`}>
              <div className="figure-entry-icon"><Image size={16} /></div><div className="figure-entry-copy"><strong>{figure.label}</strong><p>{figure.caption}</p><FigurePreview paperId={paper.id} index={index} label={figure.label} caption={figure.caption} /><PageCitation paperId={paper.id} page={figure.page_number} line={figure.line_refs[0]?.line_number} /></div>
            </article>) : <p className="document-empty">No figure captions were detected.</p>}
          </section>}
          {tab === 'tables' && <section className="document-section">
            <div className="document-section-heading"><span>EXTRACTED TABLES</span><span>{document.tables.length} found</span></div>
            {document.tables.length ? document.tables.map((table, index) => {
              const headerRow = table.cells[0] ?? []
              const bodyRows = table.cells.slice(1)
              return <article className="table-entry" key={`${table.page_number}-${index}`}>
                <header className="table-entry-header">
                  <div className="table-header-info">
                    <div className="table-title-row">
                      <span className="table-label-badge"><Table2 size={13} /> {table.label}</span>
                      <span className="table-dim-badge">{table.cells.length} rows × {headerRow.length} cols</span>
                    </div>
                    {table.caption && <p className="table-caption">{table.caption}</p>}
                  </div>
                  <div className="table-header-citation">
                    <PageCitation paperId={paper.id} page={table.page_number} line={table.line_refs[0]?.line_number} />
                  </div>
                </header>
                <div className="extracted-table-scroll">
                  <table className="extracted-table">
                    <thead>
                      <tr>
                        {headerRow.map((cell, cellIndex) => <th key={cellIndex}>{cell || '—'}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {bodyRows.map((row, rowIndex) => <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => <td key={cellIndex}>{cell || '—'}</td>)}
                      </tr>)}
                    </tbody>
                  </table>
                </div>
              </article>
            }) : <p className="document-empty">No tables were detected on this manuscript.</p>}
          </section>}
          {tab === 'references' && <section className="document-section">
            <div className="document-section-heading"><span>REFERENCE LIST</span><span>{document.references.length} found</span></div>
            {document.references.length ? <ol className="reference-list">{document.references.map((reference, index) => <li key={`${reference.page_number}-${index}`}>
              <span className="reference-number">{reference.label || String(index + 1).padStart(2, '0')}</span><p>{reference.text}</p><PageCitation paperId={paper.id} page={reference.page_number} line={reference.line_refs[0]?.line_number} />
            </li>)}</ol> : <p className="document-empty">No references were detected. The PDF may use a different heading or citation style.</p>}
          </section>}
          {tab === 'pages' && <section className="document-section page-text-section">
            <div className="document-section-heading"><span>PAGE-ORDERED TEXT</span><span>Page and line numbers are local to the PDF</span></div>
            {document.pages.map((page) => <details className="page-text-entry" key={page.page_number} open={page.page_number === 1}>
              <summary>Page {page.page_number}<span>{page.lines.length} lines</span><PageCitation paperId={paper.id} page={page.page_number} /></summary>
              <ol>{page.lines.map((line) => <li key={line.line_number}><span className="page-line-number">L{line.line_number}</span><span>{line.text}</span><span className="page-line-position">x {Math.round(line.bbox.x0)} · y {Math.round(line.bbox.top)}</span></li>)}</ol>
            </details>)}
          </section>}
        </>}
      </main>
    </section>
  </div>
}
