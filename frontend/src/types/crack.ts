export type CrackStatus = '待处理' | '已处理'

export interface CrackResolution {
  /** 重刻：同木段版片全部另刻新版；沿用原印样：木段继续留用，版片恢复原态 */
  kind: '重刻' | '沿用原印样'
  basis: string
  decidedBy: string
  decidedAt: string
  /** 重刻时新版所挂的木段；留空表示新料未到、先登记待料 */
  newWoodLogId?: string
}

export interface CrackLog {
  id: string
  /** 裂纹沿哪一根木段追溯，影响范围一律按木段判断 */
  woodLogId: string
  /** 最先发现裂纹的版片 */
  blockId: string
  draftId: string
  foundAt: string
  description: string
  reporter: string
  status: CrackStatus
  /** 提交端生成的幂等令牌，写入失败重试时沿用，保证同一裂纹不会落两条工单 */
  clientToken: string
  /** 提交时木段的版本号快照 */
  woodVersionAtSubmit: number
  createdAt: string
  resolvedAt?: string
  resolution?: CrackResolution
}
