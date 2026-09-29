import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Image,
  ListTree,
  LoaderCircle,
  Maximize2,
  Search,
  Sparkles,
  Table2,
  X,
} from 'lucide-react'
import './ManuscriptPanel.css'
import type { ManuscriptMetadata } from './types'

type LineReference = { page_number: number; line_number: number }
type BoundingBox = { x0: number; top: number; x1: number; bottom: number }
type DocumentLine = { page_number: number; line_number: number; text: string; bbox: BoundingBox; font_size: number }
type Section = {
  title: string
  original_title?: string
  standard_section?: string | null
  is_excluded_from_llm?: boolean
  level: number
  start_page: number
  end_page: number
  start_line: number
  line_refs: LineReference[]
  children: Section[]
  summary?: string
}
type MappedSectionItem = {
  standard_section: string
  original_title: string
  page: number
  line: number
  level: number
}
type UnmatchedSectionItem = {
  original_title: string
  page: number
  line: number
  level: number
}
type ReferencesSectionItem = {
  original_title: string
  page: number
  line: number
  line_count: number
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
  sections: Section[]
  mapped_sections?: MappedSectionItem[]
  unmatched_sections?: UnmatchedSectionItem[]
  references_section?: ReferencesSectionItem | null
  pages: { page_number: number; width: number; height: number; lines: DocumentLine[] }[]
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

type Tab = 'sections' | 'extracted' | 'figures' | 'tables' | 'references' | 'pages'

type ParagraphBlock = {
  text: string
  startPage: number
  endPage: number
  startLine: number
  endLine: number
}

function pdfPageUrl(paperId: string, pageNumber: number) {
  return `/api/papers/${encodeURIComponent(paperId)}/manuscript.pdf#page=${pageNumber}`
}

function PageCitation({
  paperId,
  page,
  line,
  lineEnd,
  label,
}: {
  paperId: string
  page: number
  line?: number
  lineEnd?: number
  label?: string
}) {
  const text = label ?? `p. ${page}${line ? ` · L${line}${lineEnd && lineEnd !== line ? `–${lineEnd}` : ''}` : ''}`
  return (
    <a className="document-citation" href={pdfPageUrl(paperId, page)} target="_blank" rel="noreferrer" title={`Open PDF at page ${page}`}>
      <span>{text}</span>
      <ExternalLink size={10} />
    </a>
  )
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

/**
 * Reconstructs clean, cohesive paragraphs from sequential DocumentLines,
 * handling hyphenation breaks and natural paragraph separation.
 */
function buildParagraphs(lines: DocumentLine[]): ParagraphBlock[] {
  if (!lines.length) return []
  const paragraphs: ParagraphBlock[] = []
  let currentLines: DocumentLine[] = []

  const flush = () => {
    if (!currentLines.length) return
    let text = ''
    for (let i = 0; i < currentLines.length; i++) {
      const lineText = currentLines[i].text.trim()
      if (!lineText) continue
      if (!text) {
        text = lineText
      } else if (text.endsWith('-') && /^[a-z]/i.test(lineText)) {
        text = text.slice(0, -1) + lineText
      } else {
        text += ' ' + lineText
      }
    }
    if (text.trim()) {
      paragraphs.push({
        text: text.trim(),
        startPage: currentLines[0].page_number,
        endPage: currentLines[currentLines.length - 1].page_number,
        startLine: currentLines[0].line_number,
        endLine: currentLines[currentLines.length - 1].line_number,
      })
    }
    currentLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (currentLines.length > 0) {
      const prevLine = currentLines[currentLines.length - 1]
      const isPageBreak = line.page_number !== prevLine.page_number
      const approxLineHeight = Math.max(8, prevLine.bbox.bottom - prevLine.bbox.top)
      const verticalGap = !isPageBreak ? line.bbox.top - prevLine.bbox.bottom : 999
      const prevEndsSentence = /[.!?:"”)]$/.test(prevLine.text.trim())

      if (
        (verticalGap > approxLineHeight * 1.35) ||
        (isPageBreak && prevEndsSentence)
      ) {
        flush()
      }
    }
    currentLines.push(line)
  }
  flush()
  return paragraphs
}

/**
 * Section & Subsection Card component rendering structured title, summary,
 * and fluent extracted paragraphs with citation links.
 */
function SectionCard({
  section,
  paperId,
  linesByReference,
  level = 1,
  showSummaries = true,
  searchQuery = '',
  expanded = true,
  onToggleExpand,
}: {
  section: Section
  paperId: string
  linesByReference: Map<string, DocumentLine>
  level?: number
  showSummaries?: boolean
  searchQuery?: string
  expanded?: boolean
  onToggleExpand?: () => void
}) {
  const [copied, setCopied] = useState(false)

  const bodyLines = useMemo(() => {
    // line_refs[0] is typically the section title itself
    const linesToProcess = section.line_refs.length > 1 ? section.line_refs.slice(1) : section.line_refs
    return linesToProcess
      .map((ref) => linesByReference.get(`${ref.page_number}:${ref.line_number}`))
      .filter((l): l is DocumentLine => Boolean(l))
  }, [section.line_refs, linesByReference])

  const paragraphs = useMemo(() => buildParagraphs(bodyLines), [bodyLines])

  const fullText = useMemo(() => {
    return paragraphs.map((p) => p.text).join('\n\n')
  }, [paragraphs])

  const copySectionText = async () => {
    try {
      await navigator.clipboard.writeText(`${section.title}\n\n${fullText}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      // ignore
    }
  }

  const pageRange = useMemo(() => {
    if (section.start_page === section.end_page) {
      return `p. ${section.start_page}`
    }
    return `pp. ${section.start_page}–${section.end_page}`
  }, [section.start_page, section.end_page])

  const matchesSearch = useMemo(() => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      section.title.toLowerCase().includes(q) ||
      (section.summary && section.summary.toLowerCase().includes(q)) ||
      fullText.toLowerCase().includes(q)
    )
  }, [searchQuery, section.title, section.summary, fullText])

  if (!matchesSearch) {
    return null
  }

  const sectionAnchorId = `section-${section.start_page}-${section.start_line}`
  const hasSummary = Boolean(section.summary && !isUnwantedSectionSummary(section.title))
  const levelClass = level === 1 ? 'section-card-h1' : level === 2 ? 'section-card-h2' : 'section-card-h3'

  return (
    <article id={sectionAnchorId} className={`section-card ${levelClass}`}>
      <header className="section-card-header">
        <div className="section-header-left">
          {onToggleExpand && (
            <button
              type="button"
              className="section-collapse-btn"
              onClick={onToggleExpand}
              title={expanded ? 'Collapse section' : 'Expand section'}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          <span className="section-level-badge">
            {level === 1 ? 'Section' : 'Subsection'} {String(section.level)}
          </span>
          {section.standard_section && (
            <span
              className={`standard-section-badge std-badge-${section.standard_section.toLowerCase().replace(/[\s&]+/g, '')}`}
              title={`Mapped standard section: ${section.standard_section}`}
            >
              {section.standard_section}
            </span>
          )}
          {section.is_excluded_from_llm && section.standard_section !== 'References' && (
            <span className="excluded-section-badge" title="Administrative section excluded from LLM API prompts">
              Administrative (Excluded)
            </span>
          )}
          <h3 className="section-card-title">{section.original_title || section.title}</h3>
        </div>

        <div className="section-header-right">
          <span className="section-meta-pill" title="Pages in PDF">{pageRange}</span>
          <span className="section-meta-pill" title="Extracted line count">{bodyLines.length} lines</span>
          <button
            type="button"
            className="section-action-btn"
            onClick={() => void copySectionText()}
            title="Copy section text"
          >
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
          <PageCitation paperId={paperId} page={section.start_page} line={section.start_line} label="PDF" />
        </div>
      </header>

      {expanded && (
        <div className="section-card-body">
          {showSummaries && hasSummary && (
            <div className="section-summary-box">
              <div className="section-summary-header">
                <Sparkles size={11} className="summary-sparkle" />
                <span>AI SECTION SUMMARY</span>
              </div>
              <p className="section-summary-text">{section.summary}</p>
            </div>
          )}

          {paragraphs.length > 0 ? (
            <div className="section-paragraphs-stream">
              {paragraphs.map((para, pIdx) => (
                <div key={pIdx} className="section-paragraph-row">
                  <p className="section-paragraph-text">{para.text}</p>
                  <div className="paragraph-citation-wrap">
                    <PageCitation
                      paperId={paperId}
                      page={para.startPage}
                      line={para.startLine}
                      lineEnd={para.endLine}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="section-empty-hint">No body text lines extracted under this heading.</p>
          )}

          {/* Render Child Subsections */}
          {section.children.length > 0 && (
            <div className="section-subsections-container">
              {section.children.map((child, childIdx) => (
                <SectionCard
                  key={`${child.start_page}-${child.start_line}-${childIdx}`}
                  section={child}
                  paperId={paperId}
                  linesByReference={linesByReference}
                  level={level + 1}
                  showSummaries={showSummaries}
                  searchQuery={searchQuery}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export default function ManuscriptPanel({ paper, onClose }: Props) {
  const [document, setDocument] = useState<ManuscriptDocument | null>(null)
  const [tab, setTab] = useState<Tab>('sections')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showSummaries, setShowSummaries] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})
  const [rawLineMode, setRawLineMode] = useState(false)
  const [generatingSummaries, setGeneratingSummaries] = useState(false)
  const [summaryError, setSummaryError] = useState('')

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

  const handleGenerateSummaries = async () => {
    setGeneratingSummaries(true)
    setSummaryError('')
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(paper.id)}/summarize`, {
        method: 'POST',
      })
      const payload = await response.json() as ManuscriptDocument & { detail?: string }
      if (!response.ok) {
        throw new Error(payload.detail || 'Could not generate summaries.')
      }
      setDocument(payload)
      setShowSummaries(true)
    } catch (err: unknown) {
      setSummaryError(err instanceof Error ? err.message : 'Could not generate AI summaries.')
    } finally {
      setGeneratingSummaries(false)
    }
  }

  const linesByReference = useMemo(() => {
    if (!document) return new Map<string, DocumentLine>()
    const map = new Map<string, DocumentLine>()
    for (const page of document.pages) {
      for (const line of page.lines) {
        map.set(`${page.page_number}:${line.line_number}`, line)
      }
    }
    return map
  }, [document])

  const extractedEntries = Object.entries(paper.extractedData ?? {})
  const hasExtracted = extractedEntries.length > 0

  const tabs: { id: Tab; label: string; count?: number; icon: typeof FileText }[] = [
    { id: 'sections', label: 'Sections & Text', count: document?.sections.length, icon: BookOpen },
    ...(hasExtracted ? [{ id: 'extracted' as const, label: 'Extracted Fields', count: extractedEntries.length, icon: Sparkles }] : []),
    { id: 'figures', label: 'Figures', count: document?.figures.length, icon: Image },
    { id: 'tables', label: 'Tables', count: document?.tables.length, icon: Table2 },
    { id: 'references', label: 'References', count: document?.references.length, icon: FileText },
    { id: 'pages', label: 'Page text', count: document?.pages.length, icon: FileText },
  ]

  const toggleAllSections = (expand: boolean) => {
    if (!document) return
    const next: Record<string, boolean> = {}
    const traverse = (secs: Section[]) => {
      for (const s of secs) {
        const key = `${s.start_page}-${s.start_line}`
        next[key] = expand
        if (s.children) traverse(s.children)
      }
    }
    traverse(document.sections)
    setExpandedSections(next)
  }

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [key]: prev[key] === undefined ? false : !prev[key],
    }))
  }

  const jumpToSection = (startPage: number, startLine: number) => {
    const el = window.document.getElementById(`section-${startPage}-${startLine}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('section-highlight')
      setTimeout(() => el.classList.remove('section-highlight'), 1800)
    }
  }

  return (
    <div className="manuscript-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="manuscript-panel" aria-label="Parsed manuscript">
        <header className="manuscript-header">
          <div className="manuscript-heading-copy">
            <div className="manuscript-eyebrow">ATTACHED MANUSCRIPT</div>
            <h2>{paper.title}</h2>
            <p>{paper.manuscript.fileName} · {paper.manuscript.pageCount} pages · {paper.manuscript.lineCount.toLocaleString()} extracted lines</p>
          </div>
          <div className="manuscript-header-actions">
            <a className="manuscript-pdf-link" href={pdfPageUrl(paper.id, 1)} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Open PDF
            </a>
            <button className="icon-button" type="button" onClick={onClose} title="Close manuscript">
              <X size={17} />
            </button>
          </div>
        </header>

        <nav className="manuscript-tabs" role="tablist" aria-label="Manuscript sections">
          {tabs.map(({ id, label, count, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`manuscript-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon size={14} />
              <span>{label}</span>
              {count !== undefined && <span className="manuscript-tab-count">{count}</span>}
            </button>
          ))}
        </nav>

        <main className="manuscript-content">
          {loading && (
            <div className="manuscript-loading">
              <LoaderCircle size={18} className="spin" /> Loading extracted manuscript…
            </div>
          )}

          {!loading && error && (
            <div className="manuscript-message manuscript-error">{error}</div>
          )}

          {!loading && document && (
            <>
              {document.warnings.map((warning) => (
                <div className="manuscript-message manuscript-warning" key={warning}>{warning}</div>
              ))}

              {/* SECTION BY SECTION FULL TEXT VIEW */}
              {tab === 'sections' && (
                <section className="document-section sections-view-container">
                  {/* Standard Section Mappings & Unmatched Bar */}
                  {((document.mapped_sections && document.mapped_sections.length > 0) || (document.unmatched_sections && document.unmatched_sections.length > 0)) && (
                    <div className="section-mapping-overview-card">
                      <div className="mapping-overview-header">
                        <div className="mapping-overview-title">
                          <BookOpen size={12} />
                          <span>CANONICAL SECTION MAPPINGS</span>
                          <span className="mapping-count-badge">{document.mapped_sections?.length || 0} mapped</span>
                        </div>
                        {document.references_section && (
                          <button
                            type="button"
                            className="references-mapped-indicator"
                            onClick={() => jumpToSection(document.references_section!.page, document.references_section!.line)}
                            title="Jump to References Section in PDF"
                          >
                            <FileText size={11} />
                            <span>References mapped ({document.references.length} citations)</span>
                          </button>
                        )}
                      </div>

                      {document.mapped_sections && document.mapped_sections.length > 0 && (
                        <div className="mapped-sections-grid">
                          {document.mapped_sections.map((m, idx) => (
                            <button
                              key={idx}
                              type="button"
                              className={`mapped-section-pill std-badge-${m.standard_section.toLowerCase().replace(/[\s&]+/g, '')}`}
                              onClick={() => jumpToSection(m.page, m.line)}
                              title={`Jump to ${m.original_title} (Page ${m.page})`}
                            >
                              <span className="mapped-std-name">{m.standard_section}</span>
                              <span className="mapped-orig-arrow">→</span>
                              <span className="mapped-orig-name">{m.original_title}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {document.unmatched_sections && document.unmatched_sections.length > 0 && (
                        <div className="unmatched-sections-row">
                          <span className="unmatched-label">Unmatched Sections ({document.unmatched_sections.length}):</span>
                          <div className="unmatched-pills-list">
                            {document.unmatched_sections.map((u, uIdx) => (
                              <button
                                key={uIdx}
                                type="button"
                                className="unmatched-section-pill"
                                onClick={() => jumpToSection(u.page, u.line)}
                                title={`Jump to ${u.original_title} (Page ${u.page})`}
                              >
                                {u.original_title}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {document.overall_summary && (
                    <div className="manuscript-overall-summary">
                      <div className="overall-summary-badge">
                        <Sparkles size={13} />
                        <span>OVERALL MANUSCRIPT SYNTHESIS</span>
                      </div>
                      <p className="overall-summary-content">{document.overall_summary}</p>
                    </div>
                  )}

                  {/* Section Controls Toolbar */}
                  <div className="sections-toolbar">
                    <div className="sections-search-box">
                      <Search size={13} className="search-icon" />
                      <input
                        type="text"
                        placeholder="Search sections or text…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="sections-search-input"
                      />
                      {searchQuery && (
                        <button type="button" className="search-clear-btn" onClick={() => setSearchQuery('')}>
                          <X size={11} />
                        </button>
                      )}
                    </div>

                    <div className="sections-toolbar-actions">
                      <button
                        type="button"
                        className={`toolbar-btn generate-summaries-action-btn ${document.overall_summary ? 'regenerate-btn' : 'primary-generate-btn'}`}
                        onClick={handleGenerateSummaries}
                        disabled={generatingSummaries}
                        title={document.overall_summary ? 'Regenerate AI section summaries' : 'Generate AI summaries for manuscript and sections'}
                      >
                        {generatingSummaries ? (
                          <><LoaderCircle size={12} className="spin" /> Generating…</>
                        ) : (
                          <><Sparkles size={12} /> {document.overall_summary ? 'Regenerate Summaries' : 'Generate AI Summaries'}</>
                        )}
                      </button>
                      {document.overall_summary && (
                        <button
                          type="button"
                          className={`toolbar-toggle-btn ${showSummaries ? 'active' : ''}`}
                          onClick={() => setShowSummaries(!showSummaries)}
                          title="Toggle AI Section Summaries"
                        >
                          <Sparkles size={12} /> Summaries
                        </button>
                      )}
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={() => toggleAllSections(true)}
                        title="Expand all sections"
                      >
                        Expand all
                      </button>
                      <button
                        type="button"
                        className="toolbar-btn"
                        onClick={() => toggleAllSections(false)}
                        title="Collapse all sections"
                      >
                        Collapse all
                      </button>
                    </div>
                  </div>

                  {summaryError && (
                    <div className="manuscript-message manuscript-error inline-summary-error">
                      <span>{summaryError}</span>
                      <button type="button" className="search-clear-btn" onClick={() => setSummaryError('')}><X size={12} /></button>
                    </div>
                  )}

                  {/* Quick Jump Index Pills */}
                  {document.sections.length > 0 && !searchQuery && (
                    <div className="section-jump-bar" aria-label="Quick section navigation">
                      <span className="jump-bar-label"><ListTree size={12} /> JUMP TO:</span>
                      <div className="jump-bar-pills">
                        {document.sections.map((sec, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="jump-pill"
                            onClick={() => jumpToSection(sec.start_page, sec.start_line)}
                          >
                            {sec.original_title || sec.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="document-section-heading">
                    <span>EXTRACTED SECTIONS &amp; SUBSECTIONS</span>
                    <span>{document.sections.length} top-level sections</span>
                  </div>

                  {document.sections.length ? (
                    <div className="sections-flow-list">
                      {document.sections.map((section, index) => {
                        const key = `${section.start_page}-${section.start_line}`
                        const isExpanded = expandedSections[key] !== false
                        return (
                          <SectionCard
                            key={`${key}-${index}`}
                            section={section}
                            paperId={paper.id}
                            linesByReference={linesByReference}
                            level={1}
                            showSummaries={showSummaries}
                            searchQuery={searchQuery}
                            expanded={isExpanded}
                            onToggleExpand={() => toggleSection(key)}
                          />
                        )
                      })}
                    </div>
                  ) : (
                    <p className="document-empty">No section headings detected in this PDF.</p>
                  )}
                </section>
              )}

              {/* STRUCTURED DATA EXTRACTIONS */}
              {tab === 'extracted' && (
                <section className="document-section">
                  <div className="document-section-heading">
                    <span>STRUCTURED DATA EXTRACTIONS</span>
                    <span>{extractedEntries.length} fields</span>
                  </div>
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
                </section>
              )}

              {/* FIGURES */}
              {tab === 'figures' && (
                <section className="document-section">
                  <div className="document-section-heading">
                    <span>FIGURE CAPTIONS &amp; PREVIEWS</span>
                    <span>{document.figures.length} found</span>
                  </div>
                  {document.figures.length ? (
                    document.figures.map((figure, index) => (
                      <article className="figure-entry" key={`${figure.page_number}-${index}`}>
                        <div className="figure-entry-icon"><Image size={16} /></div>
                        <div className="figure-entry-copy">
                          <strong>{figure.label}</strong>
                          <p>{figure.caption}</p>
                          <FigurePreview paperId={paper.id} index={index} label={figure.label} caption={figure.caption} />
                          <PageCitation paperId={paper.id} page={figure.page_number} line={figure.line_refs[0]?.line_number} />
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="document-empty">No figure captions were detected.</p>
                  )}
                </section>
              )}

              {/* TABLES */}
              {tab === 'tables' && (
                <section className="document-section">
                  <div className="document-section-heading">
                    <span>EXTRACTED 2D TABLES</span>
                    <span>{document.tables.length} found</span>
                  </div>
                  {document.tables.length ? (
                    document.tables.map((table, index) => {
                      const headerRow = table.cells[0] ?? []
                      const bodyRows = table.cells.slice(1)
                      return (
                        <article className="table-entry" key={`${table.page_number}-${index}`}>
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
                                  {headerRow.map((cell, cellIndex) => (
                                    <th key={cellIndex}>{cell || '—'}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {bodyRows.map((row, rowIndex) => (
                                  <tr key={rowIndex}>
                                    {row.map((cell, cellIndex) => (
                                      <td key={cellIndex}>{cell || '—'}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </article>
                      )
                    })
                  ) : (
                    <p className="document-empty">No tables were detected on this manuscript.</p>
                  )}
                </section>
              )}

              {/* REFERENCES */}
              {tab === 'references' && (
                <section className="document-section">
                  <div className="document-section-heading">
                    <span>REFERENCE LIST</span>
                    <span>{document.references.length} found</span>
                  </div>
                  {document.references.length ? (
                    <ol className="reference-list">
                      {document.references.map((reference, index) => (
                        <li key={`${reference.page_number}-${index}`}>
                          <span className="reference-number">{reference.label || String(index + 1).padStart(2, '0')}</span>
                          <p>{reference.text}</p>
                          <PageCitation paperId={paper.id} page={reference.page_number} line={reference.line_refs[0]?.line_number} />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="document-empty">No references were detected.</p>
                  )}
                </section>
              )}

              {/* PAGE-ORDERED PARAGRAPHS & TEXT */}
              {tab === 'pages' && (
                <section className="document-section page-text-section">
                  <div className="document-section-heading">
                    <span>PAGE-ORDERED TEXT</span>
                    <div className="page-view-mode-toggle">
                      <button
                        type="button"
                        className={`mode-btn ${!rawLineMode ? 'active' : ''}`}
                        onClick={() => setRawLineMode(false)}
                      >
                        Readable Paragraphs
                      </button>
                      <button
                        type="button"
                        className={`mode-btn ${rawLineMode ? 'active' : ''}`}
                        onClick={() => setRawLineMode(true)}
                      >
                        Raw Line Diagnostics
                      </button>
                    </div>
                  </div>

                  {document.pages.map((page) => {
                    const pageParagraphs = buildParagraphs(page.lines)
                    return (
                      <details className="page-text-entry" key={page.page_number} open={page.page_number === 1}>
                        <summary>
                          <span>Page {page.page_number}</span>
                          <span className="page-summary-count">{page.lines.length} lines · {pageParagraphs.length} paragraphs</span>
                          <PageCitation paperId={paper.id} page={page.page_number} />
                        </summary>
                        <div className="page-card-body">
                          {!rawLineMode ? (
                            <div className="page-paragraphs-list">
                              {pageParagraphs.map((para, pIdx) => (
                                <div key={pIdx} className="page-paragraph-item">
                                  <p>{para.text}</p>
                                  <div className="page-paragraph-footer">
                                    <PageCitation
                                      paperId={paper.id}
                                      page={para.startPage}
                                      line={para.startLine}
                                      lineEnd={para.endLine}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <ol className="raw-lines-list">
                              {page.lines.map((line) => (
                                <li key={line.line_number}>
                                  <span className="page-line-number">L{line.line_number}</span>
                                  <span className="page-line-text">{line.text}</span>
                                  <span className="page-line-position">
                                    x {Math.round(line.bbox.x0)} · y {Math.round(line.bbox.top)}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>
                      </details>
                    )
                  })}
                </section>
              )}
            </>
          )}
        </main>
      </section>
    </div>
  )
}
