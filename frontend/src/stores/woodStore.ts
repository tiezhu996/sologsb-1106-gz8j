import { writable } from 'svelte/store'
import type { WoodSegment } from '../types/wood'
import { db } from '../utils/db'
import { blockStore } from './blockStore'

const segmentList = writable<WoodSegment[]>([])

async function load(): Promise<void> {
  const records = await db.segments.toArray()
  records.sort((a, b) => a.segmentNo.localeCompare(b.segmentNo, 'zh-CN'))
  segmentList.set(records)
}

async function createSegment(input: Omit<WoodSegment, 'id' | 'state'>): Promise<string> {
  const id = `seg-${crypto.randomUUID()}`
  await db.segments.add({ ...input, id, state: '在用' })
  await load()
  return id
}

/**
 * 挂段与换料共用一个入口：
 * - 未挂段版片：只登记去向；
 * - 待换料版片：换上在用木段并回到待刻。
 * 一次事务写完，失败整体回滚，不留半套换料记录。
 */
async function assignSegment(blockId: string, segmentId: string): Promise<void> {
  await db.transaction('rw', [db.blocks, db.segments], async () => {
    const block = await db.blocks.get(blockId)
    if (!block) throw new Error('版片不存在，请刷新后重试')
    const segment = await db.segments.get(segmentId)
    if (!segment || segment.state !== '在用') throw new Error('木段不在在用状态，不能挂版')
    if (segment.woodType !== block.woodType) throw new Error('木料不符，不能挂到该木段')
    if (block.state === '待换料') {
      await db.blocks.update(blockId, { segmentId, state: '待刻' })
    } else {
      await db.blocks.update(blockId, { segmentId })
    }
  })
  await Promise.all([load(), blockStore.load()])
}

export const woodStore = {
  subscribe: segmentList.subscribe,
  load,
  createSegment,
  assignSegment,
}
