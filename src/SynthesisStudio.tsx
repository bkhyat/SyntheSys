import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Copy,
  Download,
  Edit3,
  Eye,
  FileText,
  FolderTree,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  LoaderCircle,
  Quote,
  RotateCcw,
  Sigma,
  Sparkles,
  Table as TableIcon,
  X,
} from 'lucide-react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import './SynthesisStudio.css'
import type { Paper, PaperList } from './App'

type Mode = 'view' | 'edit'

type Props = {
  list: PaperList
  papers: Paper[]
  onUpdateSynthesis: (text: string, prompt?: string) => void
  onOpenManuscript?: (paper: Paper) => void
  sourceStageName?: string
}

// Render KaTeX LaTeX math formulas (e.g. $\text{IC}_{50}$, $R^2$, \mu M, etc.)
function renderLatex(tex: string, displayMode = false): React.ReactNode {
  try {
    const html = katex.renderToString(tex.trim(), {
      throwOnError: false,
      displayMode,
    })
    return (
      <span
        className={displayMode ? 'academic-katex-display' : 'academic-katex-inline'}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  } catch {
    return <code className="inline-code">${tex}$</code>
  }
}

// Format inline text: LaTeX ($...$ and $$...$$), Bold (**...**), Italic (*...*), Code (`...`), Links ([text](url))
function formatInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Matches: 1. Display Math $$...$$, 2. Inline Math $...$, 3. Bold **...**, 4. Italic *...*, 5. Code `...`, 6. Link [text](url)
  const regex = /(\$\$([^\$]+)\$\$|\$([^\$\n]+)\$|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    if (match[2]) {
      // Display math $$...$$
      parts.push(
        <span key={`disp-math-${match.index}`} className="academic-math-inline-block">
          {renderLatex(match[2], true)}
        </span>
      )
    } else if (match[3]) {
      // Inline math $...$
      parts.push(
        <span key={`math-${match.index}`} className="academic-math-inline">
          {renderLatex(match[3], false)}
        </span>
      )
    } else if (match[4]) {
      // Bold **...**
      parts.push(<strong key={`bold-${match.index}`}>{formatInline(match[4])}</strong>)
    } else if (match[5]) {
      // Italic *...*
      parts.push(<em key={`italic-${match.index}`}>{formatInline(match[5])}</em>)
    } else if (match[6]) {
      // Inline code `...`
      parts.push(<code key={`code-${match.index}`} className="inline-code">{match[6]}</code>)
    } else if (match[7] && match[8]) {
      // Link [text](url)
      parts.push(
        <a
          key={`link-${match.index}`}
          href={match[8]}
          target="_blank"
          rel="noreferrer"
          className="academic-link"
        >
          {match[7]}
        </a>
      )
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

// Dedicated code block / ASCII tree diagram component with 1-click copy
function AcademicCodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)

  // Detect if this is an ASCII tree diagram / taxonomy structure
  const isTree =
    /[├──│└──┌─]/.test(code) ||
    language.toLowerCase() === 'tree' ||
    language.toLowerCase() === 'ascii' ||
    language.toLowerCase() === 'taxonomy'

  const displayLabel = isTree
    ? 'METHODOLOGICAL TAXONOMY & HIERARCHY'
    : (language ? language.toUpperCase() : 'CODE / STRUCTURE')

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  return (
    <div className={`academic-code-card ${isTree ? 'is-tree-diagram' : ''}`}>
      <div className="code-card-header">
        <div className="code-card-left">
          {isTree ? <FolderTree size={13} /> : <Code size={13} />}
          <span>{displayLabel}</span>
        </div>
        <button
          type="button"
          className="code-copy-btn"
          onClick={handleCopy}
          title="Copy diagram / code content"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="academic-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Lightweight, secure, publication-grade academic Markdown renderer with KaTeX math & Code/Diagram blocks
function renderAcademicMarkdown(markdown: string, onGenerate?: () => void, papersCount = 0): React.ReactNode {
  if (!markdown || !markdown.trim()) {
    return (
      <div className="synthesis-empty-preview">
        <BookOpen size={36} />
        <h4>No synthesis generated yet</h4>
        <p>Synthesize the {papersCount} included studies into a publication-grade Systematic Literature Review with methodological taxonomies, comparative analysis, and evidence matrices.</p>
        {onGenerate && (
          <button
            type="button"
            className="button button-primary empty-generate-btn"
            onClick={onGenerate}
            disabled={papersCount === 0}
          >
            <Sparkles size={14} /> Generate SLR Synthesis
          </button>
        )}
      </div>
    )
  }

  const lines = markdown.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    // Fenced Code Block / ASCII Tree / Structure (``` or ````)
    if (trimmed.startsWith('```')) {
      const info = trimmed.slice(3).trim()
      const codeLines: string[] = []
      i++ // move past opening fence
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++ // move past closing fence
      }
      const codeContent = codeLines.join('\n')
      nodes.push(
        <AcademicCodeBlock
          key={`code-block-${i}`}
          code={codeContent}
          language={info || 'text'}
        />
      )
      continue
    }

    // Standalone LaTeX Display Math Block $$ ... $$
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4) {
      const tex = trimmed.slice(2, -2).trim()
      nodes.push(
        <div key={`math-block-${i}`} className="academic-math-block">
          {renderLatex(tex, true)}
        </div>
      )
      i++
      continue
    }

    // Unfenced ASCII Tree Diagram Detection (e.g., lines containing ├── or └──)
    if (/[├└│┌]/.test(trimmed) && trimmed.includes('──')) {
      const treeLines: string[] = []
      while (
        i < lines.length &&
        lines[i].trim() &&
        (/[├└│┌─]/.test(lines[i]) || lines[i].startsWith('    ') || lines[i].startsWith('\t'))
      ) {
        treeLines.push(lines[i])
        i++
      }
      if (treeLines.length > 0) {
        nodes.push(
          <AcademicCodeBlock
            key={`ascii-tree-${i}`}
            code={treeLines.join('\n')}
            language="tree"
          />
        )
        continue
      }
    }

    // Heading 1
    if (trimmed.startsWith('# ')) {
      nodes.push(
        <h1 key={`h1-${i}`} className="academic-h1">
          {formatInline(trimmed.slice(2))}
        </h1>
      )
      i++
      continue
    }

    // Heading 2
    if (trimmed.startsWith('## ')) {
      nodes.push(
        <h2 key={`h2-${i}`} className="academic-h2">
          {formatInline(trimmed.slice(3))}
        </h2>
      )
      i++
      continue
    }

    // Heading 3
    if (trimmed.startsWith('### ')) {
      nodes.push(
        <h3 key={`h3-${i}`} className="academic-h3">
          {formatInline(trimmed.slice(4))}
        </h3>
      )
      i++
      continue
    }

    // Heading 4
    if (trimmed.startsWith('#### ')) {
      nodes.push(
        <h4 key={`h4-${i}`} className="academic-h4">
          {formatInline(trimmed.slice(5))}
        </h4>
      )
      i++
      continue
    }

    // Horizontal Rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      nodes.push(<hr key={`hr-${i}`} className="academic-hr" />)
      i++
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      nodes.push(
        <blockquote key={`quote-${i}`} className="academic-blockquote">
          {quoteLines.map((ql, qIdx) => (
            <p key={qIdx}>{formatInline(ql)}</p>
          ))}
        </blockquote>
      )
      continue
    }

    // Markdown Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].includes('---')) {
      const tableRows: string[][] = []
      const headerCells = trimmed.slice(1, -1).split('|').map((c) => c.trim())
      tableRows.push(headerCells)
      i += 2 // skip header and divider

      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const rowCells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim())
        tableRows.push(rowCells)
        i++
      }

      nodes.push(
        <div key={`table-wrapper-${i}`} className="academic-table-wrapper">
          <table className="academic-table">
            <thead>
              <tr>
                {tableRows[0].map((cell, cIdx) => (
                  <th key={cIdx}>{formatInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.slice(1).map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx}>{formatInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Unordered List
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const listItems: string[] = []
      while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
        listItems.push(lines[i].trim().slice(2))
        i++
      }
      nodes.push(
        <ul key={`ul-${i}`} className="academic-list">
          {listItems.map((item, idx) => (
            <li key={idx}>{formatInline(item)}</li>
          ))}
        </ul>
      )
      continue
    }

    // Ordered List
    if (/^\d+\.\s/.test(trimmed)) {
      const listItems: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        listItems.push(lines[i].trim().replace(/^\d+\.\s/, ''))
        i++
      }
      nodes.push(
        <ol key={`ol-${i}`} className="academic-ordered-list">
          {listItems.map((item, idx) => (
            <li key={idx}>{formatInline(item)}</li>
          ))}
        </ol>
      )
      continue
    }

    // Regular Paragraph
    nodes.push(
      <p key={`p-${i}`} className="academic-paragraph">
        {formatInline(trimmed)}
      </p>
    )
    i++
  }

  return <div className="academic-document-flow">{nodes}</div>
}

export function SynthesisStudio({
  list,
  papers,
  onUpdateSynthesis,
  onOpenManuscript,
  sourceStageName = 'Source Stage',
}: Props) {
  const [text, setText] = useState(list.synthesisText || '')
  const [mode, setMode] = useState<Mode>('view')
  const [copied, setCopied] = useState(false)
  const [isSaved, setIsSaved] = useState(true)
  const [includedPapersOpen, setIncludedPapersOpen] = useState(false)

  // Resynthesis modal state
  const [resynthOpen, setResynthOpen] = useState(false)
  const [customPrompt, setCustomPrompt] = useState(list.synthesisPrompt || '')
  const [isResynthesizing, setIsResynthesizing] = useState(false)
  const [resynthError, setResynthError] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const customPromptRef = useRef(customPrompt)
  customPromptRef.current = customPrompt

  // Sync state if list synthesis text changes from external source
  useEffect(() => {
    setText(list.synthesisText || '')
    setIsSaved(true)
  }, [list.id, list.synthesisText])

  // Flush any pending text changes on unmount so nothing is lost when switching stages
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        onUpdateSynthesis(textRef.current, customPromptRef.current)
      }
    }
  }, [onUpdateSynthesis])

  const stats = useMemo(() => {
    const raw = text.trim()
    const words = raw ? raw.split(/\s+/).length : 0
    const chars = raw.length
    const readingTimeMins = Math.max(1, Math.ceil(words / 220))
    return { words, chars, readingTimeMins }
  }, [text])

  function flushSave(immediateText?: string) {
    const targetText = immediateText !== undefined ? immediateText : textRef.current
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    onUpdateSynthesis(targetText, customPromptRef.current)
    setIsSaved(true)
  }

  function handleTextChange(newText: string) {
    setText(newText)
    setIsSaved(false)

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      onUpdateSynthesis(newText, customPromptRef.current)
      setIsSaved(true)
    }, 400)
  }

  function insertFormatting(prefix: string, suffix = '') {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = text.slice(start, end)
    const replacement = prefix + (selected || 'text') + suffix
    const updated = text.slice(0, start) + replacement + text.slice(end)
    handleTextChange(updated)

    setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + (selected ? selected.length : 4))
    }, 10)
  }

  function insertTable() {
    const tableTemplate = `\n| Study (Author, Year) | Methodological Category | Core Architecture | Modality / Data | Key Outcomes |\n|---|---|---|---|---|\n| Smith et al. (2024) | Quantum Graph Models | Hybrid Quantum Neural Net | Genomic & Molecular | $\\text{IC}_{50} = 0.42\\,\\mu\\text{M}$ |\n| Chen et al. (2023) | Attention Networks | Duplex Attention GNN | Multi-omics & PPI | High synergy accuracy |\n\n`
    insertFormatting(tableTemplate, '')
  }

  function insertLatex() {
    insertFormatting('$\\text{IC}_{50}$', '')
  }

  function insertTree() {
    const treeTemplate = `\n\`\`\`\nCancer Drug Response Modeling Paradigms\n├── 1. Knowledge-Guided Subgraph & Duplex-Attention Networks\n│   ├── HMM-GDAN (Liu et al., 2023)\n│   └── DRPreter (Shin et al., 2022)\n├── 2. Heterogeneous Topologies & Multi-Level Similarity Networks\n│   ├── GraphTCDR (Zhang et al., 2026)\n│   └── TGSA (Zhu et al., 2022)\n└── 3. Hybrid Classical-Quantum Deep Learning Paradigms\n    └── HQNN (Sagingalieva et al., 2023)\n\`\`\`\n\n`
    insertFormatting(treeTemplate, '')
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      // Fallback
      const textArea = document.createElement('textarea')
      textArea.value = text
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    }
  }

  function downloadFile(extension: 'md' | 'txt') {
    const filename = `${(list.name || 'Systematic_Literature_Review_Synthesis').replace(/[^a-zA-Z0-9_-]/g, '_')}.${extension}`
    const mimeType = extension === 'md' ? 'text/markdown;charset=utf-8;' : 'text/plain;charset=utf-8;'
    const blob = new Blob([text], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function triggerResynthesis() {
    if (!papers.length) {
      setResynthError('No papers in this stage to synthesize.')
      return
    }

    setIsResynthesizing(true)
    setResynthError('')

    const payload = {
      papers: papers.map((p) => ({
        id: p.id,
        title: p.title,
        authors: p.authors || '',
        year: p.year || '',
        journal: p.journal || '',
        doi: p.doi || '',
        url: p.url || '',
        abstract: p.abstract || '',
        score: p.score,
        rationale: p.rationale,
        extractedData: p.extractedData || {},
      })),
      sourceStageName: sourceStageName,
      synthesisPrompt: customPrompt.trim(),
    }

    try {
      const response = await fetch('/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await response.json()) as { synthesis?: string; error?: string }
      if (!response.ok || !data.synthesis) {
        throw new Error(data.error || 'Failed to generate synthesis.')
      }

      setText(data.synthesis)
      onUpdateSynthesis(data.synthesis, customPrompt.trim())
      setIsSaved(true)
      setResynthOpen(false)
      setMode('view') // Switch to view mode to read new synthesis
    } catch (err: unknown) {
      setResynthError(err instanceof Error ? err.message : 'Synthesis request failed.')
    } finally {
      setIsResynthesizing(false)
    }
  }

  return (
    <div className="synthesis-studio-container">
      {/* Studio Top Control Bar */}
      <header className="synthesis-studio-header">
        <div className="synthesis-meta-col">
          <div className="synthesis-badge-row">
            <span className="synthesis-type-pill">
              <Sparkles size={13} />
              <span>AI SLR SYNTHESIS</span>
            </span>

            {/* View / Edit Mode Toggle */}
            <div className="synthesis-mode-toggle" role="tablist" aria-label="Synthesis View or Edit">
              <button
                type="button"
                className={`mode-toggle-btn ${mode === 'view' ? 'active' : ''}`}
                onClick={() => setMode('view')}
                title="View formatted Systematic Literature Review document"
              >
                <Eye size={13} />
                <span>View</span>
              </button>
              <button
                type="button"
                className={`mode-toggle-btn ${mode === 'edit' ? 'active' : ''}`}
                onClick={() => setMode('edit')}
                title="Edit Markdown text and synthesis contents"
              >
                <Edit3 size={13} />
                <span>Edit</span>
              </button>
            </div>

            <span className="synthesis-stat-tag">
              <strong>{papers.length}</strong> included {papers.length === 1 ? 'study' : 'studies'}
            </span>
            <span className="synthesis-stat-tag">
              {stats.words.toLocaleString()} words · ~{stats.readingTimeMins} min read
            </span>
            <span className={`synthesis-save-indicator ${isSaved ? 'saved' : 'saving'}`}>
              {isSaved ? <><Check size={11} /> Saved</> : 'Saving…'}
            </span>
          </div>
        </div>

        <div className="synthesis-actions-col">
          {/* Direct Copy All Contents Button */}
          <button
            type="button"
            className={`button ${copied ? 'button-primary' : 'button-secondary'} copy-all-btn`}
            onClick={copyToClipboard}
            title="Directly copy all markdown synthesis contents to clipboard"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? 'Copied to clipboard!' : 'Copy all'}</span>
          </button>

          <button
            type="button"
            className={`button ${!text.trim() ? 'button-primary' : 'button-secondary'} resynth-trigger-btn`}
            onClick={() => setResynthOpen(true)}
            title={!text.trim() ? 'Generate synthesis using AI from included papers' : 'Re-generate synthesis with customized research prompt'}
          >
            {!text.trim() ? <Sparkles size={13} /> : <RotateCcw size={13} />}
            <span>{!text.trim() ? 'Generate Synthesis' : 'Re-synthesize'}</span>
          </button>

          <button
            type="button"
            className="button button-secondary download-btn"
            onClick={() => downloadFile('md')}
            title="Download as Markdown (.md)"
          >
            <Download size={13} />
            <span>Export .MD</span>
          </button>
        </div>
      </header>

      {/* Unified Single Workspace Container */}
      <div className="synthesis-unified-canvas">
        {mode === 'edit' ? (
          <div className="synthesis-editor-container">
            {/* Markdown Toolbar */}
            <div className="editor-toolbar">
              <button type="button" className="toolbar-btn" onClick={() => insertFormatting('# ')} title="Heading 1"><Heading1 size={14} /></button>
              <button type="button" className="toolbar-btn" onClick={() => insertFormatting('## ')} title="Heading 2"><Heading2 size={14} /></button>
              <button type="button" className="toolbar-btn" onClick={() => insertFormatting('### ')} title="Heading 3"><Heading3 size={14} /></button>
              <span className="toolbar-divider" />
              <button type="button" className="toolbar-btn bold-btn" onClick={() => insertFormatting('**', '**')} title="Bold"><strong>B</strong></button>
              <button type="button" className="toolbar-btn italic-btn" onClick={() => insertFormatting('*', '*')} title="Italic"><em>I</em></button>
              <span className="toolbar-divider" />
              <button type="button" className="toolbar-btn" onClick={() => insertFormatting('- ')} title="Bullet List"><List size={14} /></button>
              <button type="button" className="toolbar-btn" onClick={() => insertFormatting('1. ')} title="Numbered List"><ListOrdered size={14} /></button>
              <button type="button" className="toolbar-btn" onClick={() => insertFormatting('> ')} title="Blockquote"><Quote size={14} /></button>
              <button type="button" className="toolbar-btn" onClick={insertTable} title="Insert Comparison Table"><TableIcon size={14} /> <span>Table</span></button>
              <button type="button" className="toolbar-btn" onClick={insertTree} title="Insert Taxonomy Tree Diagram"><FolderTree size={14} /> <span>Hierarchy</span></button>
              <button type="button" className="toolbar-btn latex-btn" onClick={insertLatex} title="Insert LaTeX Formula (e.g. $\text{IC}_{50}$)"><Sigma size={14} /> <span>LaTeX</span></button>

              <div className="toolbar-right-actions">
                <button type="button" className="toolbar-switch-btn" onClick={() => setMode('view')}>
                  <Eye size={12} />
                  <span>Preview document</span>
                </button>
              </div>
            </div>

            <textarea
              ref={textareaRef}
              className="synthesis-textarea"
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              onBlur={() => flushSave()}
              placeholder="Write or refine your systematic review synthesis in markdown format (supports LaTeX like $\text{IC}_{50}$ and ASCII hierarchy trees)..."
              spellCheck="true"
            />
          </div>
        ) : (
          <div className="synthesis-viewer-container">
            <div className="viewer-topline-bar">
              <div className="viewer-topline-left">
                <BookOpen size={14} />
                <span>SYSTEMATIC LITERATURE REVIEW SYNTHESIS</span>
              </div>
              <div className="viewer-topline-right">
                <button
                  type="button"
                  className="viewer-quick-copy"
                  onClick={copyToClipboard}
                  title="Copy formatted markdown text"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
                <button
                  type="button"
                  className="viewer-quick-edit"
                  onClick={() => setMode('edit')}
                  title="Switch to editor"
                >
                  <Edit3 size={12} />
                  <span>Edit document</span>
                </button>
              </div>
            </div>

            <div className="viewer-document-body">
              {renderAcademicMarkdown(text, () => setResynthOpen(true), papers.length)}
            </div>
          </div>
        )}
      </div>

      {/* Collapsible Included Studies Panel */}
      <footer className="synthesis-studies-drawer">
        <button
          type="button"
          className="studies-drawer-toggle"
          onClick={() => setIncludedPapersOpen((prev) => !prev)}
        >
          <div className="drawer-title-left">
            <BookOpen size={14} />
            <span>INCLUDED STUDIES IN THIS SYNTHESIS ({papers.length} PAPERS)</span>
          </div>
          <div className="drawer-toggle-right">
            <span>{includedPapersOpen ? 'Hide papers' : 'View papers & extracted data'}</span>
            {includedPapersOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </div>
        </button>

        {includedPapersOpen && (
          <div className="studies-drawer-content">
            <div className="studies-grid">
              {papers.map((paper) => {
                const extractedEntries = paper.extractedData ? Object.entries(paper.extractedData) : []
                return (
                  <article key={paper.id} className="study-card">
                    <header className="study-card-header">
                      <strong className="study-card-title">{paper.title}</strong>
                      <span className="study-card-authors">{paper.authors || 'Unknown authors'} {paper.year ? `(${paper.year})` : ''}</span>
                      {paper.journal && <span className="study-card-journal">{paper.journal}</span>}
                    </header>

                    {extractedEntries.length > 0 && (
                      <div className="study-card-extractions">
                        <span className="extractions-label">EXTRACTED CHARACTERISTICS:</span>
                        <div className="extraction-chips-list">
                          {extractedEntries.map(([fName, val]) => (
                            <div key={fName} className="extraction-chip" title={`${fName}: ${val}`}>
                              <strong>{fName}:</strong> <span>{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {paper.manuscript && onOpenManuscript && (
                      <footer className="study-card-footer">
                        <button
                          type="button"
                          className="button button-secondary study-manuscript-btn"
                          onClick={() => onOpenManuscript(paper)}
                        >
                          <FileText size={12} />
                          <span>View Parsed Manuscript ({paper.manuscript.pageCount} pages)</span>
                        </button>
                      </footer>
                    )}
                  </article>
                )
              })}
            </div>
          </div>
        )}
      </footer>

      {/* Resynthesize Modal */}
      {resynthOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !isResynthesizing) setResynthOpen(false) }}>
          <section className="modal resynth-modal" aria-labelledby="resynth-title">
            <div className="modal-topline">
              <span className="modal-icon"><RotateCcw size={17} /></span>
              <button
                type="button"
                className="icon-button"
                onClick={() => { if (!isResynthesizing) setResynthOpen(false) }}
                title="Close"
                disabled={isResynthesizing}
              >
                <X size={17} />
              </button>
            </div>
            <span className="section-kicker">AI RE-SYNTHESIS · {papers.length} PAPERS</span>
            <h2 id="resynth-title">Re-synthesize with AI</h2>
            <p className="modal-description">
              Regenerate the systematic literature review synthesis from the {papers.length} included papers. You can specify a targeted research focus, comparison themes, or specific analytical questions below.
            </p>

            <label className="field-label" htmlFor="resynth-prompt">
              CUSTOM RESEARCH FOCUS / INSTRUCTIONS <span>Optional</span>
            </label>
            <textarea
              id="resynth-prompt"
              className="text-field criteria-field"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="e.g. Focus deeply on comparing computational complexity, benchmarking dataset limitations, and quantum vs classical scalability..."
              rows={4}
              disabled={isResynthesizing}
            />

            {resynthError && <div className="modal-error"><X size={14} /> {resynthError}</div>}

            <div className="modal-actions">
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setResynthOpen(false)}
                disabled={isResynthesizing}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={triggerResynthesis}
                disabled={isResynthesizing}
              >
                {isResynthesizing ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                <span>{isResynthesizing ? 'Synthesizing literature…' : 'Generate Synthesis'}</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default SynthesisStudio
