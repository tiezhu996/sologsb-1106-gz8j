import 'fake-indexeddb/auto'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
const expect = (actual) => ({
  toBe(expected) { assert.equal(actual, expected) },
  toBeTruthy() { assert.ok(actual) },
  toBeGreaterThan(expected) { assert.ok(actual > expected, actual + ' > ' + expected) },
  toContain(expected) { assert.ok(String(actual).includes(expected), `${actual} contains ${expected}`) },
})
import { initializeDatabase, db } from '../src/utils/db'
import { crackStore } from '../src/stores/crackStore'
import { woodLogStore } from '../src/stores/woodLogStore'
import { blockLineage, impactOfWoodLog } from '../src/utils/trace'

async function resetDb() {
  await db.delete()
  await initializeDatabase()
}

beforeEach(async () => {
  await resetDb()
})

test('裂纹影响范围按木段跨画稿追溯，已印批次不漏复核', async () => {
  // 梨木甲段：门神黄版(在刻)、灶王黄版(在刻)、穆柯寨红版(待刻)、莲鱼黄版(已刻成)
  // 先在甲段版片上登记一个刻版节点，验证裂纹上报后已刻节点保留不丢
  await db.nodes.add({
    id: 'node-test-ms02',
    blockId: 'block-ms-02',
    stage: '刻版',
    seq: 1,
    operator: '周桂枝',
    startedAt: '2026-02-25T09:00',
    durationMin: 200,
    note: '试刻节点，用于验证保留。',
  })

  const result = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-jia',
      blockId: 'block-ms-02',
      foundAt: '2026-03-01',
      description: '甲段沿丝长裂约三寸',
      reporter: '管事甲',
    },
    expectedWoodVersion: 1,
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('提交失败')
  const crackId = result.crack.id

  // 未刻版片转待换料；已刻/在刻版片保留状态
  const mkRed = await db.blocks.get('block-mk-03')
  expect(mkRed?.state).toBe('待换料')
  const msYellow = await db.blocks.get('block-ms-02')
  expect(msYellow?.state).toBe('在刻')
  const llYellow = await db.blocks.get('block-ll-02')
  expect(llYellow?.state).toBe('已刻成')

  // 波及画稿：门神、灶王、穆柯寨、莲鱼；其全部批次转待复核（含莲鱼两批）
  const ll1 = await db.batches.get('batch-ll-001')
  const ll2 = await db.batches.get('batch-ll-002')
  const ms1 = await db.batches.get('batch-ms-001')
  expect(ll1?.reviewState).toBe('待复核')
  expect(ll2?.reviewState).toBe('待复核')
  expect(ms1?.reviewState).toBe('待复核')
  expect(ll1?.invalidatedByCrackId).toBe(crackId)

  // 已刻节点保留
  const impact = impactOfWoodLog({
    woodLogId: 'wood-lm-jia',
    blocks: await db.blocks.toArray(),
    nodes: await db.nodes.toArray(),
    batches: await db.batches.toArray(),
  })
  expect(impact.nodes.length).toBeGreaterThan(0)

  // 木段版本号自增
  const log = await db.woodLogs.get('wood-lm-jia')
  expect(log?.woodVersion).toBe(2)
})

test('两标签页并发提交同一木段：后提交者先看到冲突', async () => {
  const first = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-yi',
      blockId: 'block-ms-03',
      foundAt: '2026-03-02',
      description: '乙段端裂',
      reporter: '标签页一',
    },
    expectedWoodVersion: 1,
  })
  expect(first.ok).toBe(true)

  // 第二个标签页仍拿着旧版本号 v1 提交
  const second = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-yi',
      blockId: 'block-zw-03',
      foundAt: '2026-03-02',
      description: '乙段另一侧裂纹',
      reporter: '标签页二',
    },
    expectedWoodVersion: 1,
  })
  expect(second.ok).toBe(false)
  if (second.ok || second.retryable) throw new Error('应为冲突而非写入失败')
  expect(second.conflict.type).toBe('woodVersion')
  if (second.conflict.type !== 'woodVersion') throw new Error('类型错误')
  expect(second.conflict.latestVersion).toBe(2)
  expect(second.conflict.existingCrack?.reporter).toBe('标签页一')

  // 冲突未产生第二条工单，也未改动任何版片状态
  const cracks = await db.cracks.toArray()
  expect(cracks.length).toBe(1)
})

test('挂段改变范围后，旧版本提交同样冲突', async () => {
  await woodLogStore.attachBlocks('wood-lm-yi', ['block-ms-02'])
  const outcome = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-yi',
      blockId: 'block-ms-03',
      foundAt: '2026-03-03',
      description: '迟来的上报',
      reporter: '旧表单',
    },
    expectedWoodVersion: 1,
  })
  expect(outcome.ok).toBe(false)
})

test('写入失败重试沿用令牌：幂等不产生半套/重复记录', async () => {
  const token = 'fixed-client-token'
  const form = {
    woodLogId: 'wood-lm-bing',
    blockId: 'block-ms-04',
    foundAt: '2026-03-04',
    description: '丙段隐裂',
    reporter: '管事丙',
  }

  const first = await crackStore.submitCrack({ form, expectedWoodVersion: 1, clientToken: token })
  expect(first.ok).toBe(true)

  // 模拟响应丢失后用同令牌重试：应识别为已提交，返回成功而非重复建工单
  const retry = await crackStore.submitCrack({ form, expectedWoodVersion: 1, clientToken: token })
  expect(retry.ok).toBe(true)
  const cracks = await db.cracks.toArray()
  expect(cracks.length).toBe(1)
})

test('重刻处置：旧版停用留别名、新版另挂，已刻节点保留在旧版', async () => {
  const submitted = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-jia',
      blockId: 'block-ms-02',
      foundAt: '2026-03-05',
      description: '甲段纵裂',
      reporter: '管事甲',
    },
    expectedWoodVersion: 1,
  })
  if (!submitted.ok) throw new Error('提交失败')

  await crackStore.resolveCrack({
    crackId: submitted.crack.id,
    kind: '重刻',
    basis: '裂纹贯穿版心，试印断线三处，改用乙段新料重刻。',
    decidedBy: '大管事',
    newWoodLogId: 'wood-lm-yi',
  })

  const crack = await db.cracks.get(submitted.crack.id)
  expect(crack?.status).toBe('已处理')

  const allBlocks = await db.blocks.toArray()
  // 甲段 4 块全部有对应新版
  const oldBlocks = allBlocks.filter((b) => b.woodLogId === 'wood-lm-jia')
  for (const old of oldBlocks) {
    expect(old.state).toBe('已停用')
    expect(old.alias).toBeTruthy()
    expect(old.replacedByBlockId).toBeTruthy()
    const replacement = allBlocks.find((b) => b.id === old.replacedByBlockId)
    expect(replacement?.state).toBe('待刻')
    expect(replacement?.woodLogId).toBe('wood-lm-yi')
    expect(replacement?.replacesBlockId).toBe(old.id)
    // 谱系可从新版走回旧版
    const lineage = blockLineage(allBlocks, replacement!.id)
    expect(lineage[0]?.id).toBe(old.id)
    expect(lineage.at(-1)?.id).toBe(replacement!.id)
  }

  // 旧版已刻节点仍在旧版上未迁移、未删除
  const oldNodes = await db.nodes.where('blockId').equals('block-ms-01').toArray()
  expect(oldNodes.length).toBeGreaterThan(0)
})

test('沿用原印样处置：版片恢复待刻，木段停用，批次仍需逐批复核', async () => {
  const submitted = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-jia',
      blockId: 'block-ms-02',
      foundAt: '2026-03-06',
      description: '甲段细纹',
      reporter: '管事甲',
    },
    expectedWoodVersion: 1,
  })
  if (!submitted.ok) throw new Error('提交失败')

  await crackStore.resolveCrack({
    crackId: submitted.crack.id,
    kind: '沿用原印样',
    basis: '裂纹未入版心，试印五十张无断线，经赵师傅验样沿用。',
    decidedBy: '大管事',
  })

  const mkRed = await db.blocks.get('block-mk-03')
  expect(mkRed?.state).toBe('待刻')
  const log = await db.woodLogs.get('wood-lm-jia')
  expect(log?.status).toBe('停用')

  // 处置不自动复核批次，仍待逐批复核留据
  const ll1 = await db.batches.get('batch-ll-001')
  expect(ll1?.reviewState).toBe('待复核')

  await crackStore.reviewBatch({
    batchId: 'batch-ll-001',
    crackId: submitted.crack.id,
    kind: '沿用原印样',
    basis: '抽验三十张，印面无裂纹痕迹。',
    reviewer: '质检员',
  })
  const reviewed = await db.batches.get('batch-ll-001')
  expect(reviewed?.reviewState).toBe('正常')
  const reviews = await db.batchReviews.where('batchId').equals('batch-ll-001').toArray()
  expect(reviews.length).toBe(1)
  expect(reviews[0]?.basis).toContain('抽验三十张')

  // 另一批未复核，仍待复核
  const ll2 = await db.batches.get('batch-ll-002')
  expect(ll2?.reviewState).toBe('待复核')
})

test('复核必须留依据', async () => {
  const submitted = await crackStore.submitCrack({
    form: {
      woodLogId: 'wood-lm-jia',
      blockId: 'block-ms-02',
      foundAt: '2026-03-07',
      description: '甲段裂',
      reporter: '管事甲',
    },
    expectedWoodVersion: 1,
  })
  if (!submitted.ok) throw new Error('提交失败')

  await assert.rejects(
    crackStore.reviewBatch({
      batchId: 'batch-ll-001',
      crackId: submitted.crack.id,
      kind: '重刻',
      basis: '   ',
      reviewer: '质检员',
    }),
  )
})
