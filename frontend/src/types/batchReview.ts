import type { BatchReviewKind } from './batch'

export type { BatchReviewKind }

export interface BatchReview {
  id: string
  batchId: string
  crackId: string
  /** 复核结论：重刻新版后重印，或沿用本批原印样 */
  kind: BatchReviewKind
  /** 复核依据（原印样检查结论 / 重刻校样对比等） */
  basis: string
  reviewer: string
  reviewedAt: string
  /** 本次复核结论对应的木段版本，便于日后按木段版本追溯 */
  woodVersion: number
}
