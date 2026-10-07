/** 待复核：裂纹沿木段波及该批，旧印样是否沿用须逐批留依据后才能结案 */
export type BatchReviewState = '正常' | '待复核'

/** 批次复核结论：重刻新版后重印，或沿用本批原印样 */
export type BatchReviewKind = '重刻' | '沿用原印样'

export interface PrintBatch {
  id: string
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  reviewState: BatchReviewState
  /** 最近一次令本批转待复核的裂纹工单 */
  invalidatedByCrackId?: string
  invalidatedAt?: string
}
