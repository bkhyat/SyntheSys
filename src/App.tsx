import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronDown, CircleHelp, ClipboardList, Eye, EyeOff, FileSpreadsheet, FileText, FlaskConical, FolderPlus, ListFilter, LoaderCircle, Plus, Search, SlidersHorizontal, Sparkles, Table2, Trash2, Upload, X } from 'lucide-react'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/browser'
import writeXlsxFile from 'write-excel-file/browser'
import ManuscriptPanel from './ManuscriptPanel'
import SynthesisStudio from './SynthesisStudio'
import type { ManuscriptMetadata } from './types'

type ManualVisibility = 'show' | 'hide'
type VisibilityFilter = 'included' | 'hidden' | 'all'
export type StageType = 'standard' | 'screening' | 'extraction' | 'synthesis'

export type ExtractionField = {
  id: string
  name: string
  description: string
}

export type ExtractedFieldValue = string | { value?: string }

export type Paper = {
  id: string; title: string; authors: string; year: string; journal: string
  doi: string; url: string; abstract: string; score?: number; rationale?: string
  manualVisibility?: ManualVisibility
  extractedData?: Record<string, string>
  manuscript?: ManuscriptMetadata
}
export type PaperRef = {
  id: string; score?: number; rationale?: string
  manualVisibility?: ManualVisibility
  extractedData?: Record<string, string>
}
export type PaperList = {
  id: string
  name: string
  stageType: StageType
  inclusionCriteria?: string
  exclusionCriteria?: string
  extractionFields?: ExtractionField[]
  synthesisText?: string
  synthesisPrompt?: string
  minScore: number
  papers: (Paper | PaperRef)[]
}
type Project = { id: string; name: string; createdAt: string; lists: PaperList[] }
type ScreeningResult = { id: string; score: number; rationale: string }
const LEGACY_STORAGE_KEY = 'fieldnote.projects.v1'
const BATCH_SIZE = 15

const DEFAULT_EXTRACTION_FIELDS: ExtractionField[] = [
  { id: '1', name: 'Architecture', description: 'Architecture of downstream model' },
  { id: '2', name: 'Data Modalities', description: 'The modality of data used by the authors' },
]

function createList(name = 'Stage 1', stageType: StageType = 'standard', options?: Partial<PaperList>): PaperList {
  return {
    id: crypto.randomUUID(),
    name,
    stageType,
    inclusionCriteria: options?.inclusionCriteria ?? '',
    exclusionCriteria: options?.exclusionCriteria ?? '',
    extractionFields: options?.extractionFields ?? (stageType === 'extraction' ? DEFAULT_EXTRACTION_FIELDS : []),
    synthesisText: options?.synthesisText ?? '',
    synthesisPrompt: options?.synthesisPrompt ?? '',
    minScore: options?.minScore ?? 9,
    papers: options?.papers ?? [],
  }
}

function isPaperIncluded(paper: Paper, minScore: number): boolean {
  if (paper.manualVisibility === 'hide') return false
  if (paper.manualVisibility === 'show') return true
  return paper.score === undefined || paper.score >= minScore
}

function readLegacyProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '[]') as Project[] } catch { return [] }
}

function normalizeHeader(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, '') }

function field(row: Record<string, unknown>, ...names: string[]) {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]))
  for (const name of names) {
    const value = normalized.get(normalizeHeader(name))
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }
  return ''
}

function importRows(rows: Record<string, unknown>[]): Paper[] {
  return rows.flatMap((row) => {
    const title = field(row, 'Title', 'Article Title', 'Paper Title', 'Short Title')
    if (!title) return []
    return [{
      id: crypto.randomUUID(), title,
      authors: field(row, 'Author', 'Authors', 'Creator'),
      year: field(row, 'Publication Year', 'Year', 'Date'),
      journal: field(row, 'Publication Title', 'Journal', 'Source', 'Journal Abbreviation'),
      doi: field(row, 'DOI'), url: field(row, 'Url', 'URL', 'Link'),
      abstract: field(row, 'Abstract Note', 'Abstract', 'Summary'),
    }]
  })
}

function paperCount(project: Project) {
  return project.lists[0]?.papers.length ?? 0
}

export function getExtractedFieldValue(fieldVal: ExtractedFieldValue | undefined): string {
  if (!fieldVal) return ''
  if (typeof fieldVal === 'string') return fieldVal
  return fieldVal.value || ''
}

function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [databaseReady, setDatabaseReady] = useState(false)
  const [databaseStatus, setDatabaseStatus] = useState('Connecting to SQLite…')
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('included')

  // Copy Modal State
  const [copyOpen, setCopyOpen] = useState(false)
  const [targetListId, setTargetListId] = useState('')
  const [createTarget, setCreateTarget] = useState(false)
  const [targetListName, setTargetListName] = useState('Stage 2')
  const [targetStageType, setTargetStageType] = useState<StageType>('screening')
  const [inclusionCriteria, setInclusionCriteria] = useState('')
  const [exclusionCriteria, setExclusionCriteria] = useState('')
  const [copyExtractionFields, setCopyExtractionFields] = useState<ExtractionField[]>(DEFAULT_EXTRACTION_FIELDS)
  const [copySynthesisPrompt, setCopySynthesisPrompt] = useState('')
  const [screening, setScreening] = useState(false)
  const [screeningProgress, setScreeningProgress] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extractionProgress, setExtractionProgress] = useState('')
  const [synthesizing, setSynthesizing] = useState(false)
  const [synthesizingProgress, setSynthesizingProgress] = useState('')

  // Stage Configuration Modal State (Create / Edit Stage)
  const [stageModalOpen, setStageModalOpen] = useState(false)
  const [stageModalMode, setStageModalMode] = useState<'create' | 'edit'>('create')
  const [stageModalListId, setStageModalListId] = useState<string | null>(null)
  const [stageDraftName, setStageDraftName] = useState('')
  const [stageDraftType, setStageDraftType] = useState<StageType>('standard')
  const [stageDraftInclusion, setStageDraftInclusion] = useState('')
  const [stageDraftExclusion, setStageDraftExclusion] = useState('')
  const [stageDraftFields, setStageDraftFields] = useState<ExtractionField[]>(DEFAULT_EXTRACTION_FIELDS)
  const [stageDraftSynthesisPrompt, setStageDraftSynthesisPrompt] = useState('')
  const [stageDraftMinScore, setStageDraftMinScore] = useState(9)

  const [creatingProject, setCreatingProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const manuscriptInputRef = useRef<HTMLInputElement>(null)
  const manuscriptTargetRef = useRef<string | null>(null)
  const [uploadingPaperId, setUploadingPaperId] = useState<string | null>(null)
  const [manuscriptPaper, setManuscriptPaper] = useState<Paper | null>(null)

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const activeList = activeProject?.lists.find((list) => list.id === activeListId) ?? null

  useEffect(() => {
    let cancelled = false
    async function loadProjects() {
      try {
        const response = await fetch('/api/projects')
        if (!response.ok) throw new Error('The library database could not be loaded.')
        let savedProjects = await response.json() as Project[]
        const legacyProjects = readLegacyProjects()
        if (!savedProjects.length && legacyProjects.length) {
          const migration = await fetch('/api/projects', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(legacyProjects),
          })
          if (!migration.ok) throw new Error('Could not migrate the libraries saved in this browser.')
          savedProjects = await migration.json() as Project[]
          localStorage.removeItem(LEGACY_STORAGE_KEY)
        }
        if (!cancelled) {
          setProjects(savedProjects)
          setDatabaseStatus('SQLite database')
          setDatabaseReady(true)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'The library database could not be loaded.')
          setDatabaseStatus('Database unavailable')
        }
      }
    }
    void loadProjects()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!databaseReady) return
    const snapshot = JSON.stringify(projects)
    const timer = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        const response = await fetch('/api/projects', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: snapshot,
        })
        if (!response.ok) throw new Error('Changes could not be saved to the database.')
        setDatabaseStatus('SQLite database')
      }).catch((saveError: unknown) => {
        setDatabaseStatus('Save failed')
        setError(saveError instanceof Error ? saveError.message : 'Changes could not be saved.')
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [databaseReady, projects])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => { setSelectedIds(new Set()); setSearch(''); setVisibilityFilter('included') }, [activeListId])

  // Master paper lookup map from Stage 1 (the default stage for the library)
  const masterPapersMap = useMemo(() => {
    const masterList = activeProject?.lists[0]
    if (!masterList) return new Map<string, Paper>()
    const map = new Map<string, Paper>()
    for (const item of masterList.papers as Paper[]) {
      map.set(item.id, item)
    }
    return map
  }, [activeProject?.lists])

  // Resolved paper list for the currently active stage
  const resolvedActiveListPapers = useMemo<Paper[]>(() => {
    if (!activeList || !activeProject) return []
    const isMaster = activeProject.lists[0]?.id === activeList.id
    if (isMaster) {
      return activeList.papers as Paper[]
    }
    return activeList.papers.map((entry) => {
      const master = masterPapersMap.get(entry.id)
      if (master) {
        return {
          ...master,
          score: entry.score,
          rationale: entry.rationale,
          manualVisibility: entry.manualVisibility,
          extractedData: entry.extractedData ?? master.extractedData,
        }
      }
      return entry as Paper
    })
  }, [activeList, activeProject, masterPapersMap])

  const visiblePapers = useMemo(() => {
    if (!activeList) return []
    const query = search.trim().toLowerCase()
    return resolvedActiveListPapers.filter((paper) => {
      const matchesSearch = !query || [paper.title, paper.authors, paper.journal, paper.doi].some((value) => value && value.toLowerCase().includes(query))
      if (!matchesSearch) return false
      const included = isPaperIncluded(paper, activeList.minScore)
      if (visibilityFilter === 'included') return included
      if (visibilityFilter === 'hidden') return !included
      return true
    })
  }, [activeList, resolvedActiveListPapers, search, visibilityFilter])

  const includedCount = useMemo(() => {
    if (!activeList) return 0
    return resolvedActiveListPapers.filter((paper) => isPaperIncluded(paper, activeList.minScore)).length
  }, [activeList, resolvedActiveListPapers])

  const hiddenCount = useMemo(() => {
    if (!activeList) return 0
    return resolvedActiveListPapers.filter((paper) => !isPaperIncluded(paper, activeList.minScore)).length
  }, [activeList, resolvedActiveListPapers])

  const selectedPapers = useMemo(() => {
    return resolvedActiveListPapers.filter((paper) => selectedIds.has(paper.id))
  }, [resolvedActiveListPapers, selectedIds])

  const selectedPapersWithManuscripts = useMemo(() => {
    return selectedPapers.filter((paper) => Boolean(paper.manuscript))
  }, [selectedPapers])

  const allVisibleSelected = visiblePapers.length > 0 && visiblePapers.every((paper) => selectedIds.has(paper.id))
  const screenedCount = useMemo(() => {
    return resolvedActiveListPapers.filter((paper) => paper.score !== undefined).length
  }, [resolvedActiveListPapers])

  // Destination Stage in copy dialog
  const selectedTargetList = useMemo(() => {
    if (createTarget || !activeProject) return null
    return activeProject.lists.find((list) => list.id === targetListId) ?? null
  }, [activeProject, createTarget, targetListId])

  // Sync copy modal criteria/fields whenever target stage changes
  useEffect(() => {
    if (selectedTargetList) {
      setTargetStageType(selectedTargetList.stageType ?? 'standard')
      setInclusionCriteria(selectedTargetList.inclusionCriteria ?? '')
      setExclusionCriteria(selectedTargetList.exclusionCriteria ?? '')
      if (selectedTargetList.extractionFields && selectedTargetList.extractionFields.length > 0) {
        setCopyExtractionFields(selectedTargetList.extractionFields)
      } else {
        setCopyExtractionFields(DEFAULT_EXTRACTION_FIELDS)
      }
    }
  }, [selectedTargetList])

  function updateProject(projectId: string, update: (project: Project) => Project) {
    setProjects((current) => current.map((project) => project.id === projectId ? update(project) : project))
  }

  function togglePaperVisibility(paperId: string) {
    if (!activeProject || !activeList) return
    const currentPaper = resolvedActiveListPapers.find((p) => p.id === paperId)
    if (!currentPaper) return

    const currentlyIncluded = isPaperIncluded(currentPaper, activeList.minScore)
    const nextVisibility: ManualVisibility = currentlyIncluded ? 'hide' : 'show'

    updateProject(activeProject.id, (project) => ({
      ...project,
      lists: project.lists.map((list, idx) => {
        if (list.id === activeList.id) {
          if (idx === 0) {
            return {
              ...list,
              papers: (list.papers as Paper[]).map((paper) => paper.id === paperId ? { ...paper, manualVisibility: nextVisibility } : paper),
            }
          }
          return {
            ...list,
            papers: (list.papers as PaperRef[]).map((paperRef) => paperRef.id === paperId ? { ...paperRef, manualVisibility: nextVisibility } : paperRef),
          }
        }
        return list
      }),
    }))
    setToast(`1 paper ${nextVisibility === 'hide' ? 'hidden from' : 'shown in'} ${activeList.name}`)
  }

  function setSelectionVisibility(visibility: ManualVisibility) {
    if (!activeProject || !activeList || selectedIds.size === 0) return
    const count = selectedIds.size
    updateProject(activeProject.id, (project) => ({
      ...project,
      lists: project.lists.map((list, idx) => {
        if (list.id === activeList.id) {
          if (idx === 0) {
            return {
              ...list,
              papers: (list.papers as Paper[]).map((paper) => selectedIds.has(paper.id) ? { ...paper, manualVisibility: visibility } : paper),
            }
          }
          return {
            ...list,
            papers: (list.papers as PaperRef[]).map((paperRef) => selectedIds.has(paperRef.id) ? { ...paperRef, manualVisibility: visibility } : paperRef),
          }
        }
        return list
      }),
    }))
    setSelectedIds(new Set())
    setToast(`${count.toLocaleString()} ${count === 1 ? 'paper' : 'papers'} ${visibility === 'hide' ? 'hidden' : 'shown'}`)
  }

  function createProject() {
    const name = projectName.trim()
    if (!name) return
    const project: Project = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), lists: [createList('Stage 1', 'standard')] }
    setProjects((current) => [...current, project])
    setActiveProjectId(project.id); setActiveListId(project.lists[0].id)
    setProjectName(''); setCreatingProject(false)
  }

  // Open Create Stage Modal
  function openCreateStageModal() {
    if (!activeProject) return
    const nextNum = activeProject.lists.length + 1
    setStageModalMode('create')
    setStageModalListId(null)
    setStageDraftName(`Stage ${nextNum}`)
    setStageDraftType(nextNum === 2 ? 'screening' : nextNum === 3 ? 'extraction' : nextNum === 4 ? 'synthesis' : 'standard')
    setStageDraftInclusion('')
    setStageDraftExclusion('')
    setStageDraftFields(DEFAULT_EXTRACTION_FIELDS)
    setStageDraftSynthesisPrompt('')
    setStageDraftMinScore(9)
    setError('')
    setStageModalOpen(true)
  }

  // Open Edit Stage Configuration Modal
  function openEditStageModal(list: PaperList) {
    setStageModalMode('edit')
    setStageModalListId(list.id)
    setStageDraftName(list.name)
    setStageDraftType(list.stageType ?? 'standard')
    setStageDraftInclusion(list.inclusionCriteria ?? '')
    setStageDraftExclusion(list.exclusionCriteria ?? '')
    setStageDraftFields(list.extractionFields && list.extractionFields.length > 0 ? list.extractionFields : DEFAULT_EXTRACTION_FIELDS)
    setStageDraftSynthesisPrompt(list.synthesisPrompt ?? '')
    setStageDraftMinScore(list.minScore ?? 9)
    setError('')
    setStageModalOpen(true)
  }

  // Save Stage from Configuration Modal
  function saveStageModal() {
    if (!activeProject) return
    const name = stageDraftName.trim()
    if (!name) {
      setError('Stage name is required.')
      return
    }
    const cleanFields = stageDraftFields.filter((f) => f.name.trim())

    if (stageModalMode === 'create') {
      const newList = createList(name, stageDraftType, {
        inclusionCriteria: stageDraftInclusion.trim(),
        exclusionCriteria: stageDraftExclusion.trim(),
        extractionFields: stageDraftType === 'extraction' ? cleanFields : [],
        synthesisPrompt: stageDraftSynthesisPrompt.trim(),
        minScore: stageDraftMinScore,
      })
      updateProject(activeProject.id, (project) => ({
        ...project,
        lists: [...project.lists, newList],
      }))
      setActiveListId(newList.id)
      const typeLabel = stageDraftType === 'screening' ? 'AI Screening' : stageDraftType === 'extraction' ? 'AI Data Extraction' : stageDraftType === 'synthesis' ? 'AI Synthesis' : 'Standard'
      setToast(`Created ${name} (${typeLabel})`)
    } else if (stageModalMode === 'edit' && stageModalListId) {
      updateProject(activeProject.id, (project) => ({
        ...project,
        lists: project.lists.map((list) => {
          if (list.id === stageModalListId) {
            return {
              ...list,
              name,
              stageType: stageDraftType,
              inclusionCriteria: stageDraftInclusion.trim(),
              exclusionCriteria: stageDraftExclusion.trim(),
              extractionFields: stageDraftType === 'extraction' ? cleanFields : list.extractionFields,
              synthesisPrompt: stageDraftSynthesisPrompt.trim(),
              minScore: stageDraftMinScore,
            }
          }
          return list
        }),
      }))
      setToast(`Updated configuration for ${name}`)
    }
    setStageModalOpen(false)
  }

  async function handleFile(file?: File) {
    if (!file || !activeProject || !activeList) return
    setError('')
    try {
      let rows: Record<string, unknown>[]
      if (file.name.toLowerCase().endsWith('.csv')) {
        const parsed = Papa.parse<Record<string, unknown>>(await file.text(), {
          header: true,
          skipEmptyLines: 'greedy',
          transformHeader: (header) => header.trim(),
        })
        if (parsed.errors.length) throw new Error(parsed.errors[0].message)
        rows = parsed.data
      } else {
        const sheets = await readXlsxFile(file)
        const sheetRows = sheets[0]?.data ?? []
        const headers = (sheetRows.shift() ?? []).map((value) => String(value ?? '').trim())
        rows = sheetRows.map((values) => Object.fromEntries(
          headers.flatMap((header, index) => header ? [[header, values[index] ?? '']] : []),
        ))
      }
      const imported = importRows(rows)
      if (!imported.length) { setError('No titled papers found. Check that the first row contains a Title column.'); return }

      const isMaster = activeProject.lists[0]?.id === activeList.id
      updateProject(activeProject.id, (project) => {
        const masterList = project.lists[0]
        if (!masterList) return project
        const updatedMasterPapers = [...masterList.papers, ...imported]
        return {
          ...project,
          lists: project.lists.map((list, idx) => {
            if (idx === 0) {
              return { ...list, papers: updatedMasterPapers }
            }
            if (!isMaster && list.id === activeList.id) {
              const newRefs: PaperRef[] = imported.map((p) => ({ id: p.id }))
              return { ...list, papers: [...list.papers, ...newRefs] }
            }
            return list
          }),
        }
      })
      setToast(`${imported.length.toLocaleString()} papers added to ${activeList.name}`)
    } catch { setError('This file could not be read. Upload a valid CSV or Excel workbook.') }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function chooseManuscriptFile(paperId: string) {
    manuscriptTargetRef.current = paperId
    manuscriptInputRef.current?.click()
  }

  async function handleManuscriptFile(file?: File) {
    const paperId = manuscriptTargetRef.current
    manuscriptTargetRef.current = null
    if (!file || !paperId || !activeProject) return
    setError('')
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Attach a PDF manuscript.')
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('PDF manuscripts must be 50 MB or smaller.')
      return
    }

    setUploadingPaperId(paperId)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(`/api/papers/${encodeURIComponent(paperId)}/manuscript`, {
        method: 'POST',
        body: formData,
      })
      const payload = await response.json() as {
        paper_id?: string; file_name?: string; page_count?: number; line_count?: number
        extracted_at?: string; warnings?: string[]; detail?: string
      }
      if (!response.ok) throw new Error(payload.detail || 'Could not attach this PDF.')
      const manuscript: ManuscriptMetadata = {
        fileName: payload.file_name ?? file.name,
        pageCount: payload.page_count ?? 0,
        lineCount: payload.line_count ?? 0,
        extractedAt: payload.extracted_at ?? new Date().toISOString(),
        warnings: payload.warnings ?? [],
      }
      updateProject(activeProject.id, (project) => ({
        ...project,
        lists: project.lists.map((list, idx) => {
          if (idx === 0) {
            return {
              ...list,
              papers: list.papers.map((paper) => paper.id === paperId ? { ...paper, manuscript } : paper),
            }
          }
          return list
        }),
      }))
      setToast(`${manuscript.fileName} parsed and attached`)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not attach this PDF.')
    } finally {
      setUploadingPaperId(null)
      if (manuscriptInputRef.current) manuscriptInputRef.current.value = ''
    }
  }

  function openCopyDialog() {
    if (!activeProject || !activeList || !selectedPapers.length) return
    const other = activeProject.lists.find((list) => list.id !== activeList.id)
    setTargetListId(other?.id ?? '')
    setCreateTarget(!other)
    setTargetListName(`Stage ${activeProject.lists.length + 1}`)
    if (other) {
      setTargetStageType(other.stageType ?? 'standard')
      setInclusionCriteria(other.inclusionCriteria ?? '')
      setExclusionCriteria(other.exclusionCriteria ?? '')
      setCopyExtractionFields(other.extractionFields?.length ? other.extractionFields : DEFAULT_EXTRACTION_FIELDS)
      setCopySynthesisPrompt(other.synthesisPrompt ?? '')
    } else {
      setTargetStageType('screening')
      setInclusionCriteria('')
      setExclusionCriteria('')
      setCopyExtractionFields(DEFAULT_EXTRACTION_FIELDS)
      setCopySynthesisPrompt('')
    }
    setError('')
    setCopyOpen(true)
  }

  async function transferSelected(action: 'auto' | 'copy-only') {
    if (!activeProject || !activeList || !selectedPapers.length) return

    const destinationId = createTarget ? crypto.randomUUID() : targetListId
    const destinationName = createTarget ? targetListName.trim() : activeProject.lists.find((list) => list.id === destinationId)?.name
    if (!destinationName) { setError('Choose a destination stage or create a new one.'); return }

    const effectiveStageType = createTarget ? targetStageType : (selectedTargetList?.stageType ?? 'standard')
    const shouldScreen = action === 'auto' && effectiveStageType === 'screening'
    const shouldExtract = action === 'auto' && effectiveStageType === 'extraction'
    const shouldSynthesize = action === 'auto' && effectiveStageType === 'synthesis'

    if (shouldScreen && !inclusionCriteria.trim()) {
      setError('Add inclusion criteria for screening.')
      return
    }

    const validExtractionFields = copyExtractionFields.filter((f) => f.name.trim())
    if (shouldExtract && !validExtractionFields.length) {
      setError('Specify at least one data extraction field.')
      return
    }

    setError('')
    let evaluatedPapers = selectedPapers
    let generatedSynthesisText = ''

    if (shouldScreen) {
      setScreening(true)
      try {
        const results: ScreeningResult[] = []
        for (let offset = 0; offset < selectedPapers.length; offset += BATCH_SIZE) {
          const batch = selectedPapers.slice(offset, offset + BATCH_SIZE)
          setScreeningProgress(`Screening ${Math.min(offset + batch.length, selectedPapers.length)} of ${selectedPapers.length}`)
          const response = await fetch('/api/screen', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ papers: batch, inclusionCriteria, exclusionCriteria }),
          })
          const payload = await response.json() as { results?: ScreeningResult[]; error?: string }
          if (!response.ok) throw new Error(payload.error || 'Screening request failed.')
          results.push(...(payload.results ?? []))
        }
        const byId = new Map(results.map((result) => [result.id, result]))
        evaluatedPapers = selectedPapers.map((paper) => {
          const result = byId.get(paper.id)
          return result ? { ...paper, score: result.score, rationale: result.rationale } : paper
        })
      } catch (screenError) {
        setError(screenError instanceof Error ? screenError.message : 'Screening failed. Try again.')
        setScreening(false); setScreeningProgress(''); return
      }
      setScreening(false); setScreeningProgress('')
    } else if (shouldExtract) {
      const papersWithDoc = selectedPapers.filter((p) => Boolean(p.manuscript))
      if (papersWithDoc.length > 0) {
        setExtracting(true)
        try {
          const resultsMap = new Map<string, Record<string, string>>()
          const extractionErrors: string[] = []
          const EXTRACTION_BATCH_SIZE = 4

          for (let offset = 0; offset < papersWithDoc.length; offset += EXTRACTION_BATCH_SIZE) {
            const batch = papersWithDoc.slice(offset, offset + EXTRACTION_BATCH_SIZE)
            setExtractionProgress(
              `Extracting data (${Math.min(offset + batch.length, papersWithDoc.length)} of ${papersWithDoc.length} papers)…`
            )
            try {
              const response = await fetch('/api/extract-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  papers: batch.map((p) => ({ id: p.id, title: p.title })),
                  fields: validExtractionFields.map((f) => ({ name: f.name.trim(), description: f.description.trim() })),
                }),
              })
              const payload = await response.json() as { results?: { id: string; data: Record<string, string>; error?: string }[]; error?: string }
              if (!response.ok) {
                throw new Error(payload.error || 'Data extraction request failed.')
              }
              for (const r of payload.results ?? []) {
                if (r.error) {
                  const pMatch = batch.find((p) => p.id === r.id)
                  extractionErrors.push(`"${(pMatch?.title || r.id).slice(0, 30)}…": ${r.error}`)
                }
                if (r.data && Object.keys(r.data).length > 0) {
                  resultsMap.set(r.id, r.data)
                }
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Extraction request failed.'
              extractionErrors.push(msg)
            }
          }

          if (extractionErrors.length > 0) {
            setError(`Data extraction notices:\n${extractionErrors.join('\n')}`)
          }
          evaluatedPapers = selectedPapers.map((paper) => {
            const data = resultsMap.get(paper.id)
            return data ? { ...paper, extractedData: data } : paper
          })
        } catch (extractError) {
          setError(extractError instanceof Error ? extractError.message : 'Data extraction failed. Try again.')
        } finally {
          setExtracting(false)
          setExtractionProgress('')
        }
      }
    } else if (shouldSynthesize) {
      setSynthesizing(true)
      setSynthesizingProgress(`Synthesizing literature review for ${selectedPapers.length} papers…`)
      try {
        const response = await fetch('/api/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            papers: selectedPapers.map((p) => ({
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
            sourceStageName: activeList.name,
            synthesisPrompt: copySynthesisPrompt.trim(),
          }),
        })
        const payload = (await response.json()) as { synthesis?: string; error?: string }
        if (!response.ok || !payload.synthesis) {
          throw new Error(payload.error || 'Failed to synthesize literature.')
        }
        generatedSynthesisText = payload.synthesis
      } catch (synthError) {
        setError(synthError instanceof Error ? synthError.message : 'Synthesis generation failed. Try again.')
        setSynthesizing(false)
        setSynthesizingProgress('')
        return
      } finally {
        setSynthesizing(false)
        setSynthesizingProgress('')
      }
    }

    // Additional stages store reference and stage-specific score/rationale/manualVisibility/extractedData
    const newRefs: PaperRef[] = evaluatedPapers.map((paper) => {
      const ref: PaperRef = { id: paper.id }
      if (paper.score !== undefined) ref.score = paper.score
      if (paper.rationale) ref.rationale = paper.rationale
      if (paper.manualVisibility) ref.manualVisibility = paper.manualVisibility
      if (paper.extractedData) ref.extractedData = paper.extractedData
      return ref
    })

    const destination: PaperList = {
      id: destinationId,
      name: destinationName,
      stageType: effectiveStageType,
      inclusionCriteria: shouldScreen ? inclusionCriteria.trim() : (createTarget ? inclusionCriteria.trim() : (selectedTargetList?.inclusionCriteria ?? '')),
      exclusionCriteria: shouldScreen ? exclusionCriteria.trim() : (createTarget ? exclusionCriteria.trim() : (selectedTargetList?.exclusionCriteria ?? '')),
      extractionFields: shouldExtract ? validExtractionFields : (createTarget ? (effectiveStageType === 'extraction' ? validExtractionFields : []) : (selectedTargetList?.extractionFields ?? [])),
      synthesisText: shouldSynthesize ? generatedSynthesisText : (selectedTargetList?.synthesisText ?? ''),
      synthesisPrompt: shouldSynthesize ? copySynthesisPrompt.trim() : (createTarget ? copySynthesisPrompt.trim() : (selectedTargetList?.synthesisPrompt ?? '')),
      minScore: createTarget ? 9 : (selectedTargetList?.minScore ?? 9),
      papers: [],
    }

    const copiedCount = evaluatedPapers.length
    updateProject(activeProject.id, (project) => {
      const lists = createTarget ? [...project.lists, destination] : project.lists
      return {
        ...project,
        lists: lists.map((list) => {
          if (list.id === destinationId) {
            const existing = list.papers
            const merged = [...existing, ...newRefs.filter((nr) => !existing.some((ex) => ex.id === nr.id))]
            return {
              ...list,
              papers: merged,
              // Update criteria, fields, or synthesis if user tweaked them during copy
              ...(shouldScreen ? { inclusionCriteria: inclusionCriteria.trim(), exclusionCriteria: exclusionCriteria.trim() } : {}),
              ...(shouldExtract ? { extractionFields: validExtractionFields } : {}),
              ...(shouldSynthesize ? { synthesisText: generatedSynthesisText, synthesisPrompt: copySynthesisPrompt.trim() } : {}),
            }
          }
          return list
        }),
      }
    })

    setActiveListId(destinationId); setSelectedIds(new Set()); setCopyOpen(false)
    const actionLabel = shouldSynthesize ? 'synthesized and copied' : (shouldScreen ? 'screened and copied' : (shouldExtract ? 'extracted data and copied' : 'copied'))
    setToast(`${copiedCount} papers ${actionLabel} to ${destinationName}`)
  }

  function togglePaper(id: string) {
    setSelectedIds((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) visiblePapers.forEach((paper) => next.delete(paper.id))
      else visiblePapers.forEach((paper) => next.add(paper.id))
      return next
    })
  }

  const averageScore = screenedCount && activeList ? (resolvedActiveListPapers.reduce((sum, paper) => sum + (paper.score ?? 0), 0) / screenedCount).toFixed(1) : '—'

  // Extraction columns for active stage
  const activeExtractionFields = useMemo(() => {
    return (activeList?.extractionFields && activeList.extractionFields.length > 0) ? activeList.extractionFields : []
  }, [activeList])

  // Download stage table in CSV or Excel format
  async function exportStageData(format: 'csv' | 'xlsx') {
    if (!activeProject || !activeList || !visiblePapers.length) {
      setError('No papers in this stage to export.')
      return
    }

    const cleanStageName = activeList.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'Stage'
    const cleanProjectName = activeProject.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'Library'
    const fileName = `${cleanProjectName}_${cleanStageName}`

    const hasScore = activeList.stageType === 'screening' || visiblePapers.some((p) => p.score !== undefined)
    const extractionCols = activeExtractionFields

    if (format === 'csv') {
      const csvRows = visiblePapers.map((paper) => {
        const row: Record<string, string | number> = {
          'Title': paper.title,
          'Authors': paper.authors || '',
          'Year': paper.year || '',
          'Journal / Source': paper.journal || '',
          'DOI': paper.doi || '',
          'URL': paper.url || '',
          'Abstract': paper.abstract || '',
        }

        if (hasScore) {
          row['Inclusion Score'] = paper.score !== undefined ? paper.score : ''
          row['AI Screening Rationale'] = paper.rationale || ''
        }

        for (const f of extractionCols) {
          const raw = paper.extractedData ? paper.extractedData[f.name] : undefined
          const val = getExtractedFieldValue(raw)
          row[f.name] = val
        }

        row['Visibility in Stage'] = isPaperIncluded(paper, activeList.minScore) ? 'Included' : 'Hidden'
        row['Has Attached Manuscript'] = paper.manuscript ? 'Yes' : 'No'
        return row
      })

      const csvContent = Papa.unparse(csvRows)
      const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `${fileName}.csv`)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setToast(`Exported ${visiblePapers.length} papers from ${activeList.name} as CSV`)
    } else {
      try {
        const headerRow = [
          { value: 'Title', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'Authors', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'Year', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'Journal / Source', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'DOI', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'URL', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'Abstract', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
        ]

        if (hasScore) {
          headerRow.push(
            { value: 'Inclusion Score', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'AI Screening Rationale', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          )
        }

        for (const f of extractionCols) {
          headerRow.push({ value: f.name, fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' })
        }

        headerRow.push(
          { value: 'Visibility in Stage', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
          { value: 'Has Attached Manuscript', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
        )

        const rows: (string | number | { value: string | number; fontWeight?: 'bold'; backgroundColor?: string })[][] = [headerRow]

        for (const paper of visiblePapers) {
          const row: (string | number)[] = [
            paper.title,
            paper.authors || '',
            paper.year || '',
            paper.journal || '',
            paper.doi || '',
            paper.url || '',
            paper.abstract || '',
          ]

          if (hasScore) {
            row.push(
              paper.score !== undefined ? paper.score : '',
              paper.rationale || '',
            )
          }

          for (const f of extractionCols) {
            const raw = paper.extractedData ? paper.extractedData[f.name] : undefined
            const val = getExtractedFieldValue(raw)
            row.push(val)
          }

          row.push(
            isPaperIncluded(paper, activeList.minScore) ? 'Included' : 'Hidden',
            paper.manuscript ? 'Yes' : 'No',
          )

          rows.push(row)
        }

        const blob = (await writeXlsxFile(rows as any)) as unknown as Blob
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.setAttribute('download', `${fileName}.xlsx`)
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
        setToast(`Exported ${visiblePapers.length} papers from ${activeList.name} as Excel workbook (.xlsx)`)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not generate Excel export.')
      }
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => { setActiveProjectId(null); setActiveListId(null) }} aria-label="Fieldnote home"><span className="brand-mark"><FlaskConical size={17} strokeWidth={2.2} /></span><span>fieldnote<span className="brand-period">.</span></span></button>
      <div className="side-label">WORKSPACE</div>
      <button className={`nav-link ${!activeProject ? 'active' : ''}`} onClick={() => { setActiveProjectId(null); setActiveListId(null) }}><BookOpen size={16} /><span>All libraries</span><span className="nav-count">{projects.length}</span></button>
      <div className="side-label project-label">YOUR LIBRARIES</div>
      <div className="project-nav">{projects.map((project) => <button key={project.id} className={`nav-link project-nav-link ${project.id === activeProjectId ? 'active' : ''}`} onClick={() => { setActiveProjectId(project.id); setActiveListId(project.lists[0]?.id ?? null) }}><span className="project-dot" /><span className="project-nav-name">{project.name}</span><span className="nav-count">{paperCount(project)}</span></button>)}</div>
      <button className="new-project-link" onClick={() => setCreatingProject(true)}><Plus size={15} /> New library</button>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="note-symbol">fn</span><span>Evidence, organized.</span></div><div className="sidebar-version">REVIEW WORKSPACE <span>v0.1</span></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ArrowRight size={13} /><strong>{activeProject?.name ?? 'All libraries'}</strong></div><div className="topbar-right"><span className="local-indicator"><span /> {databaseStatus}</span><button className="icon-button help-button" title="About Fieldnote"><CircleHelp size={17} /></button></div></header>

      {!activeProject ? <section className="projects-page page-enter">
        <div className="page-eyebrow"><span className="eyebrow-line" /> EVIDENCE REVIEW WORKSPACE</div>
        <div className="page-heading-row"><div><h1>Your research,<br /><em>in clear stages.</em></h1><p className="page-intro">Build a transparent path from search results to a focused evidence set.</p></div><button className="button button-primary" onClick={() => setCreatingProject(true)}><Plus size={16} /> New library</button></div>
        <div className="section-heading"><div><span className="section-kicker">COLLECTION</span><h2>Libraries <span className="heading-count">{projects.length}</span></h2></div></div>
        {projects.length ? <div className="projects-table"><div className="projects-table-head"><span>LIBRARY</span><span>PAPERS</span><span>STAGES</span><span>CREATED</span><span /></div>{projects.map((project, index) => <button className="project-row" key={project.id} onClick={() => { setActiveProjectId(project.id); setActiveListId(project.lists[0]?.id ?? null) }} style={{ animationDelay: `${index * 45}ms` }}><span className="project-title-cell"><span className="project-icon"><ClipboardList size={17} /></span><span><strong>{project.name}</strong><small>{project.lists[0]?.name ?? 'No stages yet'}</small></span></span><span className="project-number">{paperCount(project).toLocaleString()}</span><span className="project-number">{project.lists.length}</span><span className="project-date">{new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span className="row-arrow"><ArrowRight size={16} /></span></button>)}</div> : <div className="empty-projects"><div className="empty-graphic"><span className="empty-sheet"><FileSpreadsheet size={23} /></span><span className="empty-spark"><Sparkles size={16} /></span></div><span className="section-kicker">A GOOD PLACE TO BEGIN</span><h3>Start with a research question.</h3><p>Create a library, bring in your search results, and shape a screening workflow that stays easy to review.</p><button className="button button-primary" onClick={() => setCreatingProject(true)}><FolderPlus size={16} /> Create your first library</button></div>}
        <div className="bottom-caption"><span>FIELDNOTE / 01</span><span>MAKE THE EVIDENCE TRACEABLE</span></div>
      </section> : <section className="review-page page-enter">
        <div className="review-dashboard-header">
          <div className="review-heading">
            <div>
              <div className="page-eyebrow"><span className="eyebrow-line" /> REVIEW LIBRARY</div>
              <h1 className="review-title">{activeProject.name}</h1>
              <p className="review-subtitle">A working evidence set, one decision at a time.</p>
            </div>
            <button className="button button-primary upload-top" onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} /> Upload papers
            </button>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv,.xlsx" onChange={(event) => void handleFile(event.target.files?.[0])} />
          </div>
          <div className="stats-strip">
            <div className="stat-cell">
              <span className="stat-label">IN THIS LIBRARY</span>
              <strong>{paperCount(activeProject).toLocaleString()}</strong>
              <span className="stat-hint">unique papers in Stage 1 across {activeProject.lists.length} {activeProject.lists.length === 1 ? 'stage' : 'stages'}</span>
            </div>
            <div className="stat-cell">
              <span className="stat-label">INCLUDED IN STAGE</span>
              <strong>{includedCount.toLocaleString()}</strong>
              <span className="stat-hint">{hiddenCount > 0 ? `${hiddenCount} hidden at score ${activeList?.minScore ?? 9}+` : `${activeList?.name ?? 'Current stage'}`}</span>
            </div>
            <div className="stat-cell">
              <span className="stat-label">SCREENED</span>
              <strong>{screenedCount.toLocaleString()}</strong>
              <span className="stat-hint">average score <b>{averageScore}</b> / 10</span>
            </div>
            <div className="stat-aside">
              <span className="stat-aside-mark"><ListFilter size={16} /></span>
              <span>Title + abstract<br />screening</span>
            </div>
          </div>
          
          {/* Stage Navigation Tabs */}
          <div className="list-navigation">
            <div className="list-tabs" role="tablist" aria-label="Library stages">
              {activeProject.lists.map((list) => {
                const isScreening = list.stageType === 'screening'
                const isExtraction = list.stageType === 'extraction'
                const isSynthesis = list.stageType === 'synthesis'
                return (
                  <button
                    key={list.id}
                    role="tab"
                    aria-selected={list.id === activeListId}
                    className={`list-tab ${list.id === activeListId ? 'selected' : ''}`}
                    onClick={() => setActiveListId(list.id)}
                    title={isScreening ? `${list.name} (AI Screening)` : isExtraction ? `${list.name} (AI Data Extraction)` : isSynthesis ? `${list.name} (AI Synthesis)` : `${list.name} (Standard)`}
                  >
                    {isScreening && <Sparkles size={11} className="tab-stage-type-icon screening-icon" />}
                    {isExtraction && <Table2 size={11} className="tab-stage-type-icon extraction-icon" />}
                    {isSynthesis && <BookOpen size={11} className="tab-stage-type-icon synthesis-icon" />}
                    <span>{list.name}</span>
                    <span className="tab-count">{list.papers.length}</span>
                  </button>
                )
              })}
              <button className="add-list-tab" title="Create a new stage with AI screening, data extraction, or synthesis" onClick={openCreateStageModal}>
                <Plus size={15} />
              </button>
            </div>
            <div className="stage-caption-row">
              <span className="stage-caption">STAGE <ArrowRight size={12} /> {activeList?.name.toUpperCase()}</span>
            </div>
          </div>
        </div>

        {/* Scrollable Stage Content Area below the Stage Tabs */}
        <div className="review-stage-scroll-area">
          {activeList ? <>
            <div className="list-toolbar">
              <div className="list-title-wrap">
                <h2>{activeList.name}</h2>
              
              {/* Stage Type Tag */}
              {activeList.stageType === 'screening' && (
                <span className="stage-badge-pill screening-badge-pill" title={`Inclusion: ${activeList.inclusionCriteria || 'Configured'}`}>
                  <Sparkles size={11} /> AI Screening Stage
                </span>
              )}
              {activeList.stageType === 'extraction' && (
                <span className="stage-badge-pill extraction-badge-pill" title={`${activeExtractionFields.length} extraction columns active`}>
                  <Table2 size={11} /> AI Extraction ({activeExtractionFields.length} fields)
                </span>
              )}
              {activeList.stageType === 'synthesis' && (
                <span className="stage-badge-pill synthesis-badge-pill" title="Systematic literature review synthesis workspace">
                  <BookOpen size={11} /> AI Synthesis Stage
                </span>
              )}

              {/* Stage Settings / Configure Button */}
              <button
                type="button"
                className="stage-settings-btn"
                onClick={() => openEditStageModal(activeList)}
                title="Configure stage purpose, screening criteria, data extraction columns, or synthesis focus"
              >
                <SlidersHorizontal size={13} /> Stage Settings
              </button>
            </div>

            {activeList.stageType !== 'synthesis' && (
              <div className="toolbar-actions">
                <div className="visibility-filter-tabs" role="group" aria-label="Filter visibility">
                  <button type="button" className={`visibility-filter-tab ${visibilityFilter === 'included' ? 'active' : ''}`} onClick={() => setVisibilityFilter('included')} title="Show papers matching inclusion score and manually shown"><Eye size={13} /><span>Included</span><span className="tab-pill-count">{includedCount}</span></button>
                  <button type="button" className={`visibility-filter-tab ${visibilityFilter === 'hidden' ? 'active' : ''}`} onClick={() => setVisibilityFilter('hidden')} title="Show papers below score threshold or manually hidden"><EyeOff size={13} /><span>Hidden</span><span className="tab-pill-count">{hiddenCount}</span></button>
                  <button type="button" className={`visibility-filter-tab ${visibilityFilter === 'all' ? 'active' : ''}`} onClick={() => setVisibilityFilter('all')} title="Show all papers in this stage"><span>All</span><span className="tab-pill-count">{resolvedActiveListPapers.length}</span></button>
                </div>
                {resolvedActiveListPapers.some((paper) => paper.score !== undefined) && (
                  <label className="score-filter">
                    <span>INCLUSION SCORE</span>
                    <input type="range" min="0" max="10" step="1" value={activeList.minScore} onChange={(event) => updateProject(activeProject.id, (project) => ({ ...project, lists: project.lists.map((list) => list.id === activeList.id ? { ...list, minScore: Number(event.target.value) } : list) }))} />
                    <strong>{activeList.minScore}+</strong>
                  </label>
                )}
                <label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search papers" aria-label="Search papers" /><kbd>/</kbd></label>
              </div>
            )}
          </div>

          {error && !copyOpen && !stageModalOpen && (
            <div className="inline-error"><span>{error}</span><button className="icon-button" title="Dismiss" onClick={() => setError('')}><X size={15} /></button></div>
          )}

          {activeList.stageType === 'synthesis' ? (
            <SynthesisStudio
              list={activeList}
              papers={resolvedActiveListPapers}
              onUpdateSynthesis={(newText, newPrompt) => {
                updateProject(activeProject.id, (project) => ({
                  ...project,
                  lists: project.lists.map((l) =>
                    l.id === activeList.id
                      ? { ...l, synthesisText: newText, ...(newPrompt !== undefined ? { synthesisPrompt: newPrompt } : {}) }
                      : l
                  ),
                }))
              }}
              onOpenManuscript={(paper) => setManuscriptPaper(paper)}
              sourceStageName={activeProject.lists.find((l) => l.id !== activeList.id)?.name || 'Source Stage'}
            />
          ) : (
            <>
              {resolvedActiveListPapers.length ? (
                <div className="papers-table-wrap">
                  <table className="papers-table">
                    <thead>
                      <tr>
                        <th className="check-column"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all visible papers" /></th>
                        <th className="visibility-column" title="Toggle visibility"><Eye size={13} /></th>
                        <th className="paper-heading">PAPER <span>{visiblePapers.length === resolvedActiveListPapers.length ? resolvedActiveListPapers.length.toLocaleString() : `${visiblePapers.length} of ${resolvedActiveListPapers.length}`}</span></th>
                        <th className="year-heading">YEAR</th>
                        <th className="journal-heading">SOURCE</th>
                        {(activeList.stageType === 'screening' || resolvedActiveListPapers.some((p) => p.score !== undefined)) && (
                          <th className="score-heading">INCLUSION</th>
                        )}
                        <th className="manuscript-action-heading">MANUSCRIPT</th>
                        {/* Dynamic Data Extraction Columns directly in the table */}
                        {activeExtractionFields.map((f) => (
                          <th key={f.name} className="extracted-col-header" title={f.description || f.name}>
                            <div className="extracted-col-head-inner">
                              <Sparkles size={10} className="col-sparkle" />
                              <span>{f.name.toUpperCase()}</span>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePapers.slice(0, 250).map((paper) => {
                        const included = isPaperIncluded(paper, activeList.minScore)
                        return (
                          <tr key={paper.id} className={`${selectedIds.has(paper.id) ? 'row-selected' : ''} ${included ? '' : 'row-hidden'}`}>
                            <td className="check-column">
                              <input type="checkbox" checked={selectedIds.has(paper.id)} onChange={() => togglePaper(paper.id)} aria-label={`Select ${paper.title}`} />
                            </td>
                            <td className="visibility-cell">
                              <button type="button" className={`row-eye-button ${included ? (paper.manualVisibility === 'show' ? 'manual-show' : 'visible') : 'hidden'}`} onClick={() => togglePaperVisibility(paper.id)} title={included ? (paper.manualVisibility === 'show' ? 'Manually shown override (click to hide)' : 'Shown in stage (click to hide)') : 'Hidden from stage (click to show)'} aria-label={included ? `Hide ${paper.title}` : `Show ${paper.title}`}>
                                {included ? <Eye size={15} /> : <EyeOff size={15} />}
                              </button>
                            </td>
                            <td className="paper-cell">
                              <a className="paper-title" href={paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : undefined)} target="_blank" rel="noreferrer" onClick={(event) => { if (!paper.url && !paper.doi) event.preventDefault() }}>{paper.title}</a>
                              <span className="paper-authors">{paper.authors || 'Author not listed'}{paper.doi && <span className="doi-label">DOI {paper.doi}</span>}{paper.manualVisibility === 'show' && <span className="manual-vis-badge show-badge"><Eye size={10} /> Force Shown</span>}{paper.manualVisibility === 'hide' && <span className="manual-vis-badge hide-badge"><EyeOff size={10} /> Manually Hidden</span>}</span>
                              {paper.abstract && <details className="abstract-details"><summary>Abstract</summary><p>{paper.abstract}</p></details>}
                            </td>
                            <td className="year-cell">{paper.year || '—'}</td>
                            <td className="journal-cell">{paper.journal || '—'}</td>
                            {(activeList.stageType === 'screening' || resolvedActiveListPapers.some((p) => p.score !== undefined)) && (
                              <td className="score-cell">
                                {paper.score !== undefined ? (
                                  <>
                                    <span className={`score-pill ${paper.score >= 8 ? 'score-high' : paper.score >= 5 ? 'score-mid' : 'score-low'}`}>{paper.score}<span>/10</span></span>
                                    {paper.rationale && <span className="score-reason" title={paper.rationale}>AI screened</span>}
                                  </>
                                ) : (
                                  <span className="not-screened">Not screened</span>
                                )}
                              </td>
                            )}
                            <td className="manuscript-actions-cell">
                              <button className="row-manuscript-button" type="button" onClick={() => chooseManuscriptFile(paper.id)} disabled={uploadingPaperId === paper.id} title={paper.manuscript ? 'Replace manuscript PDF' : 'Attach manuscript PDF'} aria-label={paper.manuscript ? `Replace PDF for ${paper.title}` : `Attach PDF for ${paper.title}`}>
                                {uploadingPaperId === paper.id ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
                              </button>
                              {paper.manuscript && (
                                <button className="row-manuscript-button attached" type="button" onClick={() => setManuscriptPaper(paper)} title="View parsed manuscript" aria-label={`View manuscript for ${paper.title}`}><FileText size={15} /></button>
                              )}
                            </td>
                            {/* Dynamic Extraction Cells */}
                            {activeExtractionFields.map((f) => {
                              const raw = paper.extractedData ? paper.extractedData[f.name] : undefined
                              const val = getExtractedFieldValue(raw)
                              return (
                                <td key={f.name} className="extracted-col-cell">
                                  {val ? (
                                    <div className="extracted-cell-value" title={val}>{val}</div>
                                  ) : paper.manuscript ? (
                                    <span className="extracted-cell-pending" title="Manuscript attached; ready for extraction">Pending copy</span>
                                  ) : (
                                    <span className="extracted-cell-nopdf" title="Upload manuscript PDF to extract data">No PDF</span>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {visiblePapers.length > 250 && <div className="table-limit-note">Showing the first 250 matches. Narrow the search to see more.</div>}
                  {!visiblePapers.length && <div className="no-matches"><Search size={18} /><span>{visibilityFilter === 'hidden' ? 'No hidden papers in this stage.' : 'No papers match this search, score threshold, and visibility filter.'}</span></div>}
                </div>
              ) : (
                <div className="empty-list">
                  <span className="empty-list-icon"><FileSpreadsheet size={22} /></span>
                  <div>
                    <h3>{activeList.papers.length ? 'No papers at this score' : 'Bring in your search results or copy papers here'}</h3>
                    <p>{activeList.papers.length ? `No screened papers score ${activeList.minScore} or higher. Lower the threshold to review more.` : 'Upload a CSV or Excel file, or copy papers from an earlier stage.'}</p>
                  </div>
                  {activeList.papers.length ? (
                    <button className="button button-secondary" onClick={() => updateProject(activeProject.id, (project) => ({ ...project, lists: project.lists.map((list) => list.id === activeList.id ? { ...list, minScore: 0 } : list) }))}>Show all scores</button>
                  ) : (
                    <button className="button button-secondary" onClick={() => fileInputRef.current?.click()}><Upload size={15} /> Choose file</button>
                  )}
                </div>
              )}

              {/* Interactive Table Footer with Working CSV and XLSX Downloads */}
              <div className="table-footer">
                <span>
                  Showing {Math.min(visiblePapers.length, 250).toLocaleString()} of {resolvedActiveListPapers.length.toLocaleString()} papers
                  {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
                </span>
                <div className="table-export-actions">
                  <span className="export-label">EXPORT STAGE:</span>
                  <button
                    type="button"
                    className="export-btn"
                    onClick={() => void exportStageData('csv')}
                    title={`Download ${visiblePapers.length} papers from ${activeList.name} as CSV`}
                    disabled={visiblePapers.length === 0}
                  >
                    <ArrowDownToLine size={11} />
                    <span>CSV</span>
                  </button>
                  <span className="export-divider">·</span>
                  <button
                    type="button"
                    className="export-btn"
                    onClick={() => void exportStageData('xlsx')}
                    title={`Download ${visiblePapers.length} papers from ${activeList.name} as Excel workbook (.xlsx)`}
                    disabled={visiblePapers.length === 0}
                  >
                    <ArrowDownToLine size={11} />
                    <span>XLSX (Excel)</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </> : <div className="empty-list"><h3>Create a stage to begin screening.</h3></div>}

          <div className="bottom-caption"><span>FIELDNOTE / {String(activeProject.lists.findIndex((list) => list.id === activeListId) + 1).padStart(2, '0')}</span><span>DECISIONS STAY WITH THE PAPER</span></div>
        </div>
      </section>}
    </main>

    <input ref={manuscriptInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={(event) => void handleManuscriptFile(event.target.files?.[0])} />
    {manuscriptPaper?.manuscript && <ManuscriptPanel paper={manuscriptPaper as Paper & { manuscript: ManuscriptMetadata }} onClose={() => setManuscriptPaper(null)} />}

    {/* Selection Bar */}
    {activeList && selectedIds.size > 0 && <div className="selection-bar">
      <span><strong>{selectedIds.size.toLocaleString()}</strong> selected <button className="clear-selection" onClick={() => setSelectedIds(new Set())}>Clear</button></span>
      <div className="selection-actions">
        <button type="button" className="button button-selection-action" onClick={() => setSelectionVisibility('show')} title="Show selected in stage"><Eye size={14} /> Show</button>
        <button type="button" className="button button-selection-action" onClick={() => setSelectionVisibility('hide')} title="Hide selected from stage"><EyeOff size={14} /> Hide</button>
        <button className="button button-selection" onClick={openCopyDialog}><ArrowRight size={15} /> Copy to Stage <ChevronDown size={14} /></button>
      </div>
    </div>}

    {/* Create Library Modal */}
    {creatingProject && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreatingProject(false) }}><form className="modal project-modal" onSubmit={(event) => { event.preventDefault(); createProject() }}><div className="modal-topline"><span className="modal-icon"><FolderPlus size={17} /></span><button type="button" className="icon-button" onClick={() => setCreatingProject(false)} title="Close"><X size={17} /></button></div><span className="section-kicker">NEW LIBRARY</span><h2>Create a library</h2><p className="modal-description">Give this library a name. You can organize papers into screening stages inside it.</p><label className="field-label" htmlFor="project-name">LIBRARY NAME</label><input id="project-name" className="text-field" autoFocus maxLength={80} placeholder="e.g. Digital health interventions" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setCreatingProject(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!projectName.trim()}><Plus size={15} /> Create library</button></div></form></div>}

    {/* Stage Configuration Modal (Create / Edit Stage) */}
    {stageModalOpen && (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setStageModalOpen(false) }}>
        <section className="modal stage-config-modal" aria-labelledby="stage-modal-title">
          <div className="modal-topline">
            <span className="modal-icon"><SlidersHorizontal size={17} /></span>
            <button type="button" className="icon-button" onClick={() => setStageModalOpen(false)} title="Close"><X size={17} /></button>
          </div>
          <span className="section-kicker">{stageModalMode === 'create' ? 'NEW STAGE CONFIGURATION' : 'STAGE SETTINGS'}</span>
          <h2 id="stage-modal-title">{stageModalMode === 'create' ? 'Create a Stage' : `Configure ${stageDraftName}`}</h2>
          <p className="modal-description">
            Choose this stage's purpose. When papers are copied into this stage, the configured LLM screening or data extraction will automatically run.
          </p>

          <label className="field-label" htmlFor="stage-name-input">STAGE NAME</label>
          <input
            id="stage-name-input"
            className="text-field"
            value={stageDraftName}
            onChange={(e) => setStageDraftName(e.target.value)}
            placeholder="e.g. Stage 2: AI Screening"
          />

          <label className="field-label" style={{ marginTop: '16px' }}>STAGE TYPE &amp; PURPOSE</label>
          <div className="stage-type-cards">
            <button
              type="button"
              className={`stage-type-card ${stageDraftType === 'standard' ? 'selected' : ''}`}
              onClick={() => setStageDraftType('standard')}
            >
              <div className="card-header">
                <FileSpreadsheet size={16} />
                <strong>Standard Stage</strong>
              </div>
              <p>Manual curation, raw imports, or general paper lists without automatic AI processing.</p>
            </button>

            <button
              type="button"
              className={`stage-type-card ${stageDraftType === 'screening' ? 'selected' : ''}`}
              onClick={() => setStageDraftType('screening')}
            >
              <div className="card-header">
                <Sparkles size={16} />
                <strong>AI Screening Stage</strong>
              </div>
              <p>Evaluates title and abstract against your inclusion &amp; exclusion criteria when papers are copied here.</p>
            </button>

            <button
              type="button"
              className={`stage-type-card ${stageDraftType === 'extraction' ? 'selected' : ''}`}
              onClick={() => setStageDraftType('extraction')}
            >
              <div className="card-header">
                <Table2 size={16} />
                <strong>AI Data Extraction Stage</strong>
              </div>
              <p>Extracts custom scientific fields from parsed full-text manuscript PDFs. Fields appear directly as table columns.</p>
            </button>

            <button
              type="button"
              className={`stage-type-card ${stageDraftType === 'synthesis' ? 'selected' : ''}`}
              onClick={() => setStageDraftType('synthesis')}
            >
              <div className="card-header">
                <BookOpen size={16} />
                <strong>AI Synthesis Stage</strong>
              </div>
              <p>Consolidates and synthesizes copied papers into a systematic literature review text editor with categorization and comparative matrix.</p>
            </button>
          </div>

          {/* Screening Configuration Options */}
          {stageDraftType === 'screening' && (
            <div className="stage-config-section">
              <div className="criteria-heading">
                <span className="field-label">SCREENING CRITERIA</span>
                <span className="gemini-tag"><Sparkles size={12} /> GEMINI AI</span>
              </div>
              <label className="field-label criteria-label" htmlFor="stage-inclusion">
                INCLUSION CRITERIA <span>Required for screening</span>
              </label>
              <textarea
                id="stage-inclusion"
                className="text-field criteria-field"
                value={stageDraftInclusion}
                onChange={(e) => setStageDraftInclusion(e.target.value)}
                placeholder="Population, intervention, study design, or outcome requirements..."
                rows={3}
              />
              <label className="field-label criteria-label" htmlFor="stage-exclusion">
                EXCLUSION CRITERIA <span>Optional</span>
              </label>
              <textarea
                id="stage-exclusion"
                className="text-field criteria-field"
                value={stageDraftExclusion}
                onChange={(e) => setStageDraftExclusion(e.target.value)}
                placeholder="Exclusion criteria or reasons to exclude..."
                rows={2}
              />
            </div>
          )}

          {/* Data Extraction Configuration Options */}
          {stageDraftType === 'extraction' && (
            <div className="stage-config-section">
              <div className="criteria-heading">
                <span className="field-label">DATA EXTRACTION COLUMNS</span>
                <span className="gemini-tag"><Sparkles size={12} /> FULL-TEXT PDF</span>
              </div>
              <p className="fields-instruction">
                Define the fields to extract from uploaded manuscript PDFs. Each field becomes a dedicated column in this stage's table.
              </p>
              <div className="field-pairs-list">
                {stageDraftFields.map((f) => (
                  <div key={f.id} className="field-pair-row">
                    <div className="field-pair-inputs">
                      <div className="field-input-group">
                        <label className="mini-field-label">FIELD / COLUMN NAME</label>
                        <input
                          className="text-field field-name-input"
                          placeholder="e.g. Architecture"
                          value={f.name}
                          onChange={(e) => {
                            const val = e.target.value
                            setStageDraftFields((fields) => fields.map((item) => item.id === f.id ? { ...item, name: val } : item))
                          }}
                        />
                      </div>
                      <div className="field-input-group">
                        <label className="mini-field-label">DESCRIPTION / PROMPT</label>
                        <input
                          className="text-field field-desc-input"
                          placeholder="e.g. Architecture of downstream model"
                          value={f.description}
                          onChange={(e) => {
                            const val = e.target.value
                            setStageDraftFields((fields) => fields.map((item) => item.id === f.id ? { ...item, description: val } : item))
                          }}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="remove-field-button"
                      onClick={() => {
                        if (stageDraftFields.length > 1) {
                          setStageDraftFields((fields) => fields.filter((item) => item.id !== f.id))
                        }
                      }}
                      disabled={stageDraftFields.length <= 1}
                      title="Remove field"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="add-field-button"
                onClick={() => setStageDraftFields((fields) => [...fields, { id: crypto.randomUUID(), name: '', description: '' }])}
              >
                <Plus size={13} /> Add another column
              </button>
            </div>
          )}

          {/* AI Synthesis Configuration Options */}
          {stageDraftType === 'synthesis' && (
            <div className="stage-config-section">
              <div className="criteria-heading">
                <span className="field-label">RESEARCH SYNTHESIS FOCUS</span>
                <span className="gemini-tag"><Sparkles size={12} /> GEMINI SLR SYNTHESIS</span>
              </div>
              <label className="field-label criteria-label" htmlFor="stage-synth-prompt">
                SYNTHESIS FOCUS / QUESTIONS <span>Optional</span>
              </label>
              <textarea
                id="stage-synth-prompt"
                className="text-field criteria-field"
                value={stageDraftSynthesisPrompt}
                onChange={(e) => setStageDraftSynthesisPrompt(e.target.value)}
                placeholder="e.g. Highlight comparative trade-offs between deep learning and classical pipelines, data limitations, and open challenges..."
                rows={3}
              />
              <p className="fields-instruction">
                When papers are copied into this stage, the AI consolidates all previous characteristics, categorizes methods, and provides an editable systematic literature review narrative.
              </p>
            </div>
          )}

          {error && <div className="modal-error"><X size={14} /> {error}</div>}

          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={() => setStageModalOpen(false)}>Cancel</button>
            <button
              type="button"
              className="button button-primary"
              onClick={saveStageModal}
              disabled={!stageDraftName.trim() || (stageDraftType === 'screening' && !stageDraftInclusion.trim()) || (stageDraftType === 'extraction' && !stageDraftFields.some((f) => f.name.trim()))}
            >
              <Check size={15} /> {stageModalMode === 'create' ? 'Create Stage' : 'Save Settings'}
            </button>
          </div>
        </section>
      </div>
    )}

    {/* Copy to Stage Modal */}
    {copyOpen && activeProject && activeList && (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !screening && !extracting && !synthesizing) setCopyOpen(false) }}>
        <section className="modal transfer-modal" aria-labelledby="transfer-title">
          <div className="modal-topline">
            <span className="modal-icon"><ArrowRight size={17} /></span>
            <button type="button" className="icon-button" onClick={() => { if (!screening && !extracting && !synthesizing) setCopyOpen(false) }} title="Close" disabled={screening || extracting || synthesizing}><X size={17} /></button>
          </div>
          <span className="section-kicker">NEXT STAGE · {selectedPapers.length} PAPERS SELECTED</span>
          <h2 id="transfer-title">Copy to a Stage</h2>
          <p className="modal-description">
            Copy {selectedPapers.length} papers from <strong>{activeList.name}</strong> to the destination stage. The destination stage's configured screening, data extraction, or synthesis will automatically be performed.
          </p>

          <label className="field-label" htmlFor="destination-list">DESTINATION STAGE</label>
          {!createTarget && activeProject.lists.some((list) => list.id !== activeList.id) ? (
            <select
              id="destination-list"
              className="text-field select-field"
              value={targetListId}
              onChange={(event) => {
                const newId = event.target.value
                setTargetListId(newId)
                const targetL = activeProject.lists.find((l) => l.id === newId)
                if (targetL) {
                  setTargetStageType(targetL.stageType ?? 'standard')
                  setInclusionCriteria(targetL.inclusionCriteria ?? '')
                  setExclusionCriteria(targetL.exclusionCriteria ?? '')
                  setCopyExtractionFields(targetL.extractionFields?.length ? targetL.extractionFields : DEFAULT_EXTRACTION_FIELDS)
                  setCopySynthesisPrompt(targetL.synthesisPrompt ?? '')
                }
              }}
              disabled={screening || extracting || synthesizing}
            >
              {activeProject.lists.filter((list) => list.id !== activeList.id).map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} {list.stageType === 'screening' ? '(AI Screening)' : list.stageType === 'extraction' ? '(AI Data Extraction)' : list.stageType === 'synthesis' ? '(AI Synthesis)' : '(Standard)'}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="text-field"
              value={targetListName}
              onChange={(event) => setTargetListName(event.target.value)}
              aria-label="New stage name"
              placeholder="New stage name"
              disabled={screening || extracting || synthesizing}
            />
          )}

          {activeProject.lists.some((list) => list.id !== activeList.id) && (
            <button className="create-list-toggle" onClick={() => setCreateTarget((value) => !value)} type="button" disabled={screening || extracting || synthesizing}>
              <Plus size={14} /> {createTarget ? 'Choose an existing stage' : 'Create a new stage'}
            </button>
          )}

          {/* New Stage Configuration Inline (if creating target on the fly) */}
          {createTarget && (
            <div className="inline-stage-type-selection">
              <label className="field-label" style={{ marginTop: '12px' }}>NEW STAGE PURPOSE</label>
              <div className="modal-mode-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={targetStageType === 'screening'}
                  className={`modal-mode-tab ${targetStageType === 'screening' ? 'active' : ''}`}
                  onClick={() => setTargetStageType('screening')}
                  disabled={screening || extracting || synthesizing}
                >
                  <Sparkles size={14} />
                  <span>AI Screening</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={targetStageType === 'extraction'}
                  className={`modal-mode-tab ${targetStageType === 'extraction' ? 'active' : ''}`}
                  onClick={() => setTargetStageType('extraction')}
                  disabled={screening || extracting || synthesizing}
                >
                  <Table2 size={14} />
                  <span>AI Extraction</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={targetStageType === 'synthesis'}
                  className={`modal-mode-tab ${targetStageType === 'synthesis' ? 'active' : ''}`}
                  onClick={() => setTargetStageType('synthesis')}
                  disabled={screening || extracting || synthesizing}
                >
                  <BookOpen size={14} />
                  <span>AI Synthesis</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={targetStageType === 'standard'}
                  className={`modal-mode-tab ${targetStageType === 'standard' ? 'active' : ''}`}
                  onClick={() => setTargetStageType('standard')}
                  disabled={screening || extracting || synthesizing}
                >
                  <FileSpreadsheet size={14} />
                  <span>Standard</span>
                </button>
              </div>
            </div>
          )}

          {/* AI Screening Review Box */}
          {(createTarget ? targetStageType === 'screening' : selectedTargetList?.stageType === 'screening') && (
            <div className="mode-panel">
              <div className="criteria-heading">
                <span className="field-label">AI SCREENING CONFIGURATION</span>
                <span className="gemini-tag"><Sparkles size={12} /> GEMINI AI</span>
              </div>
              <label className="field-label criteria-label" htmlFor="inclusion">
                INCLUSION CRITERIA <span>Required for screening</span>
              </label>
              <textarea
                id="inclusion"
                className="text-field criteria-field"
                value={inclusionCriteria}
                onChange={(event) => setInclusionCriteria(event.target.value)}
                placeholder="Population, intervention, study design, or other requirements..."
                rows={3}
                disabled={screening || extracting || synthesizing}
              />
              <label className="field-label criteria-label" htmlFor="exclusion">
                EXCLUSION CRITERIA <span>Optional</span>
              </label>
              <textarea
                id="exclusion"
                className="text-field criteria-field"
                value={exclusionCriteria}
                onChange={(event) => setExclusionCriteria(event.target.value)}
                placeholder="Reasons a paper should not proceed..."
                rows={2}
                disabled={screening || extracting || synthesizing}
              />
              <p className="modal-privacy">
                Titles and abstracts of the {selectedPapers.length} selected papers will be evaluated by LLM to assign confidence scores (0-10) in the destination stage.
              </p>
            </div>
          )}

          {/* AI Data Extraction Review Box */}
          {(createTarget ? targetStageType === 'extraction' : selectedTargetList?.stageType === 'extraction') && (
            <div className="mode-panel">
              <div className="criteria-heading">
                <span className="field-label">TARGET DATA EXTRACTION FIELDS</span>
                <span className="gemini-tag"><Sparkles size={12} /> FULL-TEXT PDF</span>
              </div>
              <p className="fields-instruction">
                Extracted data will fill the corresponding table columns in the destination stage.
              </p>
              <div className="field-pairs-list">
                {copyExtractionFields.map((f) => (
                  <div key={f.id} className="field-pair-row">
                    <div className="field-pair-inputs">
                      <div className="field-input-group">
                        <label className="mini-field-label">COLUMN NAME</label>
                        <input
                          className="text-field field-name-input"
                          placeholder="e.g. Architecture"
                          value={f.name}
                          onChange={(e) => {
                            const val = e.target.value
                            setCopyExtractionFields((fields) => fields.map((item) => item.id === f.id ? { ...item, name: val } : item))
                          }}
                          disabled={screening || extracting || synthesizing}
                        />
                      </div>
                      <div className="field-input-group">
                        <label className="mini-field-label">DESCRIPTION / PROMPT</label>
                        <input
                          className="text-field field-desc-input"
                          placeholder="e.g. Architecture of downstream model"
                          value={f.description}
                          onChange={(e) => {
                            const val = e.target.value
                            setCopyExtractionFields((fields) => fields.map((item) => item.id === f.id ? { ...item, description: val } : item))
                          }}
                          disabled={screening || extracting || synthesizing}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="remove-field-button"
                      onClick={() => {
                        if (copyExtractionFields.length > 1) {
                          setCopyExtractionFields((fields) => fields.filter((item) => item.id !== f.id))
                        }
                      }}
                      disabled={copyExtractionFields.length <= 1 || screening || extracting || synthesizing}
                      title="Remove field"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="add-field-button"
                onClick={() => setCopyExtractionFields((fields) => [...fields, { id: crypto.randomUUID(), name: '', description: '' }])}
                disabled={screening || extracting || synthesizing}
              >
                <Plus size={13} /> Add another column
              </button>
              <div className="manuscript-readiness-box">
                <FileText size={14} />
                <div>
                  <strong>{selectedPapersWithManuscripts.length} of {selectedPapers.length}</strong> selected papers have parsed manuscript PDFs attached.
                  {selectedPapersWithManuscripts.length < selectedPapers.length && (
                    <em> (Papers without attached manuscripts will be copied without extracted data.)</em>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* AI Literature Synthesis Review Box */}
          {(createTarget ? targetStageType === 'synthesis' : selectedTargetList?.stageType === 'synthesis') && (
            <div className="mode-panel">
              <div className="criteria-heading">
                <span className="field-label">AI LITERATURE SYNTHESIS CONFIGURATION</span>
                <span className="gemini-tag"><Sparkles size={12} /> GEMINI SLR SYNTHESIS</span>
              </div>
              <label className="field-label criteria-label" htmlFor="copy-synth-prompt">
                RESEARCH FOCUS / COMPARATIVE THEMES <span>Optional</span>
              </label>
              <textarea
                id="copy-synth-prompt"
                className="text-field criteria-field"
                value={copySynthesisPrompt}
                onChange={(event) => setCopySynthesisPrompt(event.target.value)}
                placeholder="e.g. Focus on comparing clinical outcomes, machine learning architectures, and benchmarking dataset limitations..."
                rows={3}
                disabled={screening || extracting || synthesizing}
              />
              <p className="modal-privacy">
                The AI will synthesize the {selectedPapers.length} selected papers and their extracted fields from <strong>{activeList.name}</strong> into an academic Systematic Literature Review (SLR) document, covering taxonomic categorization, similarity analysis, and a comparative matrix.
              </p>
            </div>
          )}

          {error && <div className="modal-error"><X size={14} /> {error}</div>}
          {screening && <div className="screening-progress"><LoaderCircle size={15} className="spin" /> {screeningProgress} · evaluating title and abstract</div>}
          {extracting && <div className="screening-progress"><LoaderCircle size={15} className="spin" /> {extractionProgress}</div>}
          {synthesizing && <div className="screening-progress"><LoaderCircle size={15} className="spin" /> {synthesizingProgress}</div>}

          <div className="modal-actions transfer-actions">
            <button type="button" className="button button-quiet" onClick={() => setCopyOpen(false)} disabled={screening || extracting || synthesizing}>Cancel</button>
            <button
              type="button"
              className="button button-secondary copy-only-button"
              onClick={() => void transferSelected('copy-only')}
              disabled={screening || extracting || synthesizing}
            >
              <ArrowRight size={15} /> Copy without AI
            </button>
            {(createTarget ? targetStageType === 'screening' : selectedTargetList?.stageType === 'screening') ? (
              <button
                type="button"
                className="button button-primary"
                onClick={() => void transferSelected('auto')}
                disabled={screening || extracting || synthesizing || !inclusionCriteria.trim()}
              >
                {screening ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Screen &amp; Copy
              </button>
            ) : (createTarget ? targetStageType === 'extraction' : selectedTargetList?.stageType === 'extraction') ? (
              <button
                type="button"
                className="button button-primary"
                onClick={() => void transferSelected('auto')}
                disabled={screening || extracting || synthesizing || !copyExtractionFields.some((f) => f.name.trim()) || selectedPapersWithManuscripts.length === 0}
              >
                {extracting ? <LoaderCircle className="spin" size={15} /> : <Table2 size={15} />} Extract &amp; Copy
              </button>
            ) : (createTarget ? targetStageType === 'synthesis' : selectedTargetList?.stageType === 'synthesis') ? (
              <button
                type="button"
                className="button button-primary"
                onClick={() => void transferSelected('auto')}
                disabled={screening || extracting || synthesizing || selectedPapers.length === 0}
              >
                {synthesizing ? <LoaderCircle className="spin" size={15} /> : <BookOpen size={15} />} Synthesize &amp; Copy
              </button>
            ) : (
              <button
                type="button"
                className="button button-primary"
                onClick={() => void transferSelected('auto')}
                disabled={screening || extracting || synthesizing}
              >
                <ArrowRight size={15} /> Copy to Stage
              </button>
            )}
          </div>
        </section>
      </div>
    )}

    {toast && <div className="toast"><Check size={15} /> {toast}</div>}
  </div>
}

export default App