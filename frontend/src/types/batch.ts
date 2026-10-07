export type BatchReviewState = '有效' | '待复核' | '已复核'

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
  /** 最近一次复核留下的依据 */
  reviewNote: string
}
