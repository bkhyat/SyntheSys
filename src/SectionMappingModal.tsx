import { useMemo, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ExternalLink,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { ManuscriptDocument, SectionNode } from './types'
import './SectionMappingModal.css'

export type SectionMappingModalProps = {
  paperId: string
  paperTitle: string
  document: ManuscriptDocument
  onClose: () => void
  onSave: (updatedDoc: ManuscriptDocument) => void
  isInitialUpload?: boolean
}

type DraftMapping = {
  key: string
  original_title: string
  title: string
  level: number
  start_page: number
  start_line: number
  end_page: number
  line_count: number
  standard_section: string | null
  is_excluded: boolean
  initial_mapped: boolean
}

const CANONICAL_SECTIONS = [
  { value: '', label: '— Unmapped / Custom —' },
  { value: 'Abstract', label: 'Abstract' },
  { value: 'Introduction', label: 'Introduction' },
  { value: 'Methods', label: 'Methods' },
  { value: 'Results', label: 'Results' },
  { value: 'Discussion', label: 'Discussion' },
  { value: 'Conclusion', label: 'Conclusion' },
  { value: 'Limitations', label: 'Limitations' },
  { value: 'Future Directions', label: 'Future Directions' },
  { value: 'References', label: 'References' },
  { value: 'Administrative (Excluded)', label: 'Administrative (Excluded)' },
]

function flattenSectionTree(sections: SectionNode[]): DraftMapping[] {
  const result: DraftMapping[] = []

  function traverse(nodes: SectionNode[]) {
    for (const node of nodes) {
      const orig = node.original_title || node.title
      const key = `${node.start_page}-${node.start_line}-${orig}`
      const isInitialMapped = Boolean(node.standard_section)
      result.push({
        key,
        original_title: orig,
        title: node.title,
        level: node.level,
        start_page: node.start_page,
        start_line: node.start_line,
        end_page: node.end_page,
        line_count: node.line_refs ? node.line_refs.length : 0,
        standard_section: node.standard_section || null,
        is_excluded: Boolean(node.is_excluded_from_llm || node.standard_section === 'References'),
        initial_mapped: isInitialMapped,
      })
      if (node.children && node.children.length > 0) {
        traverse(node.children)
      }
    }
  }

  traverse(sections)
  return result
}

function pdfPageUrl(paperId: string, pageNumber: number) {
  return `/api/papers/${encodeURIComponent(paperId)}/manuscript.pdf#page=${pageNumber}`
}

export default function SectionMappingModal({
  paperId,
  paperTitle,
  document,
  onClose,
  onSave,
  isInitialUpload = false,
}: SectionMappingModalProps) {
  const [mappings, setMappings] = useState<DraftMapping[]>(() => flattenSectionTree(document.sections))
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'unmapped' | 'mapped' | 'excluded'>('all')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const stats = useMemo(() => {
    let mapped = 0
    let unmapped = 0
    let excluded = 0
    for (const m of mappings) {
      if (m.is_excluded) {
        excluded++
      } else if (m.standard_section) {
        mapped++
      } else {
        unmapped++
      }
    }
    return { total: mappings.length, mapped, unmapped, excluded }
  }, [mappings])

  const filteredMappings = useMemo(() => {
    return mappings.filter((m) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchesQuery =
          m.original_title.toLowerCase().includes(q) ||
          (m.standard_section && m.standard_section.toLowerCase().includes(q))
        if (!matchesQuery) return false
      }

      if (filterMode === 'unmapped') {
        return !m.standard_section && !m.is_excluded
      }
      if (filterMode === 'mapped') {
        return Boolean(m.standard_section) && !m.is_excluded
      }
      if (filterMode === 'excluded') {
        return m.is_excluded
      }
      return true
    })
  }, [mappings, searchQuery, filterMode])

  const handleStandardChange = (key: string, value: string) => {
    setMappings((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item
        if (value === 'Administrative (Excluded)') {
          return { ...item, standard_section: null, is_excluded: true }
        }
        if (value === 'References') {
          return { ...item, standard_section: 'References', is_excluded: true }
        }
        if (!value) {
          return { ...item, standard_section: null, is_excluded: false }
        }
        return { ...item, standard_section: value, is_excluded: false }
      }),
    )
  }

  const handleExcludedToggle = (key: string, checked: boolean) => {
    setMappings((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item
        return { ...item, is_excluded: checked }
      }),
    )
  }

  const handleExcludeAllUnmapped = () => {
    setMappings((prev) =>
      prev.map((item) => {
        if (!item.standard_section && !item.is_excluded) {
          return { ...item, is_excluded: true }
        }
        return item
      }),
    )
  }

  const handleResetToAuto = () => {
    setMappings(flattenSectionTree(document.sections))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError('')
    try {
      const payloadMappings = mappings.map((m) => ({
        original_title: m.original_title,
        page: m.start_page,
        line: m.start_line,
        standard_section: m.standard_section,
        is_excluded: m.is_excluded,
      }))

      const response = await fetch(`/api/papers/${encodeURIComponent(paperId)}/section-mappings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: payloadMappings }),
      })

      const data = (await response.json()) as ManuscriptDocument & { detail?: string }
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to save section mappings.')
      }

      onSave(data)
      onClose()
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Could not save section mappings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop section-mapping-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <section className="modal section-mapping-modal" aria-labelledby="section-mapping-modal-title">
        {/* Topline Header */}
        <div className="modal-topline section-mapping-modal-topline">
          <div className="section-mapping-modal-title-wrap">
            <span className="modal-icon section-mapping-modal-icon">
              <Layers size={18} />
            </span>
            <div>
              <span className="section-kicker">
                {isInitialUpload ? 'MANUSCRIPT ATTACHED · SECTION MAPPING' : 'MANUSCRIPT CANONICAL MAPPING'}
              </span>
              <h2 id="section-mapping-modal-title">Map Manuscript Sections</h2>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            title="Close"
          >
            <X size={17} />
          </button>
        </div>

        {/* Paper & Status Summary Banner */}
        <div className="section-mapping-summary-banner">
          <div className="summary-paper-info">
            <strong className="summary-paper-title">{paperTitle}</strong>
            <span className="summary-file-tag">{document.file_name} · {document.page_count} pages</span>
          </div>

          <div className="summary-stats-pills">
            <span className="stats-pill pill-total" title="Total sections identified in PDF">
              <strong>{stats.total}</strong> Total Detected
            </span>
            <span className="stats-pill pill-mapped" title="Mapped to standard scientific sections">
              <Check size={11} />
              <strong>{stats.mapped}</strong> Mapped
            </span>
            <span
              className={`stats-pill ${stats.unmapped > 0 ? 'pill-unmapped-alert' : 'pill-unmapped'}`}
              title="Unmapped sections (can be assigned below)"
            >
              {stats.unmapped > 0 && <AlertCircle size={11} />}
              <strong>{stats.unmapped}</strong> Unmapped
            </span>
            <span className="stats-pill pill-excluded" title="Administrative or reference sections excluded from LLM prompts">
              <strong>{stats.excluded}</strong> Excluded from AI
            </span>
          </div>
        </div>

        {/* Guidance Text */}
        <p className="modal-description section-mapping-description">
          SyntheSys automatically parsed the manuscript structure. Substantive standard sections (e.g., Abstract, Introduction, Methods, Results, Discussion) are passed to LLM prompts for data extraction and synthesis. Administrative sections (e.g., References, Funding, Author Contributions) are excluded from AI tokens. <strong>Review and map any unmapped sections below:</strong>
        </p>

        {/* Filter and Search Bar */}
        <div className="section-mapping-toolbar">
          <div className="filter-modes-group">
            <button
              type="button"
              className={`filter-tab-btn ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              All ({stats.total})
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterMode === 'unmapped' ? 'active' : ''} ${stats.unmapped > 0 ? 'has-unmapped-badge' : ''}`}
              onClick={() => setFilterMode('unmapped')}
            >
              Unmapped ({stats.unmapped})
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterMode === 'mapped' ? 'active' : ''}`}
              onClick={() => setFilterMode('mapped')}
            >
              Mapped ({stats.mapped})
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterMode === 'excluded' ? 'active' : ''}`}
              onClick={() => setFilterMode('excluded')}
            >
              Excluded ({stats.excluded})
            </button>
          </div>

          <div className="mapping-search-wrap">
            <Search size={13} className="mapping-search-icon" />
            <input
              type="text"
              placeholder="Search section titles…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="mapping-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="mapping-search-clear"
                onClick={() => setSearchQuery('')}
              >
                <X size={11} />
              </button>
            )}
          </div>

          <div className="mapping-bulk-actions">
            {stats.unmapped > 0 && (
              <button
                type="button"
                className="bulk-action-btn"
                onClick={handleExcludeAllUnmapped}
                title="Mark all remaining unmapped sections as excluded from AI prompts"
              >
                <SlidersHorizontal size={11} /> Exclude All Unmapped
              </button>
            )}
            <button
              type="button"
              className="bulk-action-btn"
              onClick={handleResetToAuto}
              title="Reset all mappings to automatic PDF detection"
            >
              <RefreshCw size={11} /> Reset to Auto
            </button>
          </div>
        </div>

        {/* Section Mappings Table / List */}
        <div className="section-mapping-table-container">
          {filteredMappings.length === 0 ? (
            <div className="mapping-empty-state">
              <BookOpen size={24} />
              <p>No sections match the current filter or search query.</p>
              {filterMode !== 'all' && (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setFilterMode('all')}
                >
                  View All Sections
                </button>
              )}
            </div>
          ) : (
            <table className="section-mapping-table">
              <thead>
                <tr>
                  <th className="th-section-title">SECTION IN MANUSCRIPT</th>
                  <th className="th-location">PAGE / LINE</th>
                  <th className="th-mapping">ASSIGNED CANONICAL SECTION</th>
                  <th className="th-ai-status">AI PROMPT USAGE</th>
                </tr>
              </thead>
              <tbody>
                {filteredMappings.map((item) => {
                  const isUnmapped = !item.standard_section && !item.is_excluded
                  const rowClass = isUnmapped
                    ? 'mapping-row unmapped-row'
                    : item.is_excluded
                      ? 'mapping-row excluded-row'
                      : 'mapping-row mapped-row'

                  const levelIndent = (item.level - 1) * 16

                  // Value for the select dropdown
                  let selectValue = item.standard_section || ''
                  if (item.is_excluded && !item.standard_section) {
                    selectValue = 'Administrative (Excluded)'
                  }

                  return (
                    <tr key={item.key} className={rowClass}>
                      {/* Section Title & Level */}
                      <td className="td-section-title">
                        <div
                          className="section-title-wrap"
                          style={{ paddingLeft: `${levelIndent}px` }}
                        >
                          <span className={`level-tag level-${item.level}`}>
                            {item.level === 1 ? 'H1' : item.level === 2 ? '↳ H2' : '↳ H3'}
                          </span>
                          <span className="section-orig-text" title={item.original_title}>
                            {item.original_title}
                          </span>
                          {item.line_count > 0 && (
                            <span className="section-line-count-tag" title="Extracted lines">
                              {item.line_count}L
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Location Citation */}
                      <td className="td-location">
                        <a
                          className="document-citation mapping-citation-link"
                          href={pdfPageUrl(paperId, item.start_page)}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open PDF at Page ${item.start_page}`}
                        >
                          <span>p. {item.start_page} · L{item.start_line}</span>
                          <ExternalLink size={10} />
                        </a>
                      </td>

                      {/* Standard Section Dropdown Selector */}
                      <td className="td-mapping">
                        <div className="select-mapping-wrap">
                          <select
                            className={`section-mapping-select ${isUnmapped ? 'select-unmapped' : ''} ${item.standard_section ? `select-${item.standard_section.toLowerCase().replace(/[\s&]+/g, '')}` : ''}`}
                            value={selectValue}
                            onChange={(e) => handleStandardChange(item.key, e.target.value)}
                          >
                            {CANONICAL_SECTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>

                      {/* AI Prompt Usage / Status */}
                      <td className="td-ai-status">
                        <div className="ai-status-wrap">
                          {item.is_excluded ? (
                            <label className="ai-exclude-checkbox-label excluded">
                              <input
                                type="checkbox"
                                checked={item.is_excluded}
                                onChange={(e) => handleExcludedToggle(item.key, e.target.checked)}
                              />
                              <span className="ai-status-badge excluded-badge">
                                Excluded from AI
                              </span>
                            </label>
                          ) : item.standard_section ? (
                            <label className="ai-exclude-checkbox-label included">
                              <input
                                type="checkbox"
                                checked={!item.is_excluded}
                                onChange={(e) => handleExcludedToggle(item.key, !e.target.checked)}
                              />
                              <span
                                className={`ai-status-badge std-badge-${item.standard_section.toLowerCase().replace(/[\s&]+/g, '')}`}
                              >
                                {item.standard_section} (Included)
                              </span>
                            </label>
                          ) : (
                            <label className="ai-exclude-checkbox-label unmapped">
                              <input
                                type="checkbox"
                                checked={!item.is_excluded}
                                onChange={(e) => handleExcludedToggle(item.key, !e.target.checked)}
                              />
                              <span className="ai-status-badge unmapped-badge">
                                Custom (Included)
                              </span>
                            </label>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Error notification if any */}
        {saveError && (
          <div className="modal-error section-mapping-modal-error">
            <AlertCircle size={14} />
            <span>{saveError}</span>
          </div>
        )}

        {/* Modal Actions Footer */}
        <div className="modal-actions section-mapping-modal-actions">
          <div className="actions-left-hint">
            <span className="mapping-completion-hint">
              <strong>{stats.mapped}</strong> of <strong>{stats.total}</strong> standard sections mapped
              {stats.unmapped > 0 && <span className="unmapped-pending-warning"> · {stats.unmapped} unmapped</span>}
            </span>
          </div>

          <div className="actions-right-buttons">
            <button
              type="button"
              className="button button-quiet"
              onClick={onClose}
              disabled={saving}
            >
              {isInitialUpload ? 'Skip / Close' : 'Cancel'}
            </button>
            <button
              type="button"
              className="button button-primary section-mapping-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  <span>Saving Mappings…</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} />
                  <span>Save & Apply Mappings</span>
                </>
              )}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
