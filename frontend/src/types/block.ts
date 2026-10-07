export type BlockName = '墨线版' | '黄版' | '红版' | '绿版'
export type WoodType = '梨木' | '黄杨'
export type BlockState = '待刻' | '在刻' | '已刻成' | '已修版' | '待换料' | '已更换'

export interface Block {
  id: string
  draftId: string
  blockName: BlockName
  colorNo: number
  woodType: WoodType
  thicknessMm: number
  carvedBy: string
  state: BlockState
  defectNote: string
  /** 所挂木段，空串表示尚未挂段 */
  segmentId: string
  /** 重刻后旧版留名，空串表示现行版 */
  alias: string
  /** 重刻后指向接替的新版，空串表示无 */
  replacedById: string
}
