import type { WoodType } from './block'

export type { WoodType }

export type WoodLogStatus = '在用' | '停用'

export interface WoodLog {
  id: string
  /** 木段编号，如「梨木-2511-甲段」 */
  logNo: string
  woodType: WoodType
  receivedAt: string
  sourceNote: string
  status: WoodLogStatus
  /**
   * 木段版本号：裂纹上报、版片挂段等改变影响范围的写入都会令其自增，
   * 提交时携带打开表单时读到的版本号，用于两个标签页并发提交的冲突检测。
   */
  woodVersion: number
}
