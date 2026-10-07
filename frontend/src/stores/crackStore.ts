import { derived, get, writable } from 'svelte/store'
import type { CrackLog, CrackResolution } from '../types/crack'
import type { BatchReview, BatchReviewKind } from '../types/batchReview'
import type { Block } from '../types/block'
import { db } from '../utils/db'
import { broadcastArchiveChanged } from '../utils/broadcast'
import { aliasForOldBlock } from '../utils/trace'

const crackList = writable<CrackLog[]>([])
const reviewList = writable<BatchReview[]>([])

export type CrackSubmitConflict =
  | { type: 'woodVersion'; latestVersion: number; existingCrack?: CrackLog }
  | { type: 'duplicate'; existingCrack: CrackLog }
  | { type: 'idempotent'; existingCrack: CrackLog }

export type CrackSubmitOutcome =
  | { ok: true; crack: CrackLog; retried: boolean }
  | { ok: false; retryable: true; conflict?: undefined; error: Error; pending: PendingCrackInput }
  | { ok: false; retryable: false; conflict: CrackSubmitConflict; pending?: undefined }

export interface CrackFormInput {
  woodLogId: string
  blockId: string
  foundAt: string
  description: string
  reporter: string
}

export interface PendingCrackInput {
  form: CrackFormInput
  clientToken: string
  expectedWoodVersion: number
  savedAt: string
  attempts: number
}

/* ---------------- 待处理写入队列（本地暂存，失败重试不留半套记录） ---------------- */

const QUEUE_KEY = 'gbwoodprint-pending-cracks'

const pendingQueue = writable<PendingCrackInput[]>(readQueue())

function readQueue(): PendingCrackInput[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingCrackInput[]) : []
  } catch {
    return []
  }
}

function persistQueue(queue: PendingCrackInput[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  pendingQueue.set(queue)
}

export function pendingCrackStore() {
  return {
    subscribe: pendingQueue.subscribe,
    /** 只从队列移除；表单仍保留在界面上，由调用方决定是否收起 */
    drop(clientToken: string): void {
      persistQueue(get(pendingQueue).filter((item) => item.clientToken !== clientToken))
    },
    clear(): void {
      persistQueue([])
    },
  }
}

/* ---------------- 查询 ---------------- */

async function load(): Promise<void> {
  const [cracks, reviews] = await Promise.all([db.cracks.toArray(), db.batchReviews.toArray()])
  cracks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  reviews.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
  crackList.set(cracks)
  reviewList.set(reviews)
}

const openCracks = derived(crackList, ($cracks) => $cracks.filter((crack) => crack.status === '待处理'))

function reviewsForCrack(crackId: string): BatchReview[] {
  return get(reviewList).filter((review) => review.crackId === crackId)
}

/* ---------------- 提交裂纹（乐观锁 + 幂等 + 单事务原子写入） ---------------- */

async function submitCrack(input: {
  form: CrackFormInput
  expectedWoodVersion: number
  /** 重试时必须沿用以保证幂等；首次提交留空则生成新令牌 */
  clientToken?: string
}): Promise<CrackSubmitOutcome> {
  const clientToken = input.clientToken ?? crypto.randomUUID()
  let outcome: CrackSubmitOutcome

  try {
    const result = await db.transaction(
      'rw',
      db.woodLogs,
      db.blocks,
      db.batches,
      db.cracks,
      async (): Promise<
        | { committed: true; crack: CrackLog }
        | { committed: false; conflict: CrackSubmitConflict }
      > => {
        const woodLog = await db.woodLogs.get(input.form.woodLogId)
        if (!woodLog) throw new Error('所选木段已不存在，请重新选择木料段。')

        const duplicateByToken = await db.cracks.where('clientToken').equals(clientToken).first()
        if (duplicateByToken) {
          return { committed: false, conflict: { type: 'idempotent', existingCrack: duplicateByToken } }
        }

        const sameLogOpen = await db.cracks
          .where('woodLogId')
          .equals(input.form.woodLogId)
          .filter((crack) => crack.status === '待处理')
          .first()

        if (woodLog.woodVersion !== input.expectedWoodVersion || sameLogOpen) {
          return {
            committed: false,
            conflict: {
              type: 'woodVersion',
              latestVersion: woodLog.woodVersion,
              existingCrack: sameLogOpen,
            },
          }
        }

        const now = new Date().toISOString()
        const crackId = `crack-${crypto.randomUUID()}`
        const crack: CrackLog = {
          id: crackId,
          woodLogId: input.form.woodLogId,
          blockId: input.form.blockId,
          draftId: (await db.blocks.get(input.form.blockId))?.draftId ?? '',
          foundAt: input.form.foundAt,
          description: input.form.description.trim(),
          reporter: input.form.reporter.trim(),
          status: '待处理',
          clientToken,
          woodVersionAtSubmit: woodLog.woodVersion,
          createdAt: now,
        }
        await db.cracks.add(crack)

        // 影响范围按木段判断：同段版片不论画稿全部纳入；
        // 未刻版片转待换料，已刻/在刻版片保留状态与已刻节点。
        const affectedBlocks = await db.blocks.where('woodLogId').equals(input.form.woodLogId).toArray()
        for (const block of affectedBlocks) {
          if (block.state === '待刻') {
            await db.blocks.update(block.id, { state: '待换料' satisfies Block['state'] })
          }
        }

        // 关联印制批次：波及画稿下所有批次一律失效转待复核，
        // 不能只按当前已刻版片缩小范围，否则已印批次会漏复核。
        const draftIds = new Set(affectedBlocks.map((block) => block.draftId))
        for (const draftId of draftIds) {
          const draftBatches = await db.batches.where('draftId').equals(draftId).toArray()
          for (const batch of draftBatches) {
            await db.batches.update(batch.id, {
              reviewState: '待复核' as const,
              invalidatedByCrackId: crackId,
              invalidatedAt: now,
            })
          }
        }

        await db.woodLogs.update(input.form.woodLogId, { woodVersion: woodLog.woodVersion + 1 })
        return { committed: true, crack }
      },
    )

    if (!result.committed) {
      if (result.conflict.type === 'idempotent') {
        // 同令牌重试：首次提交其实已落库，只是客户端没收到成功回执。
        // 视为成功并清掉待处理队列，绝不重复建工单。
        outcome = { ok: true, crack: result.conflict.existingCrack, retried: true }
      } else {
        outcome = { ok: false, retryable: false, conflict: result.conflict }
      }
    } else {
      outcome = { ok: true, crack: result.crack, retried: Boolean(input.clientToken) }
    }
  } catch (error) {
    // 事务整体回滚，不会留下半套换料记录；把本次提交落入待处理队列供重试。
    const previous = get(pendingQueue).find((item) => item.clientToken === clientToken)
    const pending: PendingCrackInput = {
      form: input.form,
      clientToken,
      expectedWoodVersion: input.expectedWoodVersion,
      savedAt: previous?.savedAt ?? new Date().toISOString(),
      attempts: (previous?.attempts ?? 0) + 1,
    }
    const queue = get(pendingQueue).filter((item) => item.clientToken !== clientToken)
    persistQueue([pending, ...queue])
    outcome = {
      ok: false,
      retryable: true,
      error: error instanceof Error ? error : new Error(String(error)),
      pending,
    }
  }

  if (outcome.ok) {
    broadcastArchiveChanged()
    await load()
  }
  return outcome
}

async function retryPending(item: PendingCrackInput): Promise<CrackSubmitOutcome> {
  // 沿原令牌重试；失败计数由 submitCrack 在捕获时累加到队列里。
  const outcome = await submitCrack({
    form: item.form,
    expectedWoodVersion: item.expectedWoodVersion,
    clientToken: item.clientToken,
  })

  if (outcome.ok) {
    persistQueue(get(pendingQueue).filter((queued) => queued.clientToken !== item.clientToken))
  }
  return outcome
}

/* ---------------- 裂纹处置：重刻或沿用原印样 ---------------- */

export interface ResolveCrackInput {
  crackId: string
  kind: CrackResolution['kind']
  basis: string
  decidedBy: string
  /** 重刻时新版所挂木段；留空表示新料未到，先留待料依据 */
  newWoodLogId?: string
}

export async function resolveCrack(input: ResolveCrackInput): Promise<void> {
  await db.transaction('rw', db.cracks, db.woodLogs, db.blocks, db.carvers, async () => {
    const crack = await db.cracks.get(input.crackId)
    if (!crack) throw new Error('裂纹工单不存在。')
    if (crack.status !== '待处理') throw new Error('这张裂纹工单已经处理过。')

    const now = new Date().toISOString()
    const resolution: CrackResolution = {
      kind: input.kind,
      basis: input.basis.trim(),
      decidedBy: input.decidedBy.trim(),
      decidedAt: now,
      ...(input.newWoodLogId ? { newWoodLogId: input.newWoodLogId } : {}),
    }

    const affectedBlocks = await db.blocks.where('woodLogId').equals(crack.woodLogId).toArray()

    if (input.kind === '重刻') {
      // 同木段版片全部重刻：旧版停用留别名，新版另挂（或留待新料），
      // 旧版上的已刻工序节点不迁移、不删除，仍可沿旧版查回。
      const targetWoodLogId = input.newWoodLogId || crack.woodLogId
      for (const oldBlock of affectedBlocks) {
        const alias = aliasForOldBlock(oldBlock)
        const newBlock: Block = {
          id: `block-${crypto.randomUUID()}`,
          draftId: oldBlock.draftId,
          blockName: oldBlock.blockName,
          colorNo: oldBlock.colorNo,
          woodType: oldBlock.woodType,
          thicknessMm: oldBlock.thicknessMm,
          carvedBy: oldBlock.carvedBy,
          state: '待刻',
          defectNote: '',
          woodLogId: targetWoodLogId,
          replacesBlockId: oldBlock.id,
        }
        await db.blocks.add(newBlock)
        await db.blocks.update(oldBlock.id, {
          state: '已停用' satisfies Block['state'],
          alias,
          replacedByBlockId: newBlock.id,
        })

        // 新版不自动占用刻工，但把已停用旧版从刻工在刻清单里摘掉
        const carvers = await db.carvers.toArray()
        for (const carver of carvers) {
          if (carver.activeBlockIds.includes(oldBlock.id)) {
            await db.carvers.update(carver.id, {
              activeBlockIds: carver.activeBlockIds.filter((blockId) => blockId !== oldBlock.id),
            })
          }
        }
      }
    } else {
      // 沿用原印样：曾转待换料的未刻版片恢复待刻，已刻版片本就未动。
      for (const block of affectedBlocks) {
        if (block.state === '待换料') {
          await db.blocks.update(block.id, { state: '待刻' satisfies Block['state'] })
        }
      }
    }

    await db.woodLogs.update(crack.woodLogId, {
      ...(input.kind === '沿用原印样' ? { status: '停用' as const } : {}),
    })

    await db.cracks.update(crack.id, {
      status: '已处理' as const,
      resolvedAt: now,
      resolution,
    })
  })
  broadcastArchiveChanged()
  await load()
}

/* ---------------- 批次复核：重刻重印 / 沿用原印样，都留依据 ---------------- */

export interface ReviewBatchInput {
  batchId: string
  crackId: string
  kind: BatchReviewKind
  basis: string
  reviewer: string
}

export async function reviewBatch(input: ReviewBatchInput): Promise<void> {
  const basis = input.basis.trim()
  const reviewer = input.reviewer.trim()
  if (!basis) throw new Error('请填写复核依据。')
  if (!reviewer) throw new Error('请填写复核人。')

  await db.transaction('rw', db.batchReviews, db.batches, db.cracks, async () => {
    const batch = await db.batches.get(input.batchId)
    if (!batch) throw new Error('印制批次不存在。')
    const crack = await db.cracks.get(input.crackId)
    if (!crack) throw new Error('裂纹工单不存在。')

    const review: BatchReview = {
      id: `review-${crypto.randomUUID()}`,
      batchId: input.batchId,
      crackId: input.crackId,
      kind: input.kind,
      basis,
      reviewer,
      reviewedAt: new Date().toISOString(),
      woodVersion: crack.woodVersionAtSubmit,
    }
    await db.batchReviews.add(review)

    // 复核结论只解除本批当前这张工单的待复核标记；
    // 若此后又被更新的裂纹波及（invalidatedByCrackId 变了），保持待复核。
    await db.batches.update(input.batchId, (record) => {
      if (record.invalidatedByCrackId === input.crackId || record.invalidatedByCrackId === undefined) {
        record.reviewState = '正常'
      }
    })
  })
  broadcastArchiveChanged()
  await load()
}

export const crackStore = {
  subscribe: crackList.subscribe,
  reviews: { subscribe: reviewList.subscribe },
  openCracks,
  reviewsForCrack,
  load,
  submitCrack,
  retryPending,
  resolveCrack,
  reviewBatch,
}
