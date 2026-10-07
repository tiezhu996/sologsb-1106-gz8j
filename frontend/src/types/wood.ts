import type { WoodType } from './block'

export type WoodSegmentState = '在用' | '待换料' | '已停用'

export interface WoodSegment {
  id: string
  segmentNo: string
  woodType: WoodType
  sourceBatch: string
  receivedAt: string
  sizeNote: string
  state: WoodSegmentState
  note: string
}
