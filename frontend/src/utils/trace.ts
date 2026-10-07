import type { Block } from '../types/block'
import type { PrintBatch } from '../types/batch'
import type { ProcessNode } from '../types/node'

/**
 * 沿木段求关联版片：
 * 含已停用旧版——旧版虽因重刻停用，其印过的批次仍要复核，
 * 范围按木段判断而不按版片现状缩小。
 */
export function blocksFromWoodLog(blocks: Block[], woodLogId: string): Block[] {
  return blocks.filter((block) => block.woodLogId === woodLogId)
}

/** 木段波及的画稿：只要该画稿有任一版片出自这段木料，其批次都要复核 */
export function draftIdsFromWoodLog(blocks: Block[], woodLogId: string): string[] {
  return [...new Set(blocksFromWoodLog(blocks, woodLogId).map((block) => block.draftId))]
}

export interface WoodLogImpact {
  blocks: Block[]
  /** 已刻（含已修版、在刻）版片：已刻节点保留，只转复核 */
  carvedBlocks: Block[]
  /** 尚未刻制版片：直接转待换料 */
  uncarvedBlocks: Block[]
  nodes: ProcessNode[]
  batches: PrintBatch[]
  draftIds: string[]
}

/** 裂纹一出现就沿木段找出关联工序节点和印制批次 */
export function impactOfWoodLog(input: {
  woodLogId: string
  blocks: Block[]
  nodes: ProcessNode[]
  batches: PrintBatch[]
}): WoodLogImpact {
  const affectedBlocks = blocksFromWoodLog(input.blocks, input.woodLogId)
  const affectedBlockIds = new Set(affectedBlocks.map((block) => block.id))
  const draftIds = [...new Set(affectedBlocks.map((block) => block.draftId))]
  const draftSet = new Set(draftIds)

  const carvedBlocks = affectedBlocks.filter(
    (block) => block.state === '已刻成' || block.state === '已修版' || block.state === '在刻',
  )
  const uncarvedBlocks = affectedBlocks.filter((block) => block.state === '待刻')

  return {
    blocks: affectedBlocks,
    carvedBlocks,
    uncarvedBlocks,
    nodes: input.nodes.filter((node) => node.blockId !== undefined && affectedBlockIds.has(node.blockId)),
    batches: input.batches.filter((batch) => draftSet.has(batch.draftId)),
    draftIds,
  }
}

/** 已刻判定：在刻也视为已有刻制投入，其节点保留、版片不直接报废 */
export function isCarvedBlock(block: Block): boolean {
  return block.state === '已刻成' || block.state === '已修版' || block.state === '在刻'
}

/** 重刻别名：旧编号后加「-旧」留档可查 */
export function aliasForOldBlock(block: Block): string {
  return block.alias ?? `${block.id}-旧`
}

/**
 * 返回一条版片的重刻链（旧→新）。
 * 从任意一节切入都会先回溯到最早旧版，再沿 replacedByBlockId 走到最新版。
 */
export function blockLineage(blocks: Block[], startBlockId: string): Block[] {
  const byId = new Map(blocks.map((block) => [block.id, block]))
  let current = byId.get(startBlockId)
  if (!current) return []

  const chain: Block[] = []
  while (current.replacesBlockId && byId.has(current.replacesBlockId)) {
    current = byId.get(current.replacesBlockId)!
  }
  const seen = new Set<string>()
  let cursor: Block | undefined = current
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.push(cursor)
    cursor = cursor.replacedByBlockId ? byId.get(cursor.replacedByBlockId) : undefined
  }
  return chain
}
