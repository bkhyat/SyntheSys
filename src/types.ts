export type LineReference = { page_number: number; line_number: number }
export type BoundingBox = { x0: number; top: number; x1: number; bottom: number }
export type DocumentLine = { page_number: number; line_number: number; text: string; bbox: BoundingBox; font_size: number }

export type SectionNode = {
  title: string
  original_title?: string
  standard_section?: string | null
  is_excluded_from_llm?: boolean
  level: number
  start_page: number
  end_page: number
  start_line: number
  line_refs: LineReference[]
  children: SectionNode[]
  summary?: string
}

export type MappedSectionItem = {
  standard_section: string
  original_title: string
  page: number
  line: number
  level: number
}

export type UnmatchedSectionItem = {
  original_title: string
  page: number
  line: number
  level: number
}

export type ReferencesSectionItem = {
  original_title: string
  page: number
  line: number
  line_count: number
}

export type Figure = {
  label: string
  caption: string
  page_number: number
  line_refs: LineReference[]
  image_bbox?: BoundingBox
}

export type Table = {
  label: string
  caption: string | null
  page_number: number
  bbox: BoundingBox
  line_refs: LineReference[]
  cells: (string | null)[][]
}

export type Reference = {
  label: string
  text: string
  page_number: number
  line_refs: LineReference[]
}

export type ManuscriptDocument = {
  file_name: string
  page_count: number
  line_count: number
  extracted_at: string
  overall_summary?: string
  sections: SectionNode[]
  mapped_sections?: MappedSectionItem[]
  unmatched_sections?: UnmatchedSectionItem[]
  references_section?: ReferencesSectionItem | null
  pages: { page_number: number; width: number; height: number; lines: DocumentLine[] }[]
  figures: Figure[]
  tables: Table[]
  references: Reference[]
  warnings: string[]
}

export type ManuscriptMetadata = {
  fileName: string
  pageCount: number
  lineCount: number
  extractedAt: string
  warnings: string[]
}