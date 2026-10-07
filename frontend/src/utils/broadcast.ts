export type ArchiveChannelMessage = 'changed'

const CHANNEL_NAME = 'gbwoodprint-archive'

let channel: BroadcastChannel | null = null

function openChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  return channel
}

/** 本标签页完成关键写入后通知其它标签页重新读库 */
export function broadcastArchiveChanged(): void {
  openChannel()?.postMessage('changed' satisfies ArchiveChannelMessage)
}

/** 其它标签页完成关键写入时收到通知，本页据此刷新内存数据 */
export function onArchiveChanged(handler: () => void): () => void {
  const current = openChannel()
  if (!current) return () => undefined
  const listener = (event: MessageEvent<ArchiveChannelMessage>) => {
    if (event.data === 'changed') handler()
  }
  current.addEventListener('message', listener)
  return () => current.removeEventListener('message', listener)
}
