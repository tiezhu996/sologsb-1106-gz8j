// 手工构造一个 v2 老库，再打开 v3 数据库，验证升级迁移：
// 老版片自动补挂木段、老批次置「正常」、木段表自动补齐。
// 与 crack-workflow.test.ts 同进程（node:test 同一文件）时，本文件在同进程内后注册，
// 靠 db.delete() 清库后重建，不依赖其它测试的数据。
import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import Dexie from 'dexie'
import { db, initializeDatabase } from '../src/utils/db'

function oldV2Database(): Dexie {
  const old = new Dexie('gbwoodprint-db')
  old.version(1).stores({
    drafts: 'id, genre, status, title',
    blocks: 'id, draftId, colorNo, carvedBy, state',
    carvers: 'id, specialty, skillLevel, name',
    batches: 'id, draftId, batchNo, printedAt',
    nodes: 'id, batchId, blockId, stage, seq, operator',
  })
  old.version(2).stores({
    drafts: 'id, genre, status, title, schemaRev',
    blocks: 'id, draftId, colorNo, carvedBy, state, schemaRev',
    carvers: 'id, specialty, skillLevel, name, schemaRev',
    batches: 'id, draftId, batchNo, printedAt, schemaRev',
    nodes: 'id, batchId, blockId, stage, seq, operator, schemaRev',
  })
  return old
}

test('v2 老库升级到 v3：版片补挂木段、批次置正常、木段补齐', async () => {
  // 清掉同进程其它测试建出的 v3 库，再以 v2 结构写一份最小老数据
  await db.delete()
  const old = oldV2Database()
  await old.table('drafts').add({ id: 'd1', title: '旧画稿', genre: '门神', status: '可印', schemaRev: 2 })
  await old.table('blocks').add({
    id: 'block-ms-02',
    draftId: 'd1',
    blockName: '黄版',
    colorNo: 2,
    woodType: '梨木',
    thicknessMm: 20,
    carvedBy: '周桂枝',
    state: '在刻',
    defectNote: '',
    schemaRev: 2,
  })
  await old.table('batches').add({
    id: 'b1',
    draftId: 'd1',
    batchNo: '旧批',
    printedAt: '2026-01-01',
    paperBatch: '纸',
    inkNote: '',
    qty: 10,
    pieceCount: 1,
    qcNote: '',
    schemaRev: 2,
  })
  await old.close()

  await initializeDatabase()

  const block = await db.blocks.get('block-ms-02')
  assert.equal(block?.woodLogId, 'wood-lm-jia', '种子编号版片应自动补挂到甲段')
  assert.equal(block?.schemaRev, 3)

  const batch = await db.batches.get('b1')
  assert.equal(batch?.reviewState, '正常', '存量批次升级后置为正常')

  const woodLogs = await db.woodLogs.toArray()
  assert.equal(woodLogs.length, 4, '升级时补齐四段木料')
})
