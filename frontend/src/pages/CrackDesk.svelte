<script lang="ts">
  import { onMount } from 'svelte'
  import { link, location } from 'svelte-spa-router'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import ColorSwatch from '../components/common/ColorSwatch.svelte'
  import { crackStore, pendingCrackStore, type CrackSubmitConflict } from '../stores/crackStore'
  import { woodLogStore } from '../stores/woodLogStore'
  import { blockStore } from '../stores/blockStore'
  import { draftStore } from '../stores/draftStore'
  import { db } from '../utils/db'
  import { onArchiveChanged } from '../utils/broadcast'
  import { impactOfWoodLog } from '../utils/trace'
  import type { Block } from '../types/block'
  import type { CrackLog } from '../types/crack'
  import type { PrintBatch } from '../types/batch'
  import type { ProcessNode } from '../types/node'
  import type { BatchReview } from '../types/batchReview'

  const pending = pendingCrackStore()

  let nodes = $state<ProcessNode[]>([])
  let batches = $state<PrintBatch[]>([])
  let expandedCrackId = $state<string | null>(null)
  let submitting = $state(false)
  let conflict = $state<CrackSubmitConflict | null>(null)
  /** 最近一次提交所依据的木段版本号，用于冲突提示 */
  let submittedVersion = $state(0)
  let formMessage = $state('')
  let retryMessage = $state('')

  // 上报表单
  let showForm = $state(false)
  let fWoodLogId = $state('')
  let fBlockId = $state('')
  let fFoundAt = $state(new Date().toISOString().slice(0, 10))
  let fDescription = $state('')
  let fReporter = $state('')

  // 处置表单
  let resolveKind = $state<'重刻' | '沿用原印样'>('重刻')
  let resolveBasis = $state('')
  let newWoodLogId = $state('')
  let resolveOperator = $state('')
  let resolving = $state(false)

  // 批次复核表单
  let reviewKindByBatch = $state<Record<string, '重刻' | '沿用原印样'>>({})
  let reviewBasisByBatch = $state<Record<string, string>>({})
  let reviewingBatchId = $state<string | null>(null)

  onMount(() => {
    void refreshAll().then(() => {
      const queryWoodLogId = new URLSearchParams($location.split('?')[1] ?? '').get('woodLogId')
      if (queryWoodLogId && $woodLogStore.some((log) => log.id === queryWoodLogId)) {
        openForm(queryWoodLogId)
      }
    })
    return onArchiveChanged(() => {
      // 其它标签页写入后刷新；本页自身写入已在各处理函数里显式 refreshAll。
      if (!submitting && !resolving && !reviewingBatchId) {
        void refreshAll()
      }
    })
  })

  async function refreshAll(): Promise<void> {
    const [allNodes, allBatches] = await Promise.all([
      db.nodes.toArray(),
      db.batches.toArray(),
      woodLogStore.load(),
      blockStore.load(),
      draftStore.load(),
      crackStore.load(),
    ])
    nodes = allNodes
    batches = allBatches
  }

  const sortedCracks = $derived(
    [...$crackStore].sort((a, b) => {
      if (a.status !== b.status) return a.status === '待处理' ? -1 : 1
      return b.createdAt.localeCompare(a.createdAt)
    }),
  )

  const formWoodLog = $derived($woodLogStore.find((log) => log.id === fWoodLogId) ?? null)
  const formBlock = $derived($blockStore.find((block) => block.id === fBlockId) ?? null)
  const formImpact = $derived(
    formWoodLog
      ? impactOfWoodLog({
          woodLogId: formWoodLog.id,
          blocks: $blockStore,
          nodes,
          batches,
        })
      : null,
  )

  const pendingReviewCount = $derived(
    batches.filter((batch) => batch.reviewState === '待复核').length,
  )

  function draftTitle(draftId: string): string {
    return $draftStore.find((draft) => draft.id === draftId)?.title ?? '未知画稿'
  }

  function woodLogOf(block?: Block | null) {
    if (!block?.woodLogId) return null
    return $woodLogStore.find((log) => log.id === block.woodLogId) ?? null
  }

  function openForm(presetWoodLogId?: string): void {
    showForm = true
    conflict = null
    formMessage = ''
    const logId = presetWoodLogId ?? fWoodLogId ?? $woodLogStore[0]?.id ?? ''
    fWoodLogId = logId
    if (!fBlockId) {
      const first = $blockStore.find((block) => block.woodLogId === logId && block.state !== '已停用')
      if (first) fBlockId = first.id
    }
  }

  function selectWoodLog(logId: string): void {
    fWoodLogId = logId
    fBlockId = ''
    conflict = null
    const first = $blockStore.find((block) => block.woodLogId === logId && block.state !== '已停用')
    if (first) fBlockId = first.id
  }

  function resetForm(): void {
    showForm = false
    conflict = null
    formMessage = ''
    fDescription = ''
  }

  async function submit(prefill?: {
    woodLogId: string
    blockId: string
    foundAt: string
    description: string
    reporter: string
    expectedWoodVersion: number
    clientToken?: string
  }): Promise<void> {
    const payload = prefill ?? {
      woodLogId: fWoodLogId,
      blockId: fBlockId,
      foundAt: fFoundAt,
      description: fDescription,
      reporter: fReporter,
      expectedWoodVersion: formWoodLog?.woodVersion ?? 0,
    }
    if (!payload.woodLogId || !payload.blockId) {
      formMessage = '请先选择木段和首现裂纹的版片。'
      return
    }
    if (!payload.description.trim()) {
      formMessage = '请描述裂纹位置与发现情况。'
      return
    }
    if (!payload.reporter.trim()) {
      formMessage = '请填写登记人。'
      return
    }

    submitting = true
    submittedVersion = formWoodLog?.woodVersion ?? payload.expectedWoodVersion
    const outcome = await crackStore.submitCrack({
      form: {
        woodLogId: payload.woodLogId,
        blockId: payload.blockId,
        foundAt: payload.foundAt,
        description: payload.description,
        reporter: payload.reporter,
      },
      expectedWoodVersion: payload.expectedWoodVersion,
      ...(prefill?.clientToken ? { clientToken: prefill.clientToken } : {}),
    })
    submitting = false

    if (outcome.ok) {
      conflict = null
      formMessage = ''
      fDescription = ''
      showForm = false
      expandedCrackId = outcome.crack.id
      await refreshAll()
    } else if (outcome.retryable) {
      formMessage = `写入失败已转入待处理队列（${outcome.error.message}），可在下方待处理区重试，不会留下半套换料记录。`
      showForm = false
    } else {
      // 冲突未写入：拉取最新木段版本与已有工单，避免再次基于旧版本提交
      conflict = outcome.conflict
      await refreshAll()
      // refreshAll 会重建工单列表，确保冲突框引用的已有工单仍能展开
      if (outcome.conflict.type === 'woodVersion' && outcome.conflict.existingCrack) {
        expandedCrackId = outcome.conflict.existingCrack.id
      }
    }
  }

  async function adoptConflict(): Promise<void> {
    const current = conflict
    const existingId = current?.type === 'woodVersion' ? current.existingCrack?.id : undefined
    conflict = null
    fWoodLogId = ''
    fBlockId = ''
    await refreshAll()
    if (existingId) expandedCrackId = existingId
  }

  async function retry(item: (typeof $pending)[number]): Promise<void> {
    retryMessage = '正在重试待处理写入…'
    const outcome = await crackStore.retryPending(item)
    if (outcome.ok) {
      retryMessage = '待处理裂纹已补写成功。'
      expandedCrackId = outcome.crack.id
      await refreshAll()
    } else if (outcome.retryable) {
      retryMessage = `仍写入失败：${outcome.error.message}，保留在待处理队列可再次重试。`
    } else {
      retryMessage = '重试时发现冲突，请刷新数据后按最新木段情况登记。'
      conflict = outcome.conflict
    }
  }

  function discardPending(item: (typeof $pending)[number]): void {
    pending.drop(item.clientToken)
    retryMessage = '已撤下该条待处理写入，表单未写入任何换料记录。'
  }

  async function resolve(crack: CrackLog): Promise<void> {
    if (!resolveBasis.trim()) {
      formMessage = '处置必须留依据：请填写重刻或沿用原印样的判断依据。'
      return
    }
    if (!resolveOperator.trim()) {
      formMessage = '请填写处置人。'
      return
    }
    resolving = true
    try {
      await crackStore.resolveCrack({
        crackId: crack.id,
        kind: resolveKind,
        basis: resolveBasis,
        decidedBy: resolveOperator,
        ...(resolveKind === '重刻' && newWoodLogId ? { newWoodLogId } : {}),
      })
      resolveBasis = ''
      newWoodLogId = ''
      formMessage = ''
      await refreshAll()
    } catch (error) {
      formMessage = error instanceof Error ? error.message : '处置失败。'
    } finally {
      resolving = false
    }
  }

  async function submitReview(crack: CrackLog, batch: PrintBatch): Promise<void> {
    const basis = reviewBasisByBatch[batch.id] ?? ''
    if (!basis.trim()) {
      reviewingBatchId = null
      formMessage = '复核必须留依据，请填写印样检查结论。'
      return
    }
    reviewingBatchId = batch.id
    try {
      await crackStore.reviewBatch({
        batchId: batch.id,
        crackId: crack.id,
        kind: reviewKindByBatch[batch.id] ?? '沿用原印样',
        basis,
        reviewer: resolveOperator || '当班管事',
      })
      reviewBasisByBatch = { ...reviewBasisByBatch, [batch.id]: '' }
      formMessage = ''
    } catch (error) {
      formMessage = error instanceof Error ? error.message : '复核保存失败。'
    } finally {
      reviewingBatchId = null
    }
  }

  function impact(crack: CrackLog) {
    return impactOfWoodLog({
      woodLogId: crack.woodLogId,
      blocks: $blockStore,
      nodes,
      batches,
    })
  }

  function reviewsOfCrack(crack: CrackLog): BatchReview[] {
    return crackStore.reviewsForCrack(crack.id)
  }

  function toggle(id: string): void {
    expandedCrackId = expandedCrackId === id ? null : id
  }
</script>

<svelte:head>
  <title>裂纹工单台 · 木版年画刻版工序档案</title>
</svelte:head>

<div class="page-heading">
  <div>
    <p class="eyebrow">木料内裂追溯</p>
    <h1>裂纹工单台</h1>
    <p>裂纹一出现就沿木段追溯关联工序节点与印制批次。范围按木段判断，不按版片现状缩小，已印批次逐批复核留据。</p>
  </div>
  <div class="heading-actions">
    <a class="button ghost" use:link href="/woodlogs">木料段追溯</a>
    <button class="button primary" data-testid="new-crack" type="button" onclick={() => openForm()}>上报裂纹</button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>待处理裂纹</span><strong data-testid="count-open">{$crackStore.filter((c) => c.status === '待处理').length}</strong></div>
  <div><span>已处理裂纹</span><strong>{$crackStore.filter((c) => c.status === '已处理').length}</strong></div>
  <div><span>待复核批次</span><strong data-testid="count-pending-review">{pendingReviewCount}</strong></div>
  <div><span>待处理写入</span><strong data-testid="count-pending-write">{$pending.length}</strong></div>
</section>

{#if $pending.length > 0}
  <section class="panel pending-write" data-testid="pending-write-panel">
    <div class="panel-heading">
      <div><span class="section-kicker">写入失败 · 待处理重试</span><h2>待处理裂纹写入（{$pending.length}）</h2></div>
    </div>
    <p class="gentle-copy">下列提交的事务已整体回滚，没有产生半套换料记录；重试沿用原令牌，不会重复建工单。</p>
    <div class="pending-list">
      {#each $pending as item (item.clientToken)}
        <div class="pending-row" data-testid="pending-row">
          <div>
            <strong>{$woodLogStore.find((log) => log.id === item.form.woodLogId)?.logNo ?? item.form.woodLogId}</strong>
            <span>登记人 {item.form.reporter} · 发现 {item.form.foundAt} · 已尝试 {item.attempts} 次</span>
            <p>{item.form.description}</p>
          </div>
          <div class="inline-actions">
            <button class="button primary" data-testid={`retry-${item.clientToken}`} type="button" onclick={() => retry(item)}>重试写入</button>
            <button class="button danger" type="button" onclick={() => discardPending(item)}>撤下</button>
          </div>
        </div>
      {/each}
    </div>
    {#if retryMessage}<p class="notice">{retryMessage}</p>{/if}
  </section>
{/if}

{#if showForm}
  <section class="panel form-panel" data-testid="form-crack">
    <div class="panel-heading">
      <div><span class="section-kicker">新裂纹工单</span><h2>登记裂纹并沿木段定范围</h2></div>
      <button class="text-button" type="button" onclick={resetForm}>收起</button>
    </div>

    {#if conflict}
      <div class="conflict-box" data-testid="conflict-box">
        <h3>⚠ 提交冲突：另一标签页已先提交该木段裂纹</h3>
        {#if conflict.type === 'woodVersion'}
          <p>
            你提交时依据的是木段第 <strong>{submittedVersion}</strong> 版；另一标签页的提交已经生效，
            当前库中木段已到 <strong>第 {conflict.latestVersion} 版</strong>，本条未写入。
          </p>
          {#if conflict.existingCrack}
            {@const ec = conflict.existingCrack}
            <p>已有待处理工单（{ec.foundAt} 由 {ec.reporter} 登记），请先查看该工单，确认是否为同一条裂纹后再决定改挂木段或补充说明。</p>
          {/if}
          <div class="inline-actions">
            {#if conflict.existingCrack}
              <button class="button primary" type="button" onclick={adoptConflict}>查看已提交工单</button>
            {/if}
            <button class="button ghost" type="button" onclick={() => (conflict = null)}>我知道了，修改表单</button>
          </div>
        {/if}
      </div>
    {/if}

    <div class="form-grid three">
      <label>
        <span>木段（影响范围按此判断）</span>
        <select data-testid="field-crack-woodlog" value={fWoodLogId} onchange={(e) => selectWoodLog((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">请选择木段</option>
          {#each $woodLogStore.filter((log) => log.status === '在用') as log}
            <option value={log.id}>{log.logNo}（v{log.woodVersion}）</option>
          {/each}
        </select>
      </label>
      <label>
        <span>首现裂纹版片</span>
        <select data-testid="field-crack-block" bind:value={fBlockId}>
          <option value="">请选择版片</option>
          {#each $blockStore.filter((b) => b.woodLogId === fWoodLogId && b.state !== '已停用') as block}
            <option value={block.id}>{draftTitle(block.draftId)} · {block.blockName}（{block.state}）</option>
          {/each}
        </select>
      </label>
      <label>
        <span>发现日期</span>
        <input data-testid="field-crack-foundat" type="date" bind:value={fFoundAt} />
      </label>
      <label>
        <span>登记人</span>
        <input data-testid="field-crack-reporter" bind:value={fReporter} placeholder="当班管事姓名" />
      </label>
      <label class="wide">
        <span>裂纹描述</span>
        <textarea data-testid="field-crack-description" rows="2" bind:value={fDescription} placeholder="裂纹走向、长度、试印表现"></textarea>
      </label>
    </div>

    {#if formWoodLog && formImpact}
      <div class="impact-preview" data-testid="impact-preview">
        <div class="section-title-row">
          <h3>提交后将沿木段「{formWoodLog.logNo}」一次性处理（当前第 {formWoodLog.woodVersion} 版）</h3>
        </div>
        <ul class="impact-list">
          <li>关联版片 <strong>{formImpact.blocks.length}</strong> 块，跨画稿 {formImpact.draftIds.length} 张：
            {formImpact.blocks.map((b) => `${draftTitle(b.draftId)}${b.blockName}`).join('、')}
          </li>
          <li>关联工序节点 <strong>{formImpact.nodes.length}</strong> 个——已刻节点全部保留。</li>
          <li>未刻版片 <strong>{formImpact.uncarvedBlocks.length}</strong> 块转<span class="tag state-待换料">待换料</span>；
            已刻/在刻 <strong>{formImpact.carvedBlocks.length}</strong> 块保留状态转复核。</li>
          <li>关联画稿下的全部已印批次 <strong>{formImpact.batches.length}</strong> 批将转<span class="tag review-tag">待复核</span>，范围不按版片现状缩小。</li>
        </ul>
      </div>
    {/if}

    {#if formMessage}<p class="form-message">{formMessage}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-crack" type="button" disabled={submitting} onclick={() => submit()}>
        {submitting ? '提交中…' : '提交裂纹工单'}
      </button>
      <button class="button ghost" type="button" onclick={resetForm}>取消</button>
    </div>
  </section>
{/if}

{#if sortedCracks.length === 0 && $pending.length === 0}
  <EmptyBox title="尚无裂纹工单" message="发现内裂后先在木料段页挂好版片，再在此沿木段上报，系统会自动圈定关联节点与印制批次。" />
{/if}

<section class="crack-list">
  {#each sortedCracks as crack (crack.id)}
    {@const woodLog = $woodLogStore.find((log) => log.id === crack.woodLogId)}
    {@const scope = impact(crack)}
    {@const isOpen = crack.status === '待处理'}
    {@const expanded = expandedCrackId === crack.id}
    {@const crackReviews = expanded ? reviewsOfCrack(crack) : []}
    <article class="panel crack-card" class:open={isOpen} data-testid="row-crack">
      <button class="crack-summary" type="button" onclick={() => toggle(crack.id)}>
        <div>
          <span class="section-kicker">{woodLog?.logNo ?? crack.woodLogId} · 提交时 v{crack.woodVersionAtSubmit}</span>
          <h2>{crack.description || '裂纹工单'}</h2>
          <p>{crack.foundAt} 发现 · 登记人 {crack.reporter} · 首现版片 {$blockStore.find((b) => b.id === crack.blockId)?.blockName ?? '（已归档）'}</p>
        </div>
        <div class="crack-badges">
          <span class="tag {isOpen ? 'crack-badge' : 'resolved-badge'}">{crack.status}</span>
          {#if crack.resolution}<span class="tag">{crack.resolution.kind}</span>{/if}
          <span class="tag">{scope.blocks.length} 块 · {scope.nodes.length} 节点</span>
          <strong class="expand-mark">{expanded ? '收起' : '展开'}</strong>
        </div>
      </button>

      {#if expanded}
        <div class="crack-detail">
          <div class="scope-grid">
            <div class="scope-col">
              <h3>沿木段关联版片</h3>
              <ul class="scope-list">
                {#each scope.blocks as block (block.id)}
                  <li class="{block.state === '已停用' ? 'muted-row' : ''}">
                    <ColorSwatch colorNo={block.colorNo} blockName={block.blockName} />
                    <span>{draftTitle(block.draftId)}</span>
                    <span class="tag state-{block.state}">{block.state}</span>
                    {#if block.alias}<small>旧版别名 {block.alias}</small>{/if}
                    {#if block.replacedByBlockId}
                      <a class="mini-button" use:link href={`/blocks/${block.replacedByBlockId}/nodes`}>新版</a>
                    {/if}
                    <a class="mini-button" use:link href={`/blocks/${block.id}/nodes`}>节点</a>
                  </li>
                {/each}
              </ul>
              <p class="gentle-copy">
                未刻 {scope.uncarvedBlocks.length} 块转待换料；已刻 {scope.carvedBlocks.length} 块保留已刻节点。
              </p>
            </div>
            <div class="scope-col">
              <h3>关联工序节点（{scope.nodes.length}）</h3>
              {#if scope.nodes.length === 0}
                <p class="gentle-copy">本段版片尚无已登记工序节点。</p>
              {:else}
                <ul class="node-scope">
                  {#each [...scope.nodes].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) as node (node.id)}
                    <li>
                      <strong>{node.stage}</strong>
                      <span>{node.operator} · {node.startedAt.replace('T', ' ')}</span>
                      <em>{$blockStore.find((b) => b.id === node.blockId)?.blockName}</em>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>

          <div class="batch-review-block" data-testid={`batches-${crack.id}`}>
            <h3>关联印制批次（{scope.batches.length}）· 逐批复核留据</h3>
            {#if scope.batches.length === 0}
              <p class="gentle-copy">波及画稿尚未登记印制批次；之后试印的批次不受本工单影响。</p>
            {:else}
              <div class="review-list">
                {#each [...scope.batches].sort((a, b) => b.printedAt.localeCompare(a.printedAt)) as batch (batch.id)}
                  {@const review = crackReviews
                    .filter((item) => item.batchId === batch.id)
                    .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0]}
                  <article class="review-row" data-testid="review-row">
                    <div class="review-head">
                      <div>
                        <strong>{batch.batchNo}</strong>
                        <span>{batch.printedAt} · {draftTitle(batch.draftId)} · 印 {batch.qty} 张 · {batch.paperBatch}</span>
                      </div>
                      {#if batch.invalidatedByCrackId === crack.id && batch.reviewState === '待复核'}
                        <span class="tag review-tag">待复核</span>
                      {:else if review}
                        <span class="tag resolved-badge">已复核 · {review.kind}</span>
                      {:else}
                        <span class="tag">{batch.reviewState}</span>
                      {/if}
                    </div>
                    {#if review}
                      <p class="review-basis"><b>{review.kind}依据：</b>{review.basis}<small>{review.reviewer} · {review.reviewedAt.replace('T', ' ').slice(0, 16)}</small></p>
                    {/if}
                    {#if batch.invalidatedByCrackId === crack.id && batch.reviewState === '待复核'}
                      <div class="review-form">
                        <select bind:value={reviewKindByBatch[batch.id]}>
                          <option value="沿用原印样">沿用原印样</option>
                          <option value="重刻">重刻新版后重印</option>
                        </select>
                        <input
                          data-testid={`review-basis-${batch.id}`}
                          bind:value={reviewBasisByBatch[batch.id]}
                          placeholder="复核依据：抽验数量、裂纹是否转印、与原印样比对结论"
                        />
                        <button
                          class="button primary"
                          data-testid={`submit-review-${batch.id}`}
                          type="button"
                          disabled={reviewingBatchId === batch.id}
                          onclick={() => submitReview(crack, batch)}
                        >
                          保存复核
                        </button>
                      </div>
                      {#if (reviewKindByBatch[batch.id] ?? '沿用原印样') === '重刻' && !crack.resolution}
                        <p class="gentle-copy">提示：工单尚未处置。若木段需整体重刻，请先在下方提交「重刻」处置，旧版停用后再按新版重印。</p>
                      {/if}
                    {/if}
                  </article>
                {/each}
              </div>
            {/if}
          </div>

          {#if isOpen}
            <div class="resolve-block">
              <h3>工单处置（留依据后旧版才停用 / 版片才恢复）</h3>
              <div class="form-grid three">
                <label>
                  <span>处置方式</span>
                  <select bind:value={resolveKind}>
                    <option value="重刻">重刻（旧版留别名停用，另刻新版）</option>
                    <option value="沿用原印样">沿用原印样（木段停用，版片恢复）</option>
                  </select>
                </label>
                {#if resolveKind === '重刻'}
                  <label>
                    <span>新版挂接木段</span>
                    <select bind:value={newWoodLogId}>
                      <option value="">暂不指定（新料未到，先留待料）</option>
                      {#each $woodLogStore.filter((log) => log.status === '在用') as log}
                        <option value={log.id}>{log.logNo}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
                <label>
                  <span>处置人</span>
                  <input data-testid="field-resolve-operator" bind:value={resolveOperator} placeholder="管事姓名" />
                </label>
                <label class="wide">
                  <span>处置依据</span>
                  <textarea data-testid="field-resolve-basis" rows="2" bind:value={resolveBasis} placeholder="裂纹深度/走丝判断、试印对比、新料来源等"></textarea>
                </label>
              </div>
              <button class="button primary" data-testid={`resolve-${crack.id}`} type="button" disabled={resolving} onclick={() => resolve(crack)}>
                {resolving ? '处置中…' : '提交处置（单事务原子生效）'}
              </button>
            </div>
          {:else if crack.resolution}
            <div class="resolved-record">
              <h3>处置留档</h3>
              <p><b>{crack.resolution.kind}</b> · {crack.resolution.decidedBy} · {crack.resolution.decidedAt.replace('T', ' ').slice(0, 16)}</p>
              <p>{crack.resolution.basis}</p>
            </div>
          {/if}
        </div>
      {/if}
    </article>
  {/each}
</section>
