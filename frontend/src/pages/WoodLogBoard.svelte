<script lang="ts">
  import { onMount } from 'svelte'
  import { link } from 'svelte-spa-router'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import ColorSwatch from '../components/common/ColorSwatch.svelte'
  import { woodLogStore } from '../stores/woodLogStore'
  import { blockStore } from '../stores/blockStore'
  import { draftStore } from '../stores/draftStore'
  import { crackStore } from '../stores/crackStore'
  import { onArchiveChanged } from '../utils/broadcast'
  import type { WoodLog, WoodType } from '../types/woodLog'
  import type { Block } from '../types/block'

  let showForm = $state(false)
  let logNo = $state('')
  let woodType = $state<WoodType>('梨木')
  let receivedAt = $state(new Date().toISOString().slice(0, 10))
  let sourceNote = $state('')
  let formMessage = $state('')
  let attachDraftId = $state('')
  let attachSelection = $state<Record<string, string[]>>({})
  let notice = $state('')

  onMount(() => {
    void refreshAll()
    return onArchiveChanged(() => {
      void refreshAll()
    })
  })

  async function refreshAll(): Promise<void> {
    await Promise.all([woodLogStore.load(), blockStore.load(), draftStore.load(), crackStore.load()])
  }

  const openCrackCountByLog = $derived.by(() => {
    const counts: Record<string, number> = {}
    for (const crack of $crackStore) {
      if (crack.status !== '待处理') continue
      counts[crack.woodLogId] = (counts[crack.woodLogId] ?? 0) + 1
    }
    return counts
  })

  const activeLogs = $derived($woodLogStore.filter((log) => log.status === '在用'))
  const unassignedBlocks = $derived(
    $blockStore.filter((block) => !block.woodLogId && block.state !== '已停用'),
  )

  function blocksOfLog(log: WoodLog): Block[] {
    return $blockStore
      .filter((block) => block.woodLogId === log.id)
      .sort((a, b) => a.draftId.localeCompare(b.draftId) || a.colorNo - b.colorNo)
  }

  function draftTitle(draftId: string): string {
    return $draftStore.find((draft) => draft.id === draftId)?.title ?? '未知画稿'
  }

  /** 可挂到本段的版片：同木质、未停用、且当前不在本段上（含未挂段和挂在别段的） */
  function attachableBlocks(log: WoodLog): Block[] {
    const draftFiltered = attachDraftId
      ? $blockStore.filter((block) => block.draftId === attachDraftId)
      : $blockStore
    return draftFiltered
      .filter(
        (block) =>
          block.woodType === log.woodType &&
          block.woodLogId !== log.id &&
          block.state !== '已停用',
      )
      .sort((a, b) => a.draftId.localeCompare(b.draftId) || a.colorNo - b.colorNo)
  }

  function toggleAttach(logId: string, blockId: string, checked: boolean): void {
    const current = attachSelection[logId] ?? []
    attachSelection = {
      ...attachSelection,
      [logId]: checked ? [...current, blockId] : current.filter((id) => id !== blockId),
    }
  }

  async function submitLog(): Promise<void> {
    if (!logNo.trim() || !sourceNote.trim()) {
      formMessage = '请补全木段编号与来源备注。'
      return
    }
    await woodLogStore.create({
      logNo: logNo.trim(),
      woodType,
      receivedAt,
      sourceNote: sourceNote.trim(),
      status: '在用',
    })
    logNo = ''
    sourceNote = ''
    formMessage = ''
    showForm = false
    notice = '木段已登记，可在下方把版片挂到本段。'
  }

  async function attach(log: WoodLog): Promise<void> {
    const ids = attachSelection[log.id] ?? []
    if (ids.length === 0) {
      notice = '请先勾选要挂到本段的版片。'
      return
    }
    await woodLogStore.attachBlocks(log.id, ids)
    await blockStore.load()
    attachSelection = { ...attachSelection, [log.id]: [] }
    notice = `已把 ${ids.length} 块版片挂到${log.logNo}，木段版本已更新。`
  }

  async function detach(log: WoodLog, block: Block): Promise<void> {
    await woodLogStore.detachBlocks([block.id])
    await blockStore.load()
    notice = `${block.blockName}已从${log.logNo}摘除。`
  }

  async function quickAssign(block: Block, logId: string): Promise<void> {
    if (!logId) return
    await woodLogStore.attachBlocks(logId, [block.id])
    await blockStore.load()
    notice = `${block.blockName}已挂段。`
  }
</script>

<svelte:head>
  <title>木料段追溯 · 木版年画刻版工序档案</title>
</svelte:head>

<div class="page-heading">
  <div>
    <p class="eyebrow">木料段追溯</p>
    <h1>木段去向与挂段</h1>
    <p>登记每根木段的来源，把已开版片挂回木段。裂纹影响范围一律按木段判断，跨画稿版片也一并追溯。</p>
  </div>
  <div class="heading-actions">
    <a class="button ghost" use:link href="/cracks">裂纹工单台</a>
    <button class="button primary" data-testid="new-woodlog" type="button" onclick={() => (showForm = !showForm)}>
      {showForm ? '收起登记' : '登记木段'}
    </button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>在册木段</span><strong data-testid="count-woodlog">{$woodLogStore.length}</strong></div>
  <div><span>在用木段</span><strong>{activeLogs.length}</strong></div>
  <div><span>未挂段版片</span><strong data-testid="count-unassigned">{unassignedBlocks.length}</strong></div>
  <div><span>待处理裂纹</span><strong data-testid="count-open-crack">{$crackStore.filter((c) => c.status === '待处理').length}</strong></div>
</section>

{#if showForm}
  <section class="panel form-panel" data-testid="form-woodlog">
    <div class="panel-heading">
      <div><span class="section-kicker">新木段</span><h2>登记木料段</h2></div>
    </div>
    <div class="form-grid three">
      <label>
        <span>木段编号</span>
        <input data-testid="field-woodlog-no" bind:value={logNo} placeholder="如：梨木-2610-丁段" />
      </label>
      <label>
        <span>木质</span>
        <select data-testid="field-woodlog-type" bind:value={woodType}>
          <option value="梨木">梨木</option>
          <option value="黄杨">黄杨</option>
        </select>
      </label>
      <label>
        <span>进料日期</span>
        <input data-testid="field-woodlog-date" type="date" bind:value={receivedAt} />
      </label>
      <label class="wide">
        <span>来源与内裂备注</span>
        <textarea
          data-testid="field-woodlog-note"
          rows="2"
          bind:value={sourceNote}
          placeholder="进料批次、开料情况、端头是否见内裂隐线"
        ></textarea>
      </label>
    </div>
    {#if formMessage}<p class="form-message">{formMessage}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-woodlog" type="button" onclick={submitLog}>保存木段</button>
      <button class="button ghost" type="button" onclick={() => (showForm = false)}>取消</button>
    </div>
  </section>
{/if}

{#if notice}<p class="notice">{notice}</p>{/if}

{#if unassignedBlocks.length > 0}
  <section class="panel" data-testid="unassigned-panel">
    <div class="panel-heading">
      <div><span class="section-kicker">去向待补</span><h2>未挂木段的版片（{unassignedBlocks.length}）</h2></div>
    </div>
    <div class="unassigned-grid">
      {#each unassignedBlocks as block (block.id)}
        <div class="unassigned-row">
          <ColorSwatch colorNo={block.colorNo} blockName={block.blockName} />
          <span class="tag state-{block.state}">{block.state}</span>
          <small>{draftTitle(block.draftId)}</small>
          <select
            aria-label={`${block.blockName}挂到木段`}
            value=""
            onchange={(event) => quickAssign(block, (event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">选择木段…</option>
            {#each $woodLogStore.filter((log) => log.woodType === block.woodType && log.status === '在用') as log}
              <option value={log.id}>{log.logNo}</option>
            {/each}
          </select>
        </div>
      {/each}
    </div>
  </section>
{/if}

{#if $woodLogStore.length === 0}
  <EmptyBox title="尚未登记木段" message="先登记进料木段，再把已开版片逐块挂回木段。" />
{:else}
  <section class="woodlog-list">
    {#each $woodLogStore as log (log.id)}
      {@const attached = blocksOfLog(log)}
      {@const candidates = attachableBlocks(log)}
      {@const openCracks = openCrackCountByLog[log.id] ?? 0}
      <article class="panel woodlog-card" data-testid="row-woodlog">
        <div class="woodlog-head">
          <div>
            <span class="section-kicker">{log.woodType} · {log.receivedAt}</span>
            <h2>{log.logNo}</h2>
            <p class="gentle-copy">{log.sourceNote}</p>
          </div>
          <div class="woodlog-meta">
            <span class="tag status-{log.status === '在用' ? 3 : 0}">{log.status}</span>
            <span class="tag wood-version">木段版本 {log.woodVersion}</span>
            {#if openCracks > 0}<span class="tag crack-badge">待处理裂纹 {openCracks}</span>{/if}
          </div>
        </div>

        <div class="attached-blocks">
          <div class="section-title-row">
            <h3>本段版片（{attached.length}）</h3>
            <a class="button ghost mini" use:link href={`/cracks/new?woodLogId=${log.id}`}>报本段裂纹</a>
          </div>
          {#if attached.length === 0}
            <p class="gentle-copy">本段还没有挂接版片。</p>
          {:else}
            <div class="table-scroll">
              <table class="data-table compact">
                <thead>
                  <tr><th>画稿</th><th>版片</th><th>状态</th><th>别名 / 去向</th><th></th></tr>
                </thead>
                <tbody>
                  {#each attached as block (block.id)}
                    <tr data-testid="row-attached-block">
                      <td>{draftTitle(block.draftId)}</td>
                      <td><ColorSwatch colorNo={block.colorNo} blockName={block.blockName} /></td>
                      <td><span class="tag state-{block.state}">{block.state}</span></td>
                      <td>
                        {#if block.alias}<small>旧版别名：{block.alias}</small>{/if}
                        {#if block.replacedByBlockId}<small>已重刻，<a use:link href={`/blocks/${block.replacedByBlockId}/nodes`}>查新版</a></small>{/if}
                      </td>
                      <td>
                        <a class="mini-button" use:link href={`/blocks/${block.id}/nodes`}>工序</a>
                        <button class="mini-button" type="button" onclick={() => detach(log, block)}>摘段</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>

        <div class="attach-block">
          <div class="section-title-row">
            <h3>挂接版片到本段</h3>
            <select aria-label="按画稿筛选" bind:value={attachDraftId}>
              <option value="">全部画稿</option>
              {#each $draftStore as draft}<option value={draft.id}>{draft.title}</option>{/each}
            </select>
          </div>
          {#if candidates.length === 0}
            <p class="gentle-copy">没有可挂的同木质版片（未停用且未挂本段）。</p>
          {:else}
            <div class="attach-candidates">
              {#each candidates as block (block.id)}
                <label class="attach-option">
                  <input
                    type="checkbox"
                    checked={(attachSelection[log.id] ?? []).includes(block.id)}
                    onchange={(event) => toggleAttach(log.id, block.id, (event.currentTarget as HTMLInputElement).checked)}
                  />
                  <span>
                    <b>{draftTitle(block.draftId)}</b>
                    <ColorSwatch colorNo={block.colorNo} blockName={block.blockName} />
                    <em>{block.woodLogId ? $woodLogStore.find((item) => item.id === block.woodLogId)?.logNo ?? '别段' : '未挂段'}</em>
                  </span>
                </label>
              {/each}
            </div>
            <button class="button secondary" data-testid={`attach-${log.id}`} type="button" onclick={() => attach(log)}>
              挂到{log.logNo}（{(attachSelection[log.id] ?? []).length}）
            </button>
          {/if}
        </div>
      </article>
    {/each}
  </section>
{/if}
