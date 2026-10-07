import { writable } from 'svelte/store'
import { db } from '../utils/db'
import { blockStore } from './blockStore'
import { draftStore } from './draftStore'
import { woodStore } from './woodStore'
import { CrackConflictError, crackIdFor, normalizeCrackPosition } from '../utils/crack'
import type { CrackReport, ReviewDecision } from '../types/crack'

const crackList = writable<CrackReport[]>([])

async function load(): Promise<void> {
  const records = await db.cracks.toArray()
  records.sort((a, b) => b.foundAt.localeCompare(a.foundAt) || b.id.localeCompare(a.id))
  crackList.set(records)
}

async function refreshLinkedStores(): Promise<void> {
  await Promise.all([load(), blockStore.load(), draftStore.load(), woodStore.load()])
}

/**
 * 登记裂纹。记录 id 由「木段 + 裂纹位置」确定性生成，
 * 两个标签页同时提交同一裂纹时，后提交者在写入前即看到冲突。
 */
async function submitCrack(input: {
  segmentId: string
  position: string
  detail: string
  foundBy: string
}): Promise<string> {
  const id = crackIdFor(input.segmentId, input.position)
  const report: CrackReport = {
    id,
    segmentId: input.segmentId,
    position: normalizeCrackPosition(input.position),
    detail: input.detail.trim(),
    foundBy: input.foundBy.trim(),
    foundAt: new Date().toISOString().slice(0, 16),
    state: '待处理',
    affectedBlockIds: [],
    affectedDraftIds: [],
  }
  try {
    await db.transaction('rw', db.cracks, async () => {
      const existing = await db.cracks.get(id)
      if (existing) throw new CrackConflictError(existing.id)
      await db.cracks.add(report)
    })
  } catch (error) {
    // 同步另一窗口已写入的记录，便于界面定位到现有裂纹
    await load()
    throw error
  }
  await load()
  return id
}

/**
 * 立案排查：范围按木段全量判断，不按版片现状缩小。
 * 未刻版片转待换料；已刻节点保留不动；关联批次（含已印）全部转待复核。
 * 整个处置在一个事务内完成，写入失败后裂纹留在待处理，可整体重试。
 */
async function processCrack(crackId: string): Promise<void> {
  try {
    await db.transaction('rw', [db.cracks, db.blocks, db.batches, db.segments], async () => {
      const crack = await db.cracks.get(crackId)
      if (!crack) throw new Error('裂纹记录不存在，请刷新后重试')
      if (crack.state !== '待处理') throw new Error('该裂纹已在其他窗口立案，请刷新查看')

      const segmentBlocks = await db.blocks.where('segmentId').equals(crack.segmentId).toArray()
      const affectedBlockIds = segmentBlocks.map((block) => block.id)
      const affectedDraftIds = [...new Set(segmentBlocks.map((block) => block.draftId))]

      for (const block of segmentBlocks) {
        if (block.state === '待刻' || block.state === '在刻') {
          await db.blocks.update(block.id, { state: '待换料' })
        }
        // 已刻成 / 已修版：已刻节点保留，不删不改工序节点
      }

      let pendingCount = 0
      const relatedBatches = await db.batches.where('draftId').anyOf(affectedDraftIds).toArray()
      for (const batch of relatedBatches) {
        await db.batches.update(batch.id, { reviewState: '待复核' })
        pendingCount += 1
      }

      const nextState = pendingCount === 0 ? '已办结' : '排查中'
      await db.segments.update(crack.segmentId, { state: pendingCount === 0 ? '已停用' : '待换料' })
      await db.cracks.update(crackId, { state: nextState, affectedBlockIds, affectedDraftIds })
    })
  } catch (error) {
    await load()
    throw error
  }
  await refreshLinkedStores()
}

/**
 * 复核：重刻或沿用原印样都必须留依据。
 * 重刻时为该画稿在裂段上的已刻版片刻接替新版，旧版留别名可查、节点保留。
 */
async function reviewBatch(input: {
  crackId: string
  batchId: string
  decision: ReviewDecision
  evidence: string
  operator: string
}): Promise<void> {
  const evidence = input.evidence.trim()
  const operator = input.operator.trim()
  if (!evidence) throw new Error('复核必须留下依据')
  if (!operator) throw new Error('请填写复核人')

  try {
    await db.transaction('rw', [db.cracks, db.blocks, db.batches, db.segments, db.reviews, db.drafts], async () => {
      const crack = await db.cracks.get(input.crackId)
      if (!crack || crack.state !== '排查中') throw new Error('该裂纹不在排查中，请刷新查看')
      const batch = await db.batches.get(input.batchId)
      if (!batch || batch.reviewState !== '待复核') throw new Error('该批次已复核或不在待复核范围')

      await db.reviews.add({
        id: `review-${crypto.randomUUID()}`,
        crackId: crack.id,
        batchId: batch.id,
        decision: input.decision,
        evidence,
        operator,
        createdAt: new Date().toISOString().slice(0, 16),
      })
      await db.batches.update(batch.id, {
        reviewState: '已复核',
        reviewNote: `${input.decision} · ${operator}：${evidence}`,
      })

      if (input.decision === '重刻') {
        const segment = await db.segments.get(crack.segmentId)
        const segmentNo = segment?.segmentNo ?? '未知木段'
        const targets = await db.blocks
          .where('segmentId')
          .equals(crack.segmentId)
          .and(
            (block) =>
              block.draftId === batch.draftId &&
              (block.state === '已刻成' || block.state === '已修版') &&
              crack.affectedBlockIds.includes(block.id),
          )
          .toArray()
        for (const block of targets) {
          const newId = `block-${crypto.randomUUID()}`
          await db.blocks.add({
            ...block,
            id: newId,
            state: '待刻',
            carvedBy: '',
            defectNote: '',
            segmentId: '',
            alias: '',
            replacedById: '',
          })
          await db.blocks.update(block.id, {
            state: '已更换',
            alias: `${block.blockName}·旧版(${segmentNo})`,
            replacedById: newId,
          })
        }
        if (targets.length > 0) {
          await db.drafts.update(batch.draftId, { status: '刻版中' })
        }
      }

      const remaining = await db.batches
        .where('draftId')
        .anyOf(crack.affectedDraftIds)
        .and((item) => item.reviewState === '待复核')
        .count()
      if (remaining === 0) {
        await db.cracks.update(crack.id, { state: '已办结' })
        await db.segments.update(crack.segmentId, { state: '已停用' })
      }
    })
  } catch (error) {
    await load()
    throw error
  }
  await refreshLinkedStores()
}

export const crackStore = {
  subscribe: crackList.subscribe,
  load,
  submitCrack,
  processCrack,
  reviewBatch,
}
