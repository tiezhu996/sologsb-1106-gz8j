import { derived, get, writable } from 'svelte/store'
import type { Block } from '../types/block'
import { blockStore } from '../stores/blockStore'

export function useBlockOrder(draftId: string | null) {
  const targetDraft = writable<string | null>(draftId)

  const blocks = derived([blockStore, targetDraft], ([$blocks, $draftId]) => {
    const selected = $draftId ? $blocks.filter((block) => block.draftId === $draftId) : [...$blocks]
    return selected.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.colorNo - b.colorNo)
  })

  const carvedRate = derived(blocks, ($blocks) => {
    // 停用旧版留档但不计入当前刻成率
    const active = $blocks.filter((block) => block.state !== '已停用')
    if (active.length === 0) return 0
    const carved = active.filter((block) => block.state === '已刻成' || block.state === '已修版').length
    return Math.round((carved / active.length) * 100)
  })

  async function reorder(ordered: Array<Pick<Block, 'id' | 'colorNo'>>): Promise<void> {
    await blockStore.reorder(ordered)
  }

  function setDraft(nextDraftId: string | null): void {
    targetDraft.set(nextDraftId)
  }

  function occupiedNumbers(exceptId?: string): number[] {
    return get(blocks)
      .filter((block) => block.id !== exceptId)
      .map((block) => block.colorNo)
  }

  return { blocks, carvedRate, reorder, setDraft, occupiedNumbers }
}
