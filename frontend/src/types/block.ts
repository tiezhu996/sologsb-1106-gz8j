export type BlockName = '墨线版' | '黄版' | '红版' | '绿版'
export type WoodType = '梨木' | '黄杨'
/** 已停用：裂纹木段重刻后旧版留档，挂别名仍可查 */
export type BlockState = '待刻' | '在刻' | '已刻成' | '已修版' | '待换料' | '已停用'

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
  /** 所属木段，裂纹影响范围按此追溯 */
  woodLogId?: string
  /** 重刻后旧版保留的别名，便于按旧编号查回 */
  alias?: string
  /** 旧版重刻时指向替代新版，旧版本身停用留档；已刻节点仍挂在旧版上 */
  replacedByBlockId?: string
  /** 新版回指重刻前的旧版 */
  replacesBlockId?: string
}
