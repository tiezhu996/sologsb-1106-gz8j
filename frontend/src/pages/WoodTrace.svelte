<script lang="ts">
  import { onMount } from 'svelte'
  import { link } from 'svelte-spa-router'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { woodStore } from '../stores/woodStore'
  import { crackStore } from '../stores/crackStore'
  import { CrackConflictError } from '../utils/crack'
  import { db } from '../utils/db'
  import type { Block, WoodType } from '../types/block'
  import type { WoodSegment } from '../types/wood'
  import type { CrackReport, ReviewDecision, ReviewRecord } from '../types/crack'
  import type { PrintBatch } from '../types/batch'
  import type { ProcessNode } from '../types/node'

  const woodTypes: WoodType[] = ['梨木', '黄杨']
  const decisions: ReviewDecision[] = ['沿用原印样', '重刻']

  let batches = $state<PrintBatch[]>([])
  let nodes = $state<ProcessNode[]>([])
  let reviews = $state<ReviewRecord[]>([])

  let showSegmentForm = $state(false)
  let segmentNo = $state('')
  let woodType = $state<WoodType>('梨木')
  let sourceBatch = $state('')
  let receivedAt = $state(new Date().toISOString().slice(0, 10))
  let sizeNote = $state('')
  let segmentNote = $state('')
  let segmentMessage = $state('')

  let crackSegmentId = $state('')
  let crackPosition = $state('')
  let crackFoundBy = $state('')
  let crackDetail = $state('')
  let crackMessage = $state('')

  let crackNotice = $state<Record<string, string>>({})
  let reviewDraft = $state<Record<string, { decision: ReviewDecision; evidence: string; operator: string }>>({})
  let assignDraft = $state<Record<string, string>>({})
  let assignMessage = $state('')
  let aliasKeyword = $state('')

  const pendingReviewCount = $derived(batches.filter((batch) => batch.reviewState === '待复核').length)
  const pendingCrackCount = $derived($crackStore.filter((crack) => crack.state === '待处理').length)
  const linkedBlockCount = $derived($blockStore.filter((block) => block.segmentId).length)
  const unassignedBlocks = $derived($blockStore.filter((block) => !block.segmentId && block.state !== '已更换'))
  const materialBlocks = $derived($blockStore.filter((block) => block.state === '待换料'))
  const aliasResults = $derived(
    aliasKeyword.trim() ? $blockStore.filter((block) => block.alias && block.alias.includes(aliasKeyword.trim())) : [],
  )

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), woodStore.load(), crackStore.load(), refreshLocal()])
  })

  $effect(() => {
    for (const batch of batches) {
      if (batch.reviewState === '待复核' && !reviewDraft[batch.id]) {
        reviewDraft[batch.id] = { decision: '沿用原印样', evidence: '', operator: '' }
      }
    }
  })

  $effect(() => {
    for (const block of [...unassignedBlocks, ...materialBlocks]) {
      if (assignDraft[block.id] === undefined) assignDraft[block.id] = ''
    }
  })

  async function refreshLocal(): Promise<void> {
    const [batchRecords, nodeRecords, reviewRecords] = await Promise.all([
      db.batches.toArray(),
      db.nodes.toArray(),
      db.reviews.toArray(),
    ])
    batches = batchRecords
    nodes = nodeRecords
    reviews = reviewRecords.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  function draftTitle(draftId: string): string {
    return $draftStore.find((draft) => draft.id === draftId)?.title ?? '未知画稿'
  }

  function segmentOf(segmentId: string): WoodSegment | null {
    return $woodStore.find((segment) => segment.id === segmentId) ?? null
  }

  function segmentNoOf(block: Block): string {
    return block.segmentId ? (segmentOf(block.segmentId)?.segmentNo ?? '') : ''
  }

  function blocksOfSegment(segmentId: string): Block[] {
    return $blockStore.filter((block) => block.segmentId === segmentId)
  }

  function candidateSegments(block: Block): WoodSegment[] {
    return $woodStore.filter((segment) => segment.state === '在用' && segment.woodType === block.woodType)
  }

  function blockById(blockId: string): Block | null {
    return $blockStore.find((block) => block.id === blockId) ?? null
  }

  function nodeCountOf(blockId: string): number {
    return nodes.filter((node) => node.blockId === blockId).length
  }

  /**
   * 裂纹影响范围：待处理时按木段现状预估；
   * 立案后一律用立案时的木段快照，不随换料、重刻缩小，已印批次不会漏复核。
   */
  function impactOf(crack: CrackReport) {
    const preview = crack.state === '待处理'
    const scopeBlocks = preview
      ? $blockStore.filter((block) => block.segmentId === crack.segmentId)
      : $blockStore.filter((block) => crack.affectedBlockIds.includes(block.id))
    const draftIds = preview ? new Set(scopeBlocks.map((block) => block.draftId)) : new Set(crack.affectedDraftIds)
    const scopeBatches = batches.filter((batch) => draftIds.has(batch.draftId))
    const blockIds = new Set(scopeBlocks.map((block) => block.id))
    const scopeNodes = nodes
      .filter((node) => node.blockId && blockIds.has(node.blockId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const scopeReviews = reviews.filter((review) => review.crackId === crack.id)
    return { preview, scopeBlocks, scopeBatches, scopeNodes, scopeReviews }
  }

  async function submitSegment(): Promise<void> {
    if (!segmentNo.trim() || !sourceBatch.trim()) {
      segmentMessage = '请补全木段编号与进料批号。'
      return
    }
    await woodStore.createSegment({
      segmentNo: segmentNo.trim(),
      woodType,
      sourceBatch: sourceBatch.trim(),
      receivedAt,
      sizeNote: sizeNote.trim() || '开料尺寸待补记',
      note: segmentNote.trim(),
    })
    segmentNo = ''
    sourceBatch = ''
    sizeNote = ''
    segmentNote = ''
    segmentMessage = ''
    showSegmentForm = false
  }

  async function submitCrackReport(): Promise<void> {
    crackMessage = ''
    if (!crackSegmentId || !crackPosition.trim() || !crackFoundBy.trim()) {
      crackMessage = '请选择木段，并补全裂纹位置与发现人。'
      return
    }
    try {
      await crackStore.submitCrack({
        segmentId: crackSegmentId,
        position: crackPosition,
        detail: crackDetail,
        foundBy: crackFoundBy,
      })
      crackPosition = ''
      crackDetail = ''
      crackMessage = '裂纹已登记为待处理，可立案排查。'
    } catch (error) {
      crackMessage =
        error instanceof CrackConflictError
          ? '提交冲突：同一裂纹已在另一窗口登记，下方列表已同步出现该记录。'
          : '登记失败，请重试。'
    }
  }

  async function runProcess(crack: CrackReport): Promise<void> {
    crackNotice[crack.id] = ''
    try {
      await crackStore.processCrack(crack.id)
      await refreshLocal()
      crackNotice[crack.id] = '已立案：关联批次转待复核，未刻版片转待换料。'
    } catch (error) {
      await refreshLocal()
      crackNotice[crack.id] = `立案失败：${error instanceof Error ? error.message : '未知原因'}，裂纹仍在待处理，可重试。`
    }
  }

  async function runReview(crack: CrackReport, batch: PrintBatch): Promise<void> {
    const entry = reviewDraft[batch.id]
    if (!entry) return
    crackNotice[crack.id] = ''
    try {
      await crackStore.reviewBatch({
        crackId: crack.id,
        batchId: batch.id,
        decision: entry.decision,
        evidence: entry.evidence,
        operator: entry.operator,
      })
      await refreshLocal()
      crackNotice[crack.id] = `批次 ${batch.batchNo} 已复核（${entry.decision}），依据已留档。`
      delete reviewDraft[batch.id]
    } catch (error) {
      crackNotice[crack.id] = `复核失败：${error instanceof Error ? error.message : '未知原因'}`
    }
  }

  async function runAssign(block: Block): Promise<void> {
    const segmentId = assignDraft[block.id]
    assignMessage = ''
    if (!segmentId) {
      assignMessage = '请先选择木段。'
      return
    }
    const wasPendingMaterial = block.state === '待换料'
    try {
      await woodStore.assignSegment(block.id, segmentId)
      assignDraft[block.id] = ''
      assignMessage = wasPendingMaterial ? `${block.blockName}已换料，回到待刻。` : `${block.blockName}已挂到木段。`
    } catch (error) {
      assignMessage = `操作失败：${error instanceof Error ? error.message : '未知原因'}`
    }
  }
</script>

<svelte:head>
  <title>木段追溯 · 木版年画刻版工序档案</title>
</svelte:head>

<div class="page-heading">
  <div>
    <p class="eyebrow">木料溯源</p>
    <h1>木段追溯台</h1>
    <p>登记木段去向并挂到版片；裂纹一出现，沿木段找出关联工序节点与印制批次，范围按木段全量判断，已印批次不漏复核。</p>
  </div>
  <button class="button primary" data-testid="new-segment" type="button" onclick={() => (showSegmentForm = true)}>新建木段</button>
</div>

<section class="summary-strip four">
  <div><span>在册木段</span><strong data-testid="count-segment">{$woodStore.length}</strong></div>
  <div><span>已挂版片</span><strong>{linkedBlockCount}</strong></div>
  <div><span>待处理裂纹</span><strong data-testid="count-crack-pending">{pendingCrackCount}</strong></div>
  <div><span>待复核批次</span><strong data-testid="count-batch-pending">{pendingReviewCount}</strong></div>
</section>

{#if showSegmentForm}
  <section class="panel form-panel" data-testid="form-segment">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">新木段</span>
        <h2>登记进料木段</h2>
      </div>
      <button class="text-button" type="button" onclick={() => (showSegmentForm = false)}>收起</button>
    </div>
    <div class="form-grid three">
      <label>
        <span>木段编号</span>
        <input data-testid="field-segmentNo" bind:value={segmentNo} placeholder="如：梨木段-04" />
      </label>
      <label>
        <span>木料</span>
        <select data-testid="field-woodType" bind:value={woodType}>
          {#each woodTypes as item}<option value={item}>{item}</option>{/each}
        </select>
      </label>
      <label>
        <span>进料批号</span>
        <input data-testid="field-sourceBatch" bind:value={sourceBatch} placeholder="如：内裂梨木-2610" />
      </label>
      <label>
        <span>收到日期</span>
        <input data-testid="field-receivedAt" type="date" bind:value={receivedAt} />
      </label>
      <label class="wide">
        <span>开料说明</span>
        <input data-testid="field-sizeNote" bind:value={sizeNote} placeholder="段长、可开版数与厚度" />
      </label>
      <label class="wide">
        <span>备注</span>
        <textarea data-testid="field-segmentNote" rows="2" bind:value={segmentNote} placeholder="材质、阴干情况与隐裂嫌疑"></textarea>
      </label>
    </div>
    {#if segmentMessage}<p class="form-message">{segmentMessage}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-segment" type="button" onclick={submitSegment}>保存木段</button>
      <button class="button ghost" type="button" onclick={() => (showSegmentForm = false)}>取消</button>
    </div>
  </section>
{/if}

<section class="panel">
  <div class="panel-heading">
    <div>
      <span class="section-kicker">木段去向</span>
      <h2>段料与挂版对照</h2>
    </div>
    <span class="sync-note">换料、重刻后旧段挂接仍留痕</span>
  </div>
  {#if $woodStore.length === 0}
    <EmptyBox
      title="尚未登记木段"
      message="先登记进料木段，再把版片挂到木段上，裂纹出现时才能沿段追查。"
      actionLabel="新建木段"
      onaction={() => (showSegmentForm = true)}
    />
  {:else}
    <div class="segment-grid">
      {#each $woodStore as segment (segment.id)}
        {@const owned = blocksOfSegment(segment.id)}
        <article class="segment-card" data-testid="row-segment">
          <div class="segment-head">
            <h3>{segment.segmentNo}</h3>
            <span class="tag seg-{segment.state}">{segment.state}</span>
          </div>
          <dl class="segment-meta">
            <div><dt>木料</dt><dd>{segment.woodType}</dd></div>
            <div><dt>进料批</dt><dd>{segment.sourceBatch}</dd></div>
            <div><dt>收到</dt><dd>{segment.receivedAt}</dd></div>
            <div><dt>开料</dt><dd>{segment.sizeNote}</dd></div>
          </dl>
          {#if segment.note}<p class="segment-note">{segment.note}</p>{/if}
          <div class="segment-blocks">
            <span>挂版去向</span>
            {#if owned.length === 0}
              <small>尚无版片挂到此段</small>
            {:else}
              {#each owned as block (block.id)}
                <div class="block-chip">
                  <strong>{draftTitle(block.draftId)} · {block.blockName}</strong>
                  <em>{block.state}{block.alias ? ` · ${block.alias}` : ''}</em>
                </div>
              {/each}
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<section class="panel">
  <div class="panel-heading">
    <div>
      <span class="section-kicker">挂段与换料</span>
      <h2>版片挂接木段</h2>
    </div>
    <span class="sync-note">待换料版片换上在用木段后回到待刻</span>
  </div>
  {#if unassignedBlocks.length === 0 && materialBlocks.length === 0}
    <p class="gentle-copy">全部版片均已挂段，当前也没有待换料版片。</p>
  {:else}
    <div class="assign-list">
      {#each materialBlocks as block (block.id)}
        <div class="assign-row" data-testid={`replace-row-${block.id}`}>
          <div class="assign-info">
            <strong>{draftTitle(block.draftId)} · {block.blockName}</strong>
            <span class="tag block-待换料">待换料</span>
            <small>原挂 {segmentNoOf(block) || '未挂段'}</small>
          </div>
          <select data-testid={`replace-segment-${block.id}`} bind:value={assignDraft[block.id]}>
            <option value="">选择新木段</option>
            {#each candidateSegments(block) as segment}
              <option value={segment.id}>{segment.segmentNo} · {segment.sourceBatch}</option>
            {/each}
          </select>
          <button class="mini-button strong" data-testid={`submit-replace-${block.id}`} type="button" onclick={() => runAssign(block)}>换料复用</button>
        </div>
      {/each}
      {#each unassignedBlocks as block (block.id)}
        <div class="assign-row" data-testid={`assign-row-${block.id}`}>
          <div class="assign-info">
            <strong>{draftTitle(block.draftId)} · {block.blockName}</strong>
            <span class="tag">{block.state}</span>
            <small>{block.woodType} · 未挂段</small>
          </div>
          <select data-testid={`assign-segment-${block.id}`} bind:value={assignDraft[block.id]}>
            <option value="">选择木段</option>
            {#each candidateSegments(block) as segment}
              <option value={segment.id}>{segment.segmentNo} · {segment.sourceBatch}</option>
            {/each}
          </select>
          <button class="mini-button" data-testid={`submit-assign-${block.id}`} type="button" onclick={() => runAssign(block)}>挂到木段</button>
        </div>
      {/each}
    </div>
    {#if assignMessage}<p class="notice">{assignMessage}</p>{/if}
  {/if}
</section>

<section class="panel form-panel" data-testid="form-crack">
  <div class="panel-heading">
    <div>
      <span class="section-kicker">裂纹登记</span>
      <h2>发现内裂立即登记</h2>
    </div>
    <span class="sync-note">同一裂纹重复提交会立即提示冲突</span>
  </div>
  <div class="form-grid three">
    <label>
      <span>所在木段</span>
      <select data-testid="field-crack-segment" bind:value={crackSegmentId}>
        <option value="">请选择</option>
        {#each $woodStore.filter((segment) => segment.state !== '已停用') as segment}
          <option value={segment.id}>{segment.segmentNo} · {segment.woodType}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>裂纹位置</span>
      <input data-testid="field-crack-position" bind:value={crackPosition} placeholder="如：端头第三块横裂" />
    </label>
    <label>
      <span>发现人</span>
      <input data-testid="field-crack-foundBy" bind:value={crackFoundBy} placeholder="当班师傅" />
    </label>
    <label class="wide">
      <span>裂纹情况</span>
      <textarea data-testid="field-crack-detail" rows="2" bind:value={crackDetail} placeholder="走向、长度、试印表现"></textarea>
    </label>
  </div>
  {#if crackMessage}<p class="form-message">{crackMessage}</p>{/if}
  <div class="form-actions">
    <button class="button primary" data-testid="submit-crack" type="button" onclick={submitCrackReport}>登记裂纹</button>
  </div>
</section>

{#if $crackStore.length > 0}
  <section class="crack-list">
    {#each $crackStore as crack (crack.id)}
      {@const impact = impactOf(crack)}
      {@const segment = segmentOf(crack.segmentId)}
      <article class="panel crack-card" data-testid="row-crack">
        <div class="crack-head">
          <div>
            <span class="section-kicker">{segment?.segmentNo ?? '未知木段'} · {crack.foundAt.replace('T', ' ')}</span>
            <h2>{crack.position}</h2>
            <p>{crack.foundBy} 发现{crack.detail ? ` · ${crack.detail}` : ''}</p>
          </div>
          <span class="tag crack-{crack.state}">{crack.state}</span>
        </div>

        <div class="impact-strip">
          <div><span>关联版片</span><strong>{impact.scopeBlocks.length}</strong></div>
          <div><span>关联工序节点</span><strong>{impact.scopeNodes.length}</strong></div>
          <div><span>关联印制批次</span><strong>{impact.scopeBatches.length}</strong></div>
          <div><span>复核留档</span><strong>{impact.scopeReviews.length}</strong></div>
        </div>
        <p class="scope-note">
          {impact.preview
            ? '待处理：以下按木段现状预估范围，立案时按木段快照固定。'
            : '范围按立案时木段快照圈定，不随换料、重刻缩小。'}
        </p>

        {#if crack.state === '待处理'}
          <div class="inline-actions">
            <button class="button primary" data-testid={`process-crack-${crack.id}`} type="button" onclick={() => runProcess(crack)}>立案排查</button>
          </div>
        {:else}
          <div class="impact-grid">
            <section>
              <h3>关联版片</h3>
              {#if impact.scopeBlocks.length === 0}
                <p class="gentle-copy">立案时木段上暂无版片。</p>
              {:else}
                <ul class="scope-list">
                  {#each impact.scopeBlocks as block (block.id)}
                    <li>
                      <strong>{draftTitle(block.draftId)} · {block.blockName}</strong>
                      <span>{block.state} · 工序节点 {nodeCountOf(block.id)} 条{block.alias ? ` · 别名 ${block.alias}` : ''}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
            <section>
              <h3>关联工序节点（已刻保留）</h3>
              {#if impact.scopeNodes.length === 0}
                <p class="gentle-copy">关联版片尚未登记工序节点。</p>
              {:else}
                <ul class="scope-list">
                  {#each impact.scopeNodes as node (node.id)}
                    <li>
                      <strong>{node.stage} · {node.operator}</strong>
                      <span>{node.startedAt.replace('T', ' ')} · {node.note}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          </div>

          <section class="batch-review">
            <h3>关联印制批次</h3>
            {#if impact.scopeBatches.length === 0}
              <p class="gentle-copy">关联画稿尚未登记印制批次。</p>
            {:else}
              {#each impact.scopeBatches as batch (batch.id)}
                <div class="batch-review-row" data-testid={`review-row-${batch.id}`}>
                  <div class="batch-review-info">
                    <strong>{batch.batchNo}</strong>
                    <small>{draftTitle(batch.draftId)} · {batch.printedAt.replace(/-/g, '.')} · 印 {batch.qty} 张</small>
                  </div>
                  <span class="tag review-{batch.reviewState}">{batch.reviewState}</span>
                  {#if batch.reviewState === '待复核' && crack.state === '排查中' && reviewDraft[batch.id]}
                    <div class="review-controls">
                      <select data-testid={`review-decision-${batch.id}`} bind:value={reviewDraft[batch.id].decision}>
                        {#each decisions as decision}<option value={decision}>{decision}</option>{/each}
                      </select>
                      <input data-testid={`review-evidence-${batch.id}`} bind:value={reviewDraft[batch.id].evidence} placeholder="复核依据（必填）" />
                      <input data-testid={`review-operator-${batch.id}`} bind:value={reviewDraft[batch.id].operator} placeholder="复核人" />
                      <button class="mini-button strong" data-testid={`submit-review-${batch.id}`} type="button" onclick={() => runReview(crack, batch)}>提交复核</button>
                    </div>
                  {:else if batch.reviewNote}
                    <p class="review-note">依据：{batch.reviewNote}</p>
                  {/if}
                </div>
              {/each}
            {/if}
          </section>

          {#if impact.scopeReviews.length > 0}
            <section class="review-log">
              <h3>复核留档</h3>
              <ul class="scope-list">
                {#each impact.scopeReviews as review (review.id)}
                  <li>
                    <strong>{review.decision} · {review.operator}</strong>
                    <span>{review.createdAt.replace('T', ' ')} · {review.evidence}</span>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}

          {#if crack.state === '已办结'}
            <p class="closed-note">已办结：关联批次复核完毕，木段已停用。</p>
          {/if}
        {/if}
        {#if crackNotice[crack.id]}<p class="notice">{crackNotice[crack.id]}</p>{/if}
      </article>
    {/each}
  </section>
{/if}

<section class="panel">
  <div class="panel-heading">
    <div>
      <span class="section-kicker">旧版别名</span>
      <h2>重刻旧版留名可查</h2>
    </div>
  </div>
  <label class="stacked-field">
    <span>按别名检索</span>
    <input data-testid="alias-search" bind:value={aliasKeyword} placeholder="如：黄版·旧版 或 梨木段-01" />
  </label>
  {#if aliasKeyword.trim()}
    {#if aliasResults.length === 0}
      <p class="gentle-copy">没有匹配的旧版别名。</p>
    {:else}
      <div class="alias-list">
        {#each aliasResults as block (block.id)}
          {@const replacement = block.replacedById ? blockById(block.replacedById) : null}
          <div class="alias-row" data-testid="row-alias">
            <div>
              <strong>{block.alias}</strong>
              <small>{draftTitle(block.draftId)} · 原{block.blockName} · {block.state}</small>
            </div>
            <div class="alias-side">
              {#if replacement}
                <small>接替版：{replacement.blockName}（{replacement.state}{segmentNoOf(replacement) ? ` · ${segmentNoOf(replacement)}` : ' · 待挂段'}）</small>
              {/if}
              <a class="text-button" use:link href={`/blocks/${block.id}/nodes`}>查看已刻节点</a>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <p class="gentle-copy">重刻后旧版以「版名·旧版(木段号)」留名，输入关键字即可查到旧版、接替版与已刻节点。</p>
  {/if}
</section>

<style>
  .segment-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
    gap: 1rem;
  }

  .segment-card {
    display: grid;
    gap: 0.7rem;
    align-content: start;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 1rem;
    background: #fffdf8;
  }

  .segment-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
  }

  .segment-head h3 {
    margin: 0;
    font-size: 1.05rem;
  }

  .segment-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem 0.8rem;
    margin: 0;
  }

  .segment-meta > div {
    display: grid;
    gap: 0.1rem;
  }

  .segment-meta dt {
    color: var(--ink-muted);
    font-size: 0.72rem;
    font-weight: 800;
  }

  .segment-meta dd {
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.8rem;
  }

  .segment-note {
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.8rem;
    line-height: 1.55;
  }

  .segment-blocks {
    display: grid;
    gap: 0.4rem;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--line-strong);
  }

  .segment-blocks > span {
    color: var(--ink-muted);
    font-size: 0.72rem;
    font-weight: 800;
  }

  .segment-blocks > small {
    color: var(--ink-muted);
  }

  .block-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0.42rem 0.55rem;
    background: var(--paper-deep);
    font-size: 0.78rem;
  }

  .block-chip em {
    color: var(--ink-muted);
    font-size: 0.72rem;
    font-style: normal;
    white-space: nowrap;
  }

  .assign-list {
    display: grid;
    gap: 0.6rem;
  }

  .assign-row {
    display: grid;
    grid-template-columns: minmax(12rem, 1fr) minmax(12rem, 1fr) auto;
    align-items: center;
    gap: 0.8rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.7rem;
    background: #fffdf8;
  }

  .assign-info {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .assign-info small {
    color: var(--ink-muted);
  }

  .crack-list {
    display: grid;
    gap: 1.25rem;
    margin-bottom: 1.25rem;
  }

  .crack-card {
    display: grid;
    gap: 1rem;
  }

  .crack-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .crack-head h2 {
    margin: 0.18rem 0 0.3rem;
    font-size: 1.25rem;
  }

  .crack-head p {
    margin: 0;
    color: var(--ink-muted);
    font-size: 0.84rem;
  }

  .impact-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--line);
  }

  .impact-strip > div {
    display: grid;
    gap: 0.2rem;
    justify-items: center;
    padding: 0.7rem 0.5rem;
    background: var(--paper-deep);
  }

  .impact-strip span {
    color: var(--ink-muted);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .impact-strip strong {
    font-size: 1.3rem;
  }

  .scope-note {
    margin: 0;
    color: var(--ink-muted);
    font-size: 0.78rem;
  }

  .impact-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  .impact-grid h3,
  .batch-review h3,
  .review-log h3 {
    margin: 0 0 0.55rem;
    font-size: 0.95rem;
  }

  .scope-list {
    display: grid;
    gap: 0.45rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .scope-list li {
    display: grid;
    gap: 0.12rem;
    border-left: 3px solid var(--line-strong);
    padding-left: 0.6rem;
    font-size: 0.8rem;
  }

  .scope-list li span {
    color: var(--ink-muted);
    font-size: 0.76rem;
  }

  .batch-review {
    display: grid;
    gap: 0.6rem;
  }

  .batch-review-row {
    display: grid;
    gap: 0.55rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.75rem;
    background: #fffdf8;
  }

  .batch-review-info {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.55rem;
  }

  .batch-review-info small {
    color: var(--ink-muted);
  }

  .review-controls {
    display: grid;
    grid-template-columns: minmax(7rem, auto) 1fr minmax(6rem, auto) auto;
    gap: 0.55rem;
    align-items: center;
  }

  .review-note {
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.78rem;
  }

  .closed-note {
    margin: 0;
    border-left: 3px solid var(--jade);
    padding: 0.55rem 0.75rem;
    color: var(--jade);
    background: rgba(47, 118, 88, 0.08);
    font-size: 0.82rem;
  }

  .alias-list {
    display: grid;
    gap: 0.6rem;
    margin-top: 0.9rem;
  }

  .alias-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.75rem;
    background: #fffdf8;
  }

  .alias-row strong,
  .alias-row small {
    display: block;
  }

  .alias-row small {
    margin-top: 0.2rem;
    color: var(--ink-muted);
  }

  .alias-side {
    display: grid;
    justify-items: end;
    gap: 0.25rem;
  }

  .tag.seg-在用,
  .tag.crack-已办结,
  .tag.review-已复核 {
    color: #fff;
    background: var(--jade);
  }

  .tag.seg-待换料,
  .tag.crack-待处理,
  .tag.block-待换料 {
    color: #fff;
    background: var(--gold);
  }

  .tag.seg-已停用 {
    color: #fff;
    background: var(--ink-muted);
  }

  .tag.crack-排查中,
  .tag.review-待复核 {
    color: #fff;
    background: var(--cinnabar);
  }

  @media (max-width: 900px) {
    .impact-grid,
    .impact-strip {
      grid-template-columns: 1fr 1fr;
    }

    .assign-row,
    .review-controls {
      grid-template-columns: 1fr;
    }
  }
</style>
