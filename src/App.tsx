import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronDown, CircleHelp, ClipboardList, Eye, EyeOff, FileSpreadsheet, FileText, FolderPlus, ListFilter, LoaderCircle, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Sparkles, Table2, Trash2, Upload, User, X } from 'lucide-react'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/browser'
import writeXlsxFile from 'write-excel-file/browser'
import ManuscriptPanel from './ManuscriptPanel'
import SectionMappingModal from './SectionMappingModal'
import SynthesisStudio from './SynthesisStudio'
import type { ManuscriptDocument, ManuscriptMetadata } from './types'

export type ManualVisibility = 'show' | 'hide'
export type VisibilityFilter = 'included' | 'hidden' | 'all'
export type StageType = 'standard' | 'screening' | 'extraction' | 'synthesis'
export type ScreeningType = 'abstract' | 'manuscript'
export type ScreeningDecision = 'Yes' | 'No' | 'Not Sure'
export type DecisionFilter = 'all' | 'Yes' | 'Not Sure' | 'No' | 'unscreened'
export type AbstractFilter = 'all' | 'has_abstract' | 'missing_abstract'
export type ManuscriptFilter = 'all' | 'missing_manuscript' | 'has_manuscript'
export type DecisionSource = 'ai' | 'manual'

export type ExtractionField = {
  id: string
  name: string
  description: string
}

export type ExtractedFieldValue = string | { value?: string }

export type Paper = {
  id: string; title: string; authors: string; year: string; journal: string
  doi: string; url: string; abstract: string
  include?: ScreeningDecision; decision?: ScreeningDecision; explanation?: string
  score?: number; rationale?: string
  manualVisibility?: ManualVisibility
  extractedData?: Record<string, string>
  manuscript?: ManuscriptMetadata
  aiDecision?: ScreeningDecision
  aiExplanation?: string
  manualDecision?: ScreeningDecision
  manualExplanation?: string
  decisionSource?: DecisionSource
}
export type PaperRef = {
  id: string
  include?: ScreeningDecision; decision?: ScreeningDecision; explanation?: string
  score?: number; rationale?: string
  manualVisibility?: ManualVisibility
  extractedData?: Record<string, string>
  aiDecision?: ScreeningDecision
  aiExplanation?: string
  manualDecision?: ScreeningDecision
  manualExplanation?: string
  decisionSource?: DecisionSource
}
export type PaperList = {
  id: string
  name: string
  stageType: StageType
  screeningType?: ScreeningType
  inclusionCriteria?: string
  exclusionCriteria?: string
  extractionFields?: ExtractionField[]
  synthesisText?: string
  synthesisPrompt?: string
  minScore?: number
  papers: (Paper | PaperRef)[]
}
export type RetrievalResultItem = {
  id: string
  title: string
  success: boolean
  source?: string
  sourceUrl?: string
  fileName?: string
  pageCount?: number
  lineCount?: number
  error?: string
  doi?: string
  document?: ManuscriptDocument
}
export type RetrievalSummary = {
  total: number
  succeededCount: number
  failedCount: number
  skippedCount?: number
  results: RetrievalResultItem[]
}
type Project = { id: string; name: string; createdAt: string; lists: PaperList[] }
type ScreeningResult = { id: string; include: ScreeningDecision; explanation: string; decision?: ScreeningDecision; score?: number; rationale?: string }
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
    screeningType: options?.screeningType ?? 'abstract',
    inclusionCriteria: options?.inclusionCriteria ?? '',
    exclusionCriteria: options?.exclusionCriteria ?? '',
    extractionFields: options?.extractionFields ?? (stageType === 'extraction' ? DEFAULT_EXTRACTION_FIELDS : []),
    synthesisText: options?.synthesisText ?? '',
    synthesisPrompt: options?.synthesisPrompt ?? '',
    minScore: options?.minScore ?? 9,
    papers: options?.papers ?? [],
  }
}

function isPaperIncluded(paper: Paper): boolean {
  if (paper.manualVisibility === 'hide') return false
  if (paper.manualVisibility === 'show') return true
  const dec = paper.include ?? paper.decision
  if (dec) {
    return dec === 'Yes' || dec === 'Not Sure'
  }
  if (paper.score !== undefined) {
    return paper.score >= 5
  }
  return true
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
  const [copyScreeningType, setCopyScreeningType] = useState<ScreeningType>('abstract')
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
  const [stageDraftScreeningType, setStageDraftScreeningType] = useState<ScreeningType>('abstract')
  const [stageDraftInclusion, setStageDraftInclusion] = useState('')
  const [stageDraftExclusion, setStageDraftExclusion] = useState('')
  const [stageDraftFields, setStageDraftFields] = useState<ExtractionField[]>(DEFAULT_EXTRACTION_FIELDS)
  const [stageDraftSynthesisPrompt, setStageDraftSynthesisPrompt] = useState('')

  const [creatingProject, setCreatingProject] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [projectName, setProjectName] = useState('')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [retrievingFullText, setRetrievingFullText] = useState(false)
  const [retrievingProgress, setRetrievingProgress] = useState('')
  const [fetchingPaperId, setFetchingPaperId] = useState<string | null>(null)
  const [retrievalSummary, setRetrievalSummary] = useState<RetrievalSummary | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const manuscriptInputRef = useRef<HTMLInputElement>(null)
  const manuscriptTargetRef = useRef<string | null>(null)
  const [uploadingPaperId, setUploadingPaperId] = useState<string | null>(null)
  const [manuscriptPaper, setManuscriptPaper] = useState<Paper | null>(null)
  const [sectionMappingTarget, setSectionMappingTarget] = useState<{
    paperId: string
    paperTitle: string
    document: ManuscriptDocument
    isInitialUpload?: boolean
  } | null>(null)

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
          setDatabaseReady(true)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'The library database could not be loaded.')
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
      }).catch((saveError: unknown) => {
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

  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all')
  const [abstractFilter, setAbstractFilter] = useState<AbstractFilter>('all')
  const [manuscriptFilter, setManuscriptFilter] = useState<ManuscriptFilter>('all')

  const [overrideTargetPaper, setOverrideTargetPaper] = useState<Paper | null>(null)
  const [overrideDecision, setOverrideDecision] = useState<ScreeningDecision | 'unscreened'>('Yes')
  const [overrideComment, setOverrideComment] = useState('')

  useEffect(() => {
    setSelectedIds(new Set())
    setSearch('')
    setVisibilityFilter('included')
    setDecisionFilter('all')
    setAbstractFilter('all')
    setManuscriptFilter('all')
    setOverrideTargetPaper(null)
  }, [activeListId])

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
      return (activeList.papers as Paper[]).map((p) => {
        const manualDecision = p.manualDecision
        const manualExplanation = p.manualExplanation
        const aiDecision = p.aiDecision
        const aiExplanation = p.aiExplanation
        const effectiveDecision = p.include ?? p.decision
        const effectiveExplanation = p.explanation ?? p.rationale
        const decisionSource: DecisionSource | undefined =
          p.decisionSource ?? (manualDecision ? 'manual' : (aiDecision || effectiveDecision) ? 'ai' : undefined)
        return {
          ...p,
          include: effectiveDecision,
          decision: effectiveDecision,
          explanation: effectiveExplanation,
          aiDecision: aiDecision ?? (decisionSource === 'ai' ? effectiveDecision : undefined),
          aiExplanation: aiExplanation ?? (decisionSource === 'ai' ? effectiveExplanation : undefined),
          manualDecision,
          manualExplanation,
          decisionSource,
        }
      })
    }
    return activeList.papers.map((entry) => {
      const master = masterPapersMap.get(entry.id)
      if (master) {
        const manualDecision = entry.manualDecision !== undefined ? entry.manualDecision : master.manualDecision
        const manualExplanation = entry.manualExplanation !== undefined ? entry.manualExplanation : master.manualExplanation
        const aiDecision = entry.aiDecision !== undefined ? entry.aiDecision : master.aiDecision
        const aiExplanation = entry.aiExplanation !== undefined ? entry.aiExplanation : master.aiExplanation

        const effectiveDecision = entry.include ?? entry.decision ?? master.include ?? master.decision
        const effectiveExplanation = entry.explanation ?? entry.rationale ?? master.explanation ?? master.rationale

        const decisionSource: DecisionSource | undefined =
          entry.decisionSource ?? master.decisionSource ?? (manualDecision ? 'manual' : (aiDecision || effectiveDecision) ? 'ai' : undefined)

        return {
          ...master,
          include: effectiveDecision,
          decision: effectiveDecision,
          explanation: effectiveExplanation,
          score: entry.score ?? master.score,
          rationale: effectiveExplanation,
          manualVisibility: entry.manualVisibility,
          extractedData: entry.extractedData ?? master.extractedData,
          aiDecision: aiDecision ?? (decisionSource === 'ai' ? effectiveDecision : undefined),
          aiExplanation: aiExplanation ?? (decisionSource === 'ai' ? effectiveExplanation : undefined),
          manualDecision,
          manualExplanation,
          decisionSource,
        }
      }
      return entry as Paper
    })
  }, [activeList, activeProject, masterPapersMap])

  const visiblePapers = useMemo(() => {
    if (!activeList) return []
    const query = search.trim().toLowerCase()
    return resolvedActiveListPapers.filter((paper) => {
      const matchesSearch = !query || [paper.title, paper.authors, paper.journal, paper.doi, paper.explanation, paper.rationale].some((value) => value && value.toLowerCase().includes(query))
      if (!matchesSearch) return false
      const included = isPaperIncluded(paper)
      if (visibilityFilter === 'included' && !included) return false
      if (visibilityFilter === 'hidden' && included) return false

      if (decisionFilter !== 'all') {
        const dec = paper.include ?? paper.decision
        if (decisionFilter === 'unscreened') {
          if (dec !== undefined) return false
        } else {
          if (dec !== decisionFilter) return false
        }
      }

      if (abstractFilter === 'has_abstract') {
        if (!paper.abstract || !paper.abstract.trim()) return false
      } else if (abstractFilter === 'missing_abstract') {
        if (paper.abstract && paper.abstract.trim()) return false
      }

      if (manuscriptFilter === 'has_manuscript') {
        if (!paper.manuscript) return false
      } else if (manuscriptFilter === 'missing_manuscript') {
        if (paper.manuscript) return false
      }

      return true
    })
  }, [activeList, resolvedActiveListPapers, search, visibilityFilter, decisionFilter, abstractFilter, manuscriptFilter])

  const includedCount = useMemo(() => {
    if (!activeList) return 0
    return resolvedActiveListPapers.filter((paper) => isPaperIncluded(paper)).length
  }, [activeList, resolvedActiveListPapers])

  const hiddenCount = useMemo(() => {
    if (!activeList) return 0
    return resolvedActiveListPapers.filter((paper) => !isPaperIncluded(paper)).length
  }, [activeList, resolvedActiveListPapers])

  const selectedPapers = useMemo(() => {
    return resolvedActiveListPapers.filter((paper) => selectedIds.has(paper.id))
  }, [resolvedActiveListPapers, selectedIds])

  const selectedPapersWithManuscripts = useMemo(() => {
    return selectedPapers.filter((paper) => Boolean(paper.manuscript))
  }, [selectedPapers])

  const allVisibleSelected = visiblePapers.length > 0 && visiblePapers.every((paper) => selectedIds.has(paper.id))

  const yesCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => (p.include ?? p.decision) === 'Yes').length
  }, [resolvedActiveListPapers])

  const notSureCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => (p.include ?? p.decision) === 'Not Sure').length
  }, [resolvedActiveListPapers])

  const noCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => (p.include ?? p.decision) === 'No').length
  }, [resolvedActiveListPapers])

  const screenedCount = useMemo(() => {
    return resolvedActiveListPapers.filter((paper) => (paper.include ?? paper.decision) !== undefined || paper.score !== undefined).length
  }, [resolvedActiveListPapers])

  const hasAbstractCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => Boolean(p.abstract && p.abstract.trim())).length
  }, [resolvedActiveListPapers])

  const missingAbstractCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => !p.abstract || !p.abstract.trim()).length
  }, [resolvedActiveListPapers])

  const hasManuscriptCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => Boolean(p.manuscript)).length
  }, [resolvedActiveListPapers])

  const missingManuscriptCount = useMemo(() => {
    return resolvedActiveListPapers.filter((p) => !p.manuscript).length
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

  function openDecisionOverride(paper: Paper) {
    const activeDec = paper.include || paper.decision || (paper.score !== undefined ? (paper.score >= 8 ? 'Yes' : paper.score >= 5 ? 'Not Sure' : 'No') : undefined)
    setOverrideTargetPaper(paper)
    setOverrideDecision(activeDec ?? 'Yes')
    setOverrideComment(paper.manualExplanation ?? (paper.decisionSource === 'manual' ? (paper.explanation || '') : ''))
  }

  function saveDecisionOverride(paperId: string, newDecision: ScreeningDecision | 'unscreened', newComment: string, revertToAi = false) {
    if (!activeProject || !activeList) return
    const currentPaper = resolvedActiveListPapers.find((p) => p.id === paperId)
    if (!currentPaper) return

    const aiDec = currentPaper.aiDecision ?? (!currentPaper.manualDecision ? (currentPaper.include ?? currentPaper.decision) : undefined)
    const aiExpl = currentPaper.aiExplanation ?? (!currentPaper.manualDecision ? (currentPaper.explanation ?? currentPaper.rationale) : undefined)

    let finalDecision: ScreeningDecision | undefined
    let finalExplanation: string | undefined
    let manualDecision: ScreeningDecision | undefined
    let manualExplanation: string | undefined
    let decisionSource: DecisionSource | undefined

    if (revertToAi) {
      finalDecision = aiDec
      finalExplanation = aiExpl
      manualDecision = undefined
      manualExplanation = undefined
      decisionSource = aiDec ? 'ai' : undefined
    } else if (newDecision === 'unscreened') {
      finalDecision = undefined
      finalExplanation = newComment.trim() || undefined
      manualDecision = undefined
      manualExplanation = newComment.trim() || undefined
      decisionSource = newComment.trim() ? 'manual' : undefined
    } else {
      finalDecision = newDecision
      finalExplanation = newComment.trim()
      manualDecision = newDecision
      manualExplanation = newComment.trim()
      decisionSource = 'manual'
    }

    updateProject(activeProject.id, (project) => ({
      ...project,
      lists: project.lists.map((list, idx) => {
        if (list.id === activeList.id) {
          if (idx === 0) {
            return {
              ...list,
              papers: (list.papers as Paper[]).map((p) => {
                if (p.id !== paperId) return p
                return {
                  ...p,
                  include: finalDecision,
                  decision: finalDecision,
                  explanation: finalExplanation,
                  rationale: finalExplanation,
                  manualDecision,
                  manualExplanation,
                  aiDecision: aiDec,
                  aiExplanation: aiExpl,
                  decisionSource,
                  score: finalDecision === 'Yes' ? 10 : finalDecision === 'No' ? 0 : finalDecision === 'Not Sure' ? 5 : undefined,
                }
              }),
            }
          }
          return {
            ...list,
            papers: (list.papers as PaperRef[]).map((ref) => {
              if (ref.id !== paperId) return ref
              return {
                ...ref,
                include: finalDecision,
                decision: finalDecision,
                explanation: finalExplanation,
                rationale: finalExplanation,
                manualDecision,
                manualExplanation,
                aiDecision: aiDec,
                aiExplanation: aiExpl,
                decisionSource,
                score: finalDecision === 'Yes' ? 10 : finalDecision === 'No' ? 0 : finalDecision === 'Not Sure' ? 5 : undefined,
              }
            }),
          }
        }
        return list
      }),
    }))

    setOverrideTargetPaper(null)
    setToast(revertToAi ? 'Reverted to original AI screening evaluation' : 'Screening decision & comment updated')
  }

  function togglePaperVisibility(paperId: string) {
    if (!activeProject || !activeList) return
    const currentPaper = resolvedActiveListPapers.find((p) => p.id === paperId)
    if (!currentPaper) return

    const currentlyIncluded = isPaperIncluded(currentPaper)
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

  async function confirmDeleteProject() {
    if (!projectToDelete) return
    const targetId = projectToDelete.id
    const targetName = projectToDelete.name
    setProjects((current) => current.filter((project) => project.id !== targetId))
    if (activeProjectId === targetId) {
      setActiveProjectId(null)
      setActiveListId(null)
    }
    setProjectToDelete(null)
    try {
      await fetch(`/api/projects/${encodeURIComponent(targetId)}`, { method: 'DELETE' })
    } catch {
      // Auto-persisted by projects effect
    }
    setToast(`Deleted library "${targetName}"`)
  }

  // Open Create Stage Modal
  function openCreateStageModal() {
    if (!activeProject) return
    const nextNum = activeProject.lists.length + 1
    setStageModalMode('create')
    setStageModalListId(null)
    setStageDraftName(`Stage ${nextNum}`)
    setStageDraftType(nextNum === 2 ? 'screening' : nextNum === 3 ? 'extraction' : nextNum === 4 ? 'synthesis' : 'standard')
    setStageDraftScreeningType('abstract')
    setStageDraftInclusion('')
    setStageDraftExclusion('')
    setStageDraftFields(DEFAULT_EXTRACTION_FIELDS)
    setStageDraftSynthesisPrompt('')
    setError('')
    setStageModalOpen(true)
  }

  // Open Edit Stage Configuration Modal
  function openEditStageModal(list: PaperList) {
    setStageModalMode('edit')
    setStageModalListId(list.id)
    setStageDraftName(list.name)
    setStageDraftType(list.stageType ?? 'standard')
    setStageDraftScreeningType(list.screeningType ?? 'abstract')
    setStageDraftInclusion(list.inclusionCriteria ?? '')
    setStageDraftExclusion(list.exclusionCriteria ?? '')
    setStageDraftFields(list.extractionFields && list.extractionFields.length > 0 ? list.extractionFields : DEFAULT_EXTRACTION_FIELDS)
    setStageDraftSynthesisPrompt(list.synthesisPrompt ?? '')
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
        screeningType: stageDraftType === 'screening' ? stageDraftScreeningType : 'abstract',
        inclusionCriteria: stageDraftInclusion.trim(),
        exclusionCriteria: stageDraftExclusion.trim(),
        extractionFields: stageDraftType === 'extraction' ? cleanFields : [],
        synthesisPrompt: stageDraftSynthesisPrompt.trim(),
      })
      updateProject(activeProject.id, (project) => ({
        ...project,
        lists: [...project.lists, newList],
      }))
      setActiveListId(newList.id)
      const typeLabel = stageDraftType === 'screening'
        ? `AI Screening (${stageDraftScreeningType === 'manuscript' ? 'Manuscript' : 'Title/Abstract'})`
        : stageDraftType === 'extraction' ? 'AI Data Extraction' : stageDraftType === 'synthesis' ? 'AI Synthesis' : 'Standard'
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
              screeningType: stageDraftType === 'screening' ? stageDraftScreeningType : (list.screeningType ?? 'abstract'),
              inclusionCriteria: stageDraftInclusion.trim(),
              exclusionCriteria: stageDraftExclusion.trim(),
              extractionFields: stageDraftType === 'extraction' ? cleanFields : list.extractionFields,
              synthesisPrompt: stageDraftSynthesisPrompt.trim(),
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
        extracted_at?: string; warnings?: string[]; detail?: string; document?: ManuscriptDocument
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

      const targetPaper = activeProject.lists[0]?.papers.find((p) => p.id === paperId)
      const targetTitle = (targetPaper && 'title' in targetPaper ? targetPaper.title : undefined) || file.name
      if (payload.document) {
        setSectionMappingTarget({
          paperId,
          paperTitle: targetTitle,
          document: payload.document,
          isInitialUpload: true,
        })
      } else {
        fetch(`/api/papers/${encodeURIComponent(paperId)}/manuscript`)
          .then((res) => res.json())
          .then((doc: ManuscriptDocument) => {
            setSectionMappingTarget({
              paperId,
              paperTitle: targetTitle,
              document: doc,
              isInitialUpload: true,
            })
          })
          .catch(() => {})
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not attach this PDF.')
    } finally {
      setUploadingPaperId(null)
      if (manuscriptInputRef.current) manuscriptInputRef.current.value = ''
    }
  }

  async function handleSingleFetch(paper: Paper) {
    if (!activeProject) return
    setFetchingPaperId(paper.id)
    setError('')
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(paper.id)}/fetch-manuscript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: paper.id,
          title: paper.title,
          doi: paper.doi,
          url: paper.url,
          authors: paper.authors,
          journal: paper.journal,
          year: paper.year,
        }),
      })
      const payload = (await response.json()) as RetrievalResultItem & { warnings?: string[] }
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'No open access manuscript found in online repositories.')
      }

      const manuscript: ManuscriptMetadata = {
        fileName: payload.fileName ?? `${paper.id}.pdf`,
        pageCount: payload.pageCount ?? 0,
        lineCount: payload.lineCount ?? 0,
        extractedAt: payload.document?.extracted_at ?? new Date().toISOString(),
        warnings: payload.warnings ?? [],
      }

      updateProject(activeProject.id, (project) => ({
        ...project,
        lists: project.lists.map((list, idx) => {
          if (idx === 0) {
            return {
              ...list,
              papers: list.papers.map((p) => (p.id === paper.id ? { ...p, manuscript } : p)),
            }
          }
          return list
        }),
      }))

      setToast(`Retrieved ${manuscript.fileName} via ${payload.source || 'Open Access'}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not retrieve full text online.')
    } finally {
      setFetchingPaperId(null)
    }
  }

  async function handleRetrieveSelectedFullText() {
    if (!activeProject || !activeList || selectedIds.size === 0) return
    const allSelected = resolvedActiveListPapers.filter((p) => selectedIds.has(p.id))
    if (allSelected.length === 0) return

    // Exclude papers that already have an attached manuscript
    const targets = allSelected.filter((p) => !p.manuscript)
    if (targets.length === 0) {
      setToast('All selected papers already have a manuscript attached.')
      return
    }

    const skippedCount = allSelected.length - targets.length
    setRetrievingFullText(true)
    setRetrievingProgress(
      skippedCount > 0
        ? `Searching open-access repositories for ${targets.length} papers (${skippedCount} already attached)...`
        : `Searching open-access repositories for ${targets.length} papers...`
    )
    setError('')

    try {
      const response = await fetch('/api/papers/batch-fetch-manuscripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skipExisting: true,
          papers: targets.map((p) => ({
            id: p.id,
            title: p.title,
            doi: p.doi,
            url: p.url,
            authors: p.authors,
            journal: p.journal,
            year: p.year,
          })),
        }),
      })

      const summary = (await response.json()) as RetrievalSummary
      if (!response.ok) {
        throw new Error('Batch manuscript retrieval request failed.')
      }

      // Update state for all succeeded papers
      const succeededMap = new Map<string, RetrievalResultItem>()
      for (const item of summary.results) {
        if (item.success && item.fileName) {
          succeededMap.set(item.id, item)
        }
      }

      if (succeededMap.size > 0) {
        updateProject(activeProject.id, (project) => ({
          ...project,
          lists: project.lists.map((list, idx) => {
            if (idx === 0) {
              return {
                ...list,
                papers: list.papers.map((p) => {
                  const match = succeededMap.get(p.id)
                  if (!match) return p
                  const manuscript: ManuscriptMetadata = {
                    fileName: match.fileName ?? `${p.id}.pdf`,
                    pageCount: match.pageCount ?? 0,
                    lineCount: match.lineCount ?? 0,
                    extractedAt: match.document?.extracted_at ?? new Date().toISOString(),
                    warnings: match.document?.warnings ?? [],
                  }
                  return { ...p, manuscript }
                }),
              }
            }
            return list
          }),
        }))
      }

      setRetrievalSummary({
        ...summary,
        skippedCount: skippedCount > 0 ? skippedCount : undefined,
      })
      if (succeededMap.size > 0) {
        setToast(
          skippedCount > 0
            ? `Retrieved ${succeededMap.size} manuscripts (${skippedCount} already attached).`
            : `Retrieved ${succeededMap.size} of ${summary.total} full-text manuscripts.`
        )
      } else {
        setToast('Full-text retrieval finished. Check summary for details.')
      }
    } catch (fetchErr: unknown) {
      setError(fetchErr instanceof Error ? fetchErr.message : 'Full-text retrieval failed. Try again.')
    } finally {
      setRetrievingFullText(false)
      setRetrievingProgress('')
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
      setCopyScreeningType(other.screeningType ?? 'abstract')
      setInclusionCriteria(other.inclusionCriteria ?? '')
      setExclusionCriteria(other.exclusionCriteria ?? '')
      setCopyExtractionFields(other.extractionFields?.length ? other.extractionFields : DEFAULT_EXTRACTION_FIELDS)
      setCopySynthesisPrompt(other.synthesisPrompt ?? '')
    } else {
      setTargetStageType('screening')
      setCopyScreeningType('abstract')
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
    const effectiveScreeningType = createTarget ? copyScreeningType : (selectedTargetList?.screeningType ?? copyScreeningType ?? 'abstract')
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
        const currentBatchSize = effectiveScreeningType === 'manuscript' ? 4 : BATCH_SIZE
        for (let offset = 0; offset < selectedPapers.length; offset += currentBatchSize) {
          const batch = selectedPapers.slice(offset, offset + currentBatchSize)
          setScreeningProgress(`Screening (${effectiveScreeningType === 'manuscript' ? 'Manuscript' : 'Title/Abstract'}) ${Math.min(offset + batch.length, selectedPapers.length)} of ${selectedPapers.length}`)
          const response = await fetch('/api/screen', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              papers: batch,
              inclusionCriteria,
              exclusionCriteria,
              screeningType: effectiveScreeningType,
            }),
          })
          const payload = await response.json() as { results?: ScreeningResult[]; error?: string }
          if (!response.ok) throw new Error(payload.error || 'Screening request failed.')
          results.push(...(payload.results ?? []))
        }
        const byId = new Map(results.map((result) => [result.id, result]))
        evaluatedPapers = selectedPapers.map((paper) => {
          const result = byId.get(paper.id)
          if (!result) return paper
          const dec = result.include ?? result.decision ?? (result.score !== undefined ? (result.score >= 8 ? 'Yes' : result.score >= 5 ? 'Not Sure' : 'No') : 'Not Sure')
          const expl = result.explanation || result.rationale || ''
          return {
            ...paper,
            include: dec,
            decision: dec,
            explanation: expl,
            rationale: expl,
            aiDecision: dec,
            aiExplanation: expl,
            manualDecision: undefined,
            manualExplanation: undefined,
            decisionSource: 'ai' as DecisionSource,
            score: dec === 'Yes' ? 10 : dec === 'No' ? 0 : 5,
          }
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
              include: p.include || p.decision,
              decision: p.include || p.decision,
              explanation: p.explanation || p.rationale,
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
      if (paper.include || paper.decision) {
        ref.include = paper.include || paper.decision
        ref.decision = paper.include || paper.decision
      }
      if (paper.explanation || paper.rationale) {
        ref.explanation = paper.explanation || paper.rationale
        ref.rationale = paper.explanation || paper.rationale
      }
      if (paper.aiDecision) ref.aiDecision = paper.aiDecision
      if (paper.aiExplanation) ref.aiExplanation = paper.aiExplanation
      if (paper.manualDecision) ref.manualDecision = paper.manualDecision
      if (paper.manualExplanation) ref.manualExplanation = paper.manualExplanation
      if (paper.decisionSource) ref.decisionSource = paper.decisionSource
      if (paper.score !== undefined) ref.score = paper.score
      if (paper.manualVisibility) ref.manualVisibility = paper.manualVisibility
      if (paper.extractedData) ref.extractedData = paper.extractedData
      return ref
    })

    const destination: PaperList = {
      id: destinationId,
      name: destinationName,
      stageType: effectiveStageType,
      screeningType: effectiveStageType === 'screening' ? effectiveScreeningType : (selectedTargetList?.screeningType ?? 'abstract'),
      inclusionCriteria: shouldScreen ? inclusionCriteria.trim() : (createTarget ? inclusionCriteria.trim() : (selectedTargetList?.inclusionCriteria ?? '')),
      exclusionCriteria: shouldScreen ? exclusionCriteria.trim() : (createTarget ? exclusionCriteria.trim() : (selectedTargetList?.exclusionCriteria ?? '')),
      extractionFields: shouldExtract ? validExtractionFields : (createTarget ? (effectiveStageType === 'extraction' ? validExtractionFields : []) : (selectedTargetList?.extractionFields ?? [])),
      synthesisText: shouldSynthesize ? generatedSynthesisText : (selectedTargetList?.synthesisText ?? ''),
      synthesisPrompt: shouldSynthesize ? copySynthesisPrompt.trim() : (createTarget ? copySynthesisPrompt.trim() : (selectedTargetList?.synthesisPrompt ?? '')),
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

    const hasScreening = activeList.stageType === 'screening' || visiblePapers.some((p) => (p.include || p.decision) !== undefined || p.score !== undefined)
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

        if (hasScreening) {
          row['Screening Decision'] = paper.include || paper.decision || (paper.score !== undefined ? (paper.score >= 8 ? 'Yes' : paper.score >= 5 ? 'Not Sure' : 'No') : '')
          row['Decision Source'] = (paper.decisionSource === 'manual' || paper.manualDecision) ? 'Manual Override' : (paper.decisionSource === 'ai' || (paper.include || paper.decision) ? 'AI Screening' : '')
          row['Screening Explanation'] = paper.explanation || paper.rationale || ''
          row['AI Decision'] = paper.aiDecision || (!paper.manualDecision ? (paper.include || paper.decision || '') : '')
          row['AI Explanation'] = paper.aiExplanation || (!paper.manualDecision ? (paper.explanation || '') : '')
          row['Manual Decision'] = paper.manualDecision || ''
          row['Manual Explanation'] = paper.manualExplanation || ''
        }

        for (const f of extractionCols) {
          const raw = paper.extractedData ? paper.extractedData[f.name] : undefined
          const val = getExtractedFieldValue(raw)
          row[f.name] = val
        }

        row['Visibility in Stage'] = isPaperIncluded(paper) ? 'Included' : 'Hidden'
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

        if (hasScreening) {
          headerRow.push(
            { value: 'Screening Decision', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'Decision Source', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'Screening Explanation', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'AI Decision', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'AI Explanation', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'Manual Decision', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
            { value: 'Manual Explanation', fontWeight: 'bold' as const, backgroundColor: '#E8F0E8' },
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

          if (hasScreening) {
            row.push(
              paper.include || paper.decision || (paper.score !== undefined ? (paper.score >= 8 ? 'Yes' : paper.score >= 5 ? 'Not Sure' : 'No') : ''),
              (paper.decisionSource === 'manual' || paper.manualDecision) ? 'Manual Override' : (paper.decisionSource === 'ai' || (paper.include || paper.decision) ? 'AI Screening' : ''),
              paper.explanation || paper.rationale || '',
              paper.aiDecision || (!paper.manualDecision ? (paper.include || paper.decision || '') : ''),
              paper.aiExplanation || (!paper.manualDecision ? (paper.explanation || '') : ''),
              paper.manualDecision || '',
              paper.manualExplanation || '',
            )
          }

          for (const f of extractionCols) {
            const raw = paper.extractedData ? paper.extractedData[f.name] : undefined
            const val = getExtractedFieldValue(raw)
            row.push(val)
          }

          row.push(
            isPaperIncluded(paper) ? 'Included' : 'Hidden',
            paper.manuscript ? 'Yes' : 'No',
          )

          rows.push(row)
        }

        const columns = [
          { width: 40 }, // Title
          { width: 25 }, // Authors
          { width: 10 }, // Year
          { width: 25 }, // Journal
          { width: 20 }, // DOI
          { width: 25 }, // URL
          { width: 50 }, // Abstract
        ]

        if (hasScreening) {
          columns.push({ width: 18 }, { width: 45 })
        }

        for (let i = 0; i < extractionCols.length; i++) {
          columns.push({ width: 30 })
        }

        columns.push({ width: 18 }, { width: 24 })

        await writeXlsxFile(rows as any, {
          columns,
          stickyRowsCount: 1,
        }).toFile(`${fileName}.xlsx`)

        setToast(`Exported ${visiblePapers.length} papers from ${activeList.name} as Excel workbook (.xlsx)`)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not generate Excel export.')
      }
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => { setActiveProjectId(null); setActiveListId(null) }} aria-label="SyntheSys home">
        <span className="brand-mark">
          <img src="/SyntheSys.jpeg" alt="SyntheSys logo" className="brand-logo-img" />
        </span>
        <span>SyntheSys<span className="brand-period">.</span></span>
      </button>
      <div className="side-label">WORKSPACE</div>
      <button className={`nav-link ${!activeProject ? 'active' : ''}`} onClick={() => { setActiveProjectId(null); setActiveListId(null) }}><BookOpen size={16} /><span>All libraries</span><span className="nav-count">{projects.length}</span></button>
      <div className="side-label project-label">YOUR LIBRARIES</div>
      <div className="project-nav">
        {projects.map((project) => (
          <div key={project.id} className={`project-nav-item ${project.id === activeProjectId ? 'active' : ''}`}>
            <button
              className={`nav-link project-nav-link ${project.id === activeProjectId ? 'active' : ''}`}
              onClick={() => { setActiveProjectId(project.id); setActiveListId(project.lists[0]?.id ?? null) }}
            >
              <span className="project-dot" />
              <span className="project-nav-name">{project.name}</span>
              <span className="nav-count">{paperCount(project)}</span>
            </button>
            <button
              type="button"
              className="sidebar-delete-btn"
              title={`Delete ${project.name}`}
              onClick={(e) => {
                e.stopPropagation()
                setProjectToDelete(project)
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <button className="new-project-link" onClick={() => setCreatingProject(true)}><Plus size={15} /> New library</button>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="note-symbol"><img src="/SyntheSys.ico" alt="SyntheSys icon" className="sidebar-note-ico" /></span><span>Evidence, synthesized.</span></div><div className="sidebar-version">SYNTHESYS <span>v0.1</span></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ArrowRight size={13} /><strong>{activeProject?.name ?? 'All libraries'}</strong></div><div className="topbar-right"><button className="icon-button help-button" title="About SyntheSys"><CircleHelp size={17} /></button></div></header>

      {!activeProject ? <section className="projects-page page-enter">
        <div className="page-eyebrow"><span className="eyebrow-line" /> EVIDENCE REVIEW WORKSPACE</div>
        <div className="page-heading-row"><div><h1>Research Synthesis,<br /><em>in clear stages.</em></h1><p className="page-intro">Build a transparent path from search results to a focused evidence set.</p></div><button className="button button-primary" onClick={() => setCreatingProject(true)}><Plus size={16} /> New library</button></div>
        <div className="section-heading"><div><span className="section-kicker">COLLECTION</span><h2>Libraries <span className="heading-count">{projects.length}</span></h2></div></div>
        {projects.length ? (
          <div className="projects-table">
            <div className="projects-table-head">
              <span>LIBRARY</span>
              <span>PAPERS</span>
              <span>STAGES</span>
              <span>CREATED</span>
              <span>ACTIONS</span>
            </div>
            {projects.map((project, index) => (
              <div
                className="project-row"
                key={project.id}
                onClick={() => { setActiveProjectId(project.id); setActiveListId(project.lists[0]?.id ?? null) }}
                style={{ animationDelay: `${index * 45}ms` }}
                role="button"
                tabIndex={0}
              >
                <span className="project-title-cell">
                  <span className="project-icon"><ClipboardList size={17} /></span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.lists[0]?.name ?? 'No stages yet'}</small>
                  </span>
                </span>
                <span className="project-number">{paperCount(project).toLocaleString()}</span>
                <span className="project-number">{project.lists.length}</span>
                <span className="project-date">{new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span className="project-actions-cell">
                  <button
                    type="button"
                    className="icon-button row-delete-btn"
                    title={`Delete ${project.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setProjectToDelete(project)
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                  <span className="row-arrow"><ArrowRight size={16} /></span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-projects">
            <div className="empty-graphic">
              <span className="empty-sheet"><FileSpreadsheet size={23} /></span>
              <span className="empty-spark"><Sparkles size={16} /></span>
            </div>
            <span className="section-kicker">A GOOD PLACE TO BEGIN</span>
            <h3>Start with a research question.</h3>
            <p>Create a library, bring in your search results, and shape a screening workflow that stays easy to review.</p>
            <button className="button button-primary" onClick={() => setCreatingProject(true)}><FolderPlus size={16} /> Create your first library</button>
          </div>
        )}
        <div className="bottom-caption"><span>SYNTHESYS / 01</span><span>MAKE THE EVIDENCE TRACEABLE</span></div>
      </section> : <section className="review-page page-enter">
        <div className="review-dashboard-header">
          <div className="review-heading">
            <div>
              <div className="page-eyebrow"><span className="eyebrow-line" /> REVIEW LIBRARY</div>
              <h1 className="review-title">{activeProject.name}</h1>
              <p className="review-subtitle">A working evidence set, one decision at a time.</p>
            </div>
            <div className="review-heading-actions">
              <button
                type="button"
                className="button button-quiet button-danger"
                onClick={() => setProjectToDelete(activeProject)}
                title="Delete this library"
              >
                <Trash2 size={15} /> Delete library
              </button>
              <button className="button button-primary upload-top" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} /> Upload papers
              </button>
            </div>
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
              <span className="stat-hint">{hiddenCount > 0 ? `${hiddenCount} hidden from this stage` : `${activeList?.name ?? 'Current stage'}`}</span>
            </div>
            <div className="stat-cell">
              <span className="stat-label">AI SCREENED</span>
              <strong>{screenedCount.toLocaleString()}</strong>
              <span className="stat-hint">
                {screenedCount > 0 ? (
                  <span className="screening-stat-breakdown">
                    <b className="stat-breakdown-yes">{yesCount} Yes</b> · <b className="stat-breakdown-notsure">{notSureCount} Not Sure</b> · <b className="stat-breakdown-no">{noCount} No</b>
                  </span>
                ) : (
                  activeList?.stageType === 'screening' && activeList?.screeningType === 'manuscript' ? 'Manuscript screening' : 'Title + abstract screening'
                )}
              </span>
            </div>
            <div className="stat-aside">
              <span className="stat-aside-mark"><ListFilter size={16} /></span>
              <span>{activeList?.stageType === 'screening' && activeList?.screeningType === 'manuscript' ? <>Manuscript<br />screening</> : <>Title + abstract<br />screening</>}</span>
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
                    title={isScreening ? `${list.name} (AI Screening${list.screeningType === 'manuscript' ? ' - Manuscript' : ''})` : isExtraction ? `${list.name} (AI Data Extraction)` : isSynthesis ? `${list.name} (AI Synthesis)` : `${list.name} (Standard)`}
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
                  {(visibilityFilter !== 'included' || decisionFilter !== 'all' || abstractFilter !== 'all' || manuscriptFilter !== 'all' || search) && (
                    <button
                      type="button"
                      className="button button-quiet button-reset-inline"
                      onClick={() => {
                        setVisibilityFilter('included')
                        setDecisionFilter('all')
                        setAbstractFilter('all')
                        setManuscriptFilter('all')
                        setSearch('')
                      }}
                      title="Reset all column filters to defaults"
                    >
                      <RotateCcw size={12} /> Reset Filters
                    </button>
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
                          <th className="visibility-column" title={`Visibility filter: ${visibilityFilter === 'included' ? `Included (${includedCount})` : visibilityFilter === 'hidden' ? `Hidden (${hiddenCount})` : `All (${resolvedActiveListPapers.length})`}`}>
                            <div className="header-visibility-filter-wrap">
                              <select
                                className={`header-visibility-select ${visibilityFilter !== 'included' ? 'is-filtered' : ''}`}
                                value={visibilityFilter}
                                onChange={(e) => setVisibilityFilter(e.target.value as VisibilityFilter)}
                                aria-label="Filter visibility: Included, Hidden, or All"
                                title={`Visibility: ${visibilityFilter === 'included' ? `Included (${includedCount})` : visibilityFilter === 'hidden' ? `Hidden (${hiddenCount})` : `All (${resolvedActiveListPapers.length})`}`}
                              >
                                <option value="included">👁 Included ({includedCount})</option>
                                <option value="hidden">🚫 Hidden ({hiddenCount})</option>
                                <option value="all">📂 All ({resolvedActiveListPapers.length})</option>
                              </select>
                              <div className="header-visibility-indicator">
                                {visibilityFilter === 'included' ? (
                                  <Eye size={13} />
                                ) : visibilityFilter === 'hidden' ? (
                                  <EyeOff size={13} />
                                ) : (
                                  <ListFilter size={13} />
                                )}
                              </div>
                            </div>
                          </th>
                          <th className="paper-heading">
                            <div className="header-filter-wrap header-paper-wrap">
                              <span>PAPER</span>
                              <span className="paper-count-badge">
                                {visiblePapers.length === resolvedActiveListPapers.length
                                  ? resolvedActiveListPapers.length.toLocaleString()
                                  : `${visiblePapers.length} of ${resolvedActiveListPapers.length}`}
                              </span>
                              {resolvedActiveListPapers.length > 0 && (
                                <select
                                  className={`header-filter-select header-abstract-select ${abstractFilter !== 'all' ? 'is-filtered' : ''}`}
                                  value={abstractFilter}
                                  onChange={(e) => setAbstractFilter(e.target.value as AbstractFilter)}
                                  aria-label="Filter by abstract availability"
                                  title="Filter papers by abstract availability"
                                >
                                  <option value="all">Abstract: All ({resolvedActiveListPapers.length})</option>
                                  <option value="has_abstract">Has Abstract ({hasAbstractCount})</option>
                                  <option value="missing_abstract">Missing Abstract ({missingAbstractCount})</option>
                                </select>
                              )}
                            </div>
                          </th>
                          <th className="year-heading">YEAR</th>
                          <th className="journal-heading">SOURCE</th>
                          {(activeList.stageType === 'screening' || resolvedActiveListPapers.some((p) => (p.include || p.decision) !== undefined || p.score !== undefined)) && (
                            <th className="decision-heading">
                              <div className="header-filter-wrap">
                                <span>DECISION</span>
                                <select
                                  className={`header-filter-select ${decisionFilter !== 'all' ? 'is-filtered' : ''}`}
                                  value={decisionFilter}
                                  onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
                                  aria-label="Filter by AI screening decision"
                                  title="Filter by screening decision"
                                >
                                  <option value="all">All ({screenedCount})</option>
                                  <option value="Yes">Yes ({yesCount})</option>
                                  <option value="Not Sure">Not Sure ({notSureCount})</option>
                                  <option value="No">No ({noCount})</option>
                                </select>
                              </div>
                            </th>
                          )}
                          <th className="manuscript-action-heading">
                            <div className="header-filter-wrap">
                              <span>MANUSCRIPT</span>
                              <select
                                className={`header-filter-select ${manuscriptFilter !== 'all' ? 'is-filtered' : ''}`}
                                value={manuscriptFilter}
                                onChange={(e) => setManuscriptFilter(e.target.value as ManuscriptFilter)}
                                aria-label="Filter by manuscript availability"
                                title="Filter by manuscript availability"
                              >
                                <option value="all">All ({resolvedActiveListPapers.length})</option>
                                <option value="missing_manuscript">Missing ({missingManuscriptCount})</option>
                                <option value="has_manuscript">Attached ({hasManuscriptCount})</option>
                              </select>
                            </div>
                          </th>
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
                          const included = isPaperIncluded(paper)
                          const dec = paper.include || paper.decision || (paper.score !== undefined ? (paper.score >= 8 ? 'Yes' : paper.score >= 5 ? 'Not Sure' : 'No') : null)
                          const expl = paper.explanation || paper.rationale
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
                                {paper.abstract && paper.abstract.trim() ? (
                                  <details className="abstract-details">
                                    <summary>Abstract & Screening Remarks</summary>
                                    <p>{paper.abstract}</p>
                                    {/* Manual Reviewer Remarks */}
                                    {(paper.manualExplanation || (paper.decisionSource === 'manual' && expl)) && (
                                      <div className="paper-inline-explanation manual-explanation-block">
                                        <div className="inline-explanation-header manual-explanation-header">
                                          <User size={11} />
                                          <span>MANUAL REVIEWER REMARKS ({dec ? dec.toUpperCase() : 'SCREENING'} · OVERRIDE)</span>
                                          <button
                                            type="button"
                                            className="inline-edit-note-btn"
                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDecisionOverride(paper) }}
                                            title="Edit manual remarks"
                                          >
                                            <Pencil size={9} /> Edit
                                          </button>
                                        </div>
                                        <p className="inline-explanation-text">{paper.manualExplanation || expl}</p>
                                      </div>
                                    )}
                                    {/* AI Screening Remarks */}
                                    {(paper.aiExplanation || (paper.decisionSource !== 'manual' && expl)) && (
                                      <div className="paper-inline-explanation ai-explanation-block">
                                        <div className="inline-explanation-header ai-explanation-header">
                                          <Sparkles size={11} />
                                          <span>
                                            {paper.decisionSource === 'manual' ? `ORIGINAL AI EVALUATION (${paper.aiDecision ? paper.aiDecision.toUpperCase() : 'AI'})` : `AI SCREENING EXPLANATION (${dec ? dec.toUpperCase() : 'EVALUATION'})`}
                                          </span>
                                        </div>
                                        <p className="inline-explanation-text">{paper.aiExplanation || expl}</p>
                                      </div>
                                    )}
                                  </details>
                                ) : (
                                  <div className="paper-no-abstract-wrap">
                                    <span className="missing-abstract-pill">No abstract</span>
                                    {/* Manual Reviewer Remarks */}
                                    {(paper.manualExplanation || (paper.decisionSource === 'manual' && expl)) && (
                                      <div className="paper-inline-explanation manual-explanation-block">
                                        <div className="inline-explanation-header manual-explanation-header">
                                          <User size={11} />
                                          <span>MANUAL REVIEWER REMARKS ({dec ? dec.toUpperCase() : 'SCREENING'} · OVERRIDE)</span>
                                          <button
                                            type="button"
                                            className="inline-edit-note-btn"
                                            onClick={() => openDecisionOverride(paper)}
                                            title="Edit manual remarks"
                                          >
                                            <Pencil size={9} /> Edit
                                          </button>
                                        </div>
                                        <p className="inline-explanation-text">{paper.manualExplanation || expl}</p>
                                      </div>
                                    )}
                                    {/* AI Screening Remarks */}
                                    {(paper.aiExplanation || (paper.decisionSource !== 'manual' && expl)) && (
                                      <div className="paper-inline-explanation ai-explanation-block">
                                        <div className="inline-explanation-header ai-explanation-header">
                                          <Sparkles size={11} />
                                          <span>
                                            {paper.decisionSource === 'manual' ? `ORIGINAL AI EVALUATION (${paper.aiDecision ? paper.aiDecision.toUpperCase() : 'AI'})` : `AI SCREENING EXPLANATION (${dec ? dec.toUpperCase() : 'EVALUATION'})`}
                                          </span>
                                        </div>
                                        <p className="inline-explanation-text">{paper.aiExplanation || expl}</p>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className="year-cell">{paper.year || '—'}</td>
                              <td className="journal-cell">{paper.journal || '—'}</td>
                              {(activeList.stageType === 'screening' || resolvedActiveListPapers.some((p) => (p.include || p.decision) !== undefined || p.score !== undefined)) && (
                                <td className="decision-cell">
                                  {dec ? (
                                    <div className="decision-cell-inner">
                                      <div className="decision-cell-header-row">
                                        <button
                                          type="button"
                                          className={`decision-pill ${dec === 'Yes' ? 'decision-yes' : dec === 'No' ? 'decision-no' : 'decision-notsure'} ${paper.decisionSource === 'manual' || paper.manualDecision ? 'decision-pill-manual' : 'decision-pill-ai'}`}
                                          onClick={() => openDecisionOverride(paper)}
                                          title={`Click to edit or override decision (${paper.decisionSource === 'manual' || paper.manualDecision ? 'Manual Override' : 'AI Screening'})`}
                                        >
                                          {paper.decisionSource === 'manual' || paper.manualDecision ? (
                                            <User size={10} className="decision-source-icon" />
                                          ) : (
                                            <Sparkles size={10} className="decision-source-icon" />
                                          )}
                                          {dec === 'Yes' && <Check size={11} />}
                                          {dec === 'Not Sure' && <CircleHelp size={11} />}
                                          {dec === 'No' && <X size={11} />}
                                          <span>{dec}</span>
                                          <span className="decision-badge-source">
                                            {paper.decisionSource === 'manual' || paper.manualDecision ? 'Manual' : 'AI'}
                                          </span>
                                        </button>
                                        <button
                                          type="button"
                                          className="decision-quick-edit-btn"
                                          onClick={() => openDecisionOverride(paper)}
                                          title="Override decision or edit remarks"
                                        >
                                          <Pencil size={10} />
                                        </button>
                                      </div>
                                      {expl && (
                                        <div
                                          className={`decision-reason ${paper.decisionSource === 'manual' || paper.manualDecision ? 'decision-reason-manual' : 'decision-reason-ai'}`}
                                          title={expl}
                                          onClick={() => openDecisionOverride(paper)}
                                        >
                                          {paper.decisionSource === 'manual' || paper.manualDecision ? (
                                            <User size={8} className="reason-source-icon" />
                                          ) : (
                                            <Sparkles size={8} className="reason-source-icon" />
                                          )}
                                          <span>{expl}</span>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      className="not-screened not-screened-btn"
                                      onClick={() => openDecisionOverride(paper)}
                                      title="Set screening decision & comment"
                                    >
                                      <span>Unscreened</span>
                                      <Plus size={10} />
                                    </button>
                                  )}
                                </td>
                              )}
                              <td className="manuscript-actions-cell">
                                {!paper.manuscript && (
                                  <button
                                    className="row-manuscript-button retrieve"
                                    type="button"
                                    onClick={() => void handleSingleFetch(paper)}
                                    disabled={fetchingPaperId === paper.id || uploadingPaperId === paper.id}
                                    title="Retrieve open-access full-text PDF online (Unpaywall, PMC, arXiv, OpenAlex)"
                                    aria-label={`Retrieve PDF for ${paper.title}`}
                                  >
                                    {fetchingPaperId === paper.id ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
                                  </button>
                                )}
                                <button className="row-manuscript-button" type="button" onClick={() => chooseManuscriptFile(paper.id)} disabled={uploadingPaperId === paper.id || fetchingPaperId === paper.id} title={paper.manuscript ? 'Replace manuscript PDF' : 'Attach manuscript PDF manually'} aria-label={paper.manuscript ? `Replace PDF for ${paper.title}` : `Attach PDF for ${paper.title}`}>
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
                    {!visiblePapers.length && <div className="no-matches"><Search size={18} /><span>{visibilityFilter === 'hidden' ? 'No hidden papers in this stage.' : 'No papers match this search and filter criteria.'}</span></div>}
                  </div>
                ) : (
                  <div className="empty-list">
                    <span className="empty-list-icon"><FileSpreadsheet size={22} /></span>
                    <div>
                      <h3>{activeList.papers.length ? 'No papers matching this filter' : 'Bring in your search results or copy papers here'}</h3>
                      <p>{activeList.papers.length ? 'Adjust your visibility or decision filters to see more papers.' : 'Upload a CSV or Excel file, or copy papers from an earlier stage.'}</p>
                    </div>
                    {activeList.papers.length ? (
                      <button className="button button-secondary" onClick={() => { setVisibilityFilter('all'); setDecisionFilter('all'); setAbstractFilter('all'); setManuscriptFilter('all'); setSearch('') }}>Reset filters</button>
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

          <div className="bottom-caption"><span>SYNTHESYS / {String(activeProject.lists.findIndex((list) => list.id === activeListId) + 1).padStart(2, '0')}</span><span>DECISIONS STAY WITH THE PAPER</span></div>
        </div>
      </section>}
    </main>

    <input ref={manuscriptInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={(event) => void handleManuscriptFile(event.target.files?.[0])} />
    {manuscriptPaper?.manuscript && <ManuscriptPanel paper={manuscriptPaper as Paper & { manuscript: ManuscriptMetadata }} onClose={() => setManuscriptPaper(null)} />}

    {/* Override Screening Decision & Remarks Modal */}
    {overrideTargetPaper && (
      <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOverrideTargetPaper(null) }}>
        <section className="modal override-modal" aria-labelledby="override-modal-title">
          <div className="modal-topline">
            <span className="modal-icon modal-icon-accent"><User size={17} /></span>
            <button type="button" className="icon-button" onClick={() => setOverrideTargetPaper(null)} title="Close"><X size={17} /></button>
          </div>

          <span className="section-kicker">MANUAL SCREENING OVERRIDE</span>
          <h2 id="override-modal-title">Override Screening Decision</h2>
          <p className="modal-description">Set or update your manual reviewer decision and screening remarks for this paper.</p>

          {/* Paper summary card */}
          <div className="override-paper-card">
            <div className="override-paper-title">{overrideTargetPaper.title}</div>
            <div className="override-paper-meta">
              <span>{overrideTargetPaper.authors || 'Author not listed'}</span>
              {overrideTargetPaper.year && <span> · {overrideTargetPaper.year}</span>}
              {overrideTargetPaper.journal && <span> · {overrideTargetPaper.journal}</span>}
            </div>
          </div>

          {/* AI recommendation preview box (if paper was evaluated by AI) */}
          {(overrideTargetPaper.aiDecision || (overrideTargetPaper.decisionSource !== 'manual' && (overrideTargetPaper.include || overrideTargetPaper.decision))) && (
            <div className="override-ai-card">
              <div className="override-ai-header">
                <div className="override-ai-tag">
                  <Sparkles size={11} />
                  <span>AI RECOMMENDATION</span>
                </div>
                {(() => {
                  const aiDec = overrideTargetPaper.aiDecision || overrideTargetPaper.include || overrideTargetPaper.decision
                  return (
                    <span className={`decision-pill ${aiDec === 'Yes' ? 'decision-yes' : aiDec === 'No' ? 'decision-no' : 'decision-notsure'}`}>
                      {aiDec === 'Yes' && <Check size={10} />}
                      {aiDec === 'Not Sure' && <CircleHelp size={10} />}
                      {aiDec === 'No' && <X size={10} />}
                      <span>{aiDec}</span>
                    </span>
                  )
                })()}
              </div>
              <p className="override-ai-reason">
                {overrideTargetPaper.aiExplanation || (overrideTargetPaper.decisionSource !== 'manual' ? overrideTargetPaper.explanation : '') || 'No AI rationale provided.'}
              </p>
              {(overrideTargetPaper.aiExplanation || (overrideTargetPaper.decisionSource !== 'manual' && overrideTargetPaper.explanation)) && (
                <button
                  type="button"
                  className="override-copy-ai-btn"
                  onClick={() => setOverrideComment(overrideTargetPaper.aiExplanation || overrideTargetPaper.explanation || '')}
                  title="Copy AI explanation into your comment"
                >
                  <ClipboardList size={11} /> Copy AI note into comment
                </button>
              )}
            </div>
          )}

          {/* Decision Selector */}
          <div className="override-form-group">
            <label className="field-label">REVIEWER DECISION</label>
            <div className="decision-radio-group">
              {(['Yes', 'Not Sure', 'No', 'unscreened'] as const).map((decOption) => {
                const isSelected = overrideDecision === decOption
                return (
                  <button
                    key={decOption}
                    type="button"
                    className={`decision-option-btn ${isSelected ? 'selected' : ''} ${decOption === 'Yes' ? 'opt-yes' : decOption === 'No' ? 'opt-no' : decOption === 'Not Sure' ? 'opt-notsure' : 'opt-unscreened'}`}
                    onClick={() => setOverrideDecision(decOption)}
                  >
                    {decOption === 'Yes' && <Check size={13} />}
                    {decOption === 'Not Sure' && <CircleHelp size={13} />}
                    {decOption === 'No' && <X size={13} />}
                    {decOption === 'unscreened' && <RotateCcw size={13} />}
                    <span>{decOption === 'unscreened' ? 'Clear (Unscreened)' : decOption}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Comment / Explanation */}
          <div className="override-form-group">
            <label className="field-label" htmlFor="override-comment-input">
              REVIEWER REMARKS / EXPLANATION
            </label>
            <textarea
              id="override-comment-input"
              className="text-field override-textarea"
              rows={4}
              value={overrideComment}
              onChange={(e) => setOverrideComment(e.target.value)}
              placeholder="Explain your manual screening decision, inclusion/exclusion rationale, or study notes..."
            />
          </div>

          <div className="modal-actions override-modal-actions">
            {overrideTargetPaper.decisionSource === 'manual' && (overrideTargetPaper.aiDecision || overrideTargetPaper.aiExplanation) ? (
              <button
                type="button"
                className="button button-quiet override-revert-btn"
                onClick={() => saveDecisionOverride(overrideTargetPaper.id, 'unscreened', '', true)}
                title="Discard manual override and revert to AI screening result"
              >
                <RotateCcw size={13} /> Revert to AI
              </button>
            ) : <span />}
            <div className="override-right-actions">
              <button type="button" className="button button-quiet" onClick={() => setOverrideTargetPaper(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => saveDecisionOverride(overrideTargetPaper.id, overrideDecision, overrideComment, false)}
              >
                <User size={13} /> Save Decision
              </button>
            </div>
          </div>
        </section>
      </div>
    )}

    {/* Section Mapping Modal (Triggered on PDF Upload or on demand) */}
    {sectionMappingTarget && (
      <SectionMappingModal
        paperId={sectionMappingTarget.paperId}
        paperTitle={sectionMappingTarget.paperTitle}
        document={sectionMappingTarget.document}
        isInitialUpload={sectionMappingTarget.isInitialUpload}
        onClose={() => setSectionMappingTarget(null)}
        onSave={() => {
          setToast('Section mappings saved successfully')
        }}
      />
    )}

    {/* Selection Bar */}
    {activeList && selectedIds.size > 0 && <div className="selection-bar">
      <span><strong>{selectedIds.size.toLocaleString()}</strong> selected <button className="clear-selection" onClick={() => setSelectedIds(new Set())}>Clear</button></span>
      <div className="selection-actions">
        <button type="button" className="button button-selection-action" onClick={() => setSelectionVisibility('show')} title="Show selected in stage"><Eye size={14} /> Show</button>
        <button type="button" className="button button-selection-action" onClick={() => setSelectionVisibility('hide')} title="Hide selected from stage"><EyeOff size={14} /> Hide</button>
        <button
          type="button"
          className="button button-selection-action button-retrieve-fulltext"
          onClick={() => void handleRetrieveSelectedFullText()}
          disabled={retrievingFullText}
          title="Pull open-access manuscript PDFs for selected papers (Unpaywall, Europe PMC, arXiv, OpenAlex, Semantic Scholar)"
        >
          {retrievingFullText ? (
            <>
              <LoaderCircle size={14} className="spin" /> {retrievingProgress || 'Retrieving...'}
            </>
          ) : (
            <>
              <ArrowDownToLine size={14} /> Retrieve Full Text
            </>
          )}
        </button>
        <button className="button button-selection" onClick={openCopyDialog}><ArrowRight size={15} /> Copy to Stage <ChevronDown size={14} /></button>
      </div>
    </div>}

    {/* Create Library Modal */}
    {creatingProject && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreatingProject(false) }}><form className="modal project-modal" onSubmit={(event) => { event.preventDefault(); createProject() }}><div className="modal-topline"><span className="modal-icon"><FolderPlus size={17} /></span><button type="button" className="icon-button" onClick={() => setCreatingProject(false)} title="Close"><X size={17} /></button></div><span className="section-kicker">NEW LIBRARY</span><h2>Create a library</h2><p className="modal-description">Give this library a name. You can organize papers into screening stages inside it.</p><label className="field-label" htmlFor="project-name">LIBRARY NAME</label><input id="project-name" className="text-field" autoFocus maxLength={80} placeholder="e.g. Digital health interventions" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setCreatingProject(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!projectName.trim()}><Plus size={15} /> Create library</button></div></form></div>}

    {/* Delete Library Confirmation Modal */}
    {projectToDelete && (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectToDelete(null) }}>
        <section className="modal delete-modal" aria-labelledby="delete-library-title">
          <div className="modal-topline">
            <span className="modal-icon modal-icon-danger"><Trash2 size={18} /></span>
            <button type="button" className="icon-button" onClick={() => setProjectToDelete(null)} title="Close"><X size={17} /></button>
          </div>
          <span className="section-kicker section-kicker-danger">PERMANENT ACTION</span>
          <h2 id="delete-library-title">Delete Library?</h2>
          <p className="modal-description">
            Are you sure you want to delete <strong>{projectToDelete.name}</strong>?
          </p>
          <div className="delete-modal-warning">
            This will permanently remove the library, all <strong>{projectToDelete.lists.length}</strong> {projectToDelete.lists.length === 1 ? 'stage' : 'stages'}, and <strong>{paperCount(projectToDelete).toLocaleString()}</strong> associated papers. This action cannot be undone.
          </div>
          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={() => setProjectToDelete(null)}>Cancel</button>
            <button type="button" className="button button-danger-solid" onClick={() => void confirmDeleteProject()}><Trash2 size={15} /> Delete library</button>
          </div>
        </section>
      </div>
    )}

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
              <label className="field-label criteria-label" htmlFor="stage-screening-type">
                SCREENING SOURCE / TYPE
              </label>
              <select
                id="stage-screening-type"
                className="text-field select-field"
                value={stageDraftScreeningType}
                onChange={(e) => setStageDraftScreeningType(e.target.value as ScreeningType)}
              >
                <option value="abstract">Title / Abstract</option>
                <option value="manuscript">Manuscript</option>
              </select>
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
                  setCopyScreeningType(targetL.screeningType ?? 'abstract')
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
                  {list.name} {list.stageType === 'screening' ? `(AI Screening${list.screeningType === 'manuscript' ? ' - Manuscript' : ''})` : list.stageType === 'extraction' ? '(AI Data Extraction)' : list.stageType === 'synthesis' ? '(AI Synthesis)' : '(Standard)'}
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
              <label className="field-label criteria-label" htmlFor="copy-screening-type">
                SCREENING SOURCE / TYPE
              </label>
              <select
                id="copy-screening-type"
                className="text-field select-field"
                value={copyScreeningType}
                onChange={(e) => setCopyScreeningType(e.target.value as ScreeningType)}
                disabled={screening || extracting || synthesizing}
              >
                <option value="abstract">Title / Abstract</option>
                <option value="manuscript">Manuscript</option>
              </select>
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
                {copyScreeningType === 'manuscript'
                  ? `Full manuscript text of the ${selectedPapers.length} selected papers will be evaluated by LLM against inclusion and exclusion criteria with detailed evidence-based explanations in the destination stage.`
                  : `Titles and abstracts of the ${selectedPapers.length} selected papers will be evaluated by LLM to classify inclusion (Yes, No, Not Sure) with detailed evidence-based explanations in the destination stage.`}
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

    {/* Full-Text Retrieval Summary Modal */}
    {retrievalSummary && (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRetrievalSummary(null) }}>
        <section className="modal retrieval-summary-modal" aria-labelledby="retrieval-summary-title">
          <div className="modal-topline">
            <span className="modal-icon"><ArrowDownToLine size={17} /></span>
            <button type="button" className="icon-button" onClick={() => setRetrievalSummary(null)} title="Close"><X size={17} /></button>
          </div>
          <span className="section-kicker">MANUSCRIPT RETRIEVAL</span>
          <h2 id="retrieval-summary-title">Full-Text Retrieval Summary</h2>
          <p className="modal-description">
            Open-access discovery across Unpaywall, PubMed Central, OpenAlex, Semantic Scholar, and arXiv.
          </p>

          <div className="retrieval-stats-strip">
            <div className="retrieval-stat-item">
              <span>TOTAL PAPERS</span>
              <strong>{retrievalSummary.total}</strong>
            </div>
            {retrievalSummary.skippedCount !== undefined && retrievalSummary.skippedCount > 0 && (
              <div className="retrieval-stat-item skipped">
                <span>ALREADY ATTACHED</span>
                <strong>{retrievalSummary.skippedCount}</strong>
              </div>
            )}
            <div className="retrieval-stat-item succeeded">
              <span>RETRIEVED &amp; PARSED</span>
              <strong>{retrievalSummary.succeededCount}</strong>
            </div>
            <div className="retrieval-stat-item failed">
              <span>UNAVAILABLE / PAYWALLED</span>
              <strong>{retrievalSummary.failedCount}</strong>
            </div>
          </div>

          <div className="retrieval-results-scroll">
            {retrievalSummary.results.map((res) => (
              <div key={res.id} className="retrieval-result-row">
                <div className="retrieval-result-info">
                  <div className="retrieval-result-title" title={res.title}>{res.title}</div>
                  <div className="retrieval-result-detail">
                    {res.success ? (
                      <>
                        <span className="retrieval-source-pill"><Check size={11} /> {res.source || 'Open Access'}</span>
                        <span>· {res.pageCount ?? 0} pages ({res.lineCount ?? 0} lines)</span>
                      </>
                    ) : (
                      <>
                        <span className="retrieval-source-pill failed-pill"><X size={11} /> Not Available</span>
                        <span title={res.error}>{res.error || 'Behind paywall or no OA repository found'}</span>
                      </>
                    )}
                  </div>
                </div>
                {!res.success && (
                  <button
                    type="button"
                    className="retrieval-manual-upload-btn"
                    onClick={() => {
                      chooseManuscriptFile(res.id)
                    }}
                    title="Upload PDF manually"
                  >
                    <Upload size={12} /> Upload PDF
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="modal-actions">
            <button type="button" className="button button-primary" onClick={() => setRetrievalSummary(null)}>
              <Check size={15} /> Done
            </button>
          </div>
        </section>
      </div>
    )}

    {toast && <div className="toast"><Check size={15} /> {toast}</div>}
  </div>
}

export default App