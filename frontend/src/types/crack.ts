export type CrackState = '待处理' | '排查中' | '已办结'

export interface CrackReport {
  id: string
  segmentId: string
  position: string
  detail: string
  foundBy: string
  foundAt: string
  state: CrackState
  /** 立案时按木段全量快照，之后不随换料、重刻缩小 */
  affectedBlockIds: string[]
  affectedDraftIds: string[]
}

export type ReviewDecision = '沿用原印样' | '重刻'

export interface ReviewRecord {
  id: string
  crackId: string
  batchId: string
  decision: ReviewDecision
  evidence: string
  operator: string
  createdAt: string
}
