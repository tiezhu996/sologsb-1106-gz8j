import { writable } from 'svelte/store'
import type { WoodLog } from '../types/woodLog'
import { db } from '../utils/db'
import { broadcastArchiveChanged } from '../utils/broadcast'

const woodLogList = writable<WoodLog[]>([])

async function load(): Promise<void> {
  const records = await db.woodLogs.toArray()
  records.sort(
    (a, b) =>
      b.receivedAt.localeCompare(a.receivedAt) || a.logNo.localeCompare(b.logNo, 'zh-CN'),
  )
  woodLogList.set(records)
}

async function create(input: Omit<WoodLog, 'id' | 'woodVersion'>): Promise<string> {
  const id = `wood-${crypto.randomUUID()}`
  await db.woodLogs.add({ id, woodVersion: 1, ...input })
  await load()
  broadcastArchiveChanged()
  return id
}

async function update(id: string, changes: Partial<Pick<WoodLog, 'logNo' | 'sourceNote' | 'status'>>): Promise<void> {
  await db.woodLogs.update(id, changes)
  await load()
  broadcastArchiveChanged()
}

/**
 * 把版片挂到木段（或改挂）。挂段会改变裂纹影响范围，
 * 因此同事务把木段版本号加一，令仍停在旧版本的裂纹提交先看到冲突。
 */
async function attachBlocks(woodLogId: string, blockIds: string[]): Promise<number> {
  let nextVersion = 0
  await db.transaction('rw', db.woodLogs, db.blocks, async () => {
    const woodLog = await db.woodLogs.get(woodLogId)
    if (!woodLog) throw new Error('木段不存在，无法挂接版片。')
    for (const blockId of blockIds) {
      await db.blocks.update(blockId, { woodLogId })
    }
    nextVersion = woodLog.woodVersion + 1
    await db.woodLogs.update(woodLogId, { woodVersion: nextVersion })
  })
  await load()
  broadcastArchiveChanged()
  return nextVersion
}

async function detachBlocks(blockIds: string[]): Promise<void> {
  const woodLogIds = new Set<string>()
  await db.transaction('rw', db.woodLogs, db.blocks, async () => {
    for (const blockId of blockIds) {
      const block = await db.blocks.get(blockId)
      if (block?.woodLogId) woodLogIds.add(block.woodLogId)
      await db.blocks.update(blockId, { woodLogId: undefined })
    }
    for (const woodLogId of woodLogIds) {
      const woodLog = await db.woodLogs.get(woodLogId)
      if (woodLog) await db.woodLogs.update(woodLogId, { woodVersion: woodLog.woodVersion + 1 })
    }
  })
  await load()
  broadcastArchiveChanged()
}

export const woodLogStore = {
  subscribe: woodLogList.subscribe,
  load,
  create,
  update,
  attachBlocks,
  detachBlocks,
}
