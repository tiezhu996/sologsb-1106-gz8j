import DraftList from '../pages/DraftList.svelte'
import BlockBoard from '../pages/BlockBoard.svelte'
import NodeTimeline from '../pages/NodeTimeline.svelte'
import WoodTrace from '../pages/WoodTrace.svelte'
import BatchList from '../pages/BatchList.svelte'
import CarverList from '../pages/CarverList.svelte'

export const routes = {
  '/drafts': DraftList,
  '/drafts/:id/blocks': BlockBoard,
  '/blocks/:id/nodes': NodeTimeline,
  '/wood': WoodTrace,
  '/batches': BatchList,
  '/carvers': CarverList,
  '*': DraftList,
}

export default routes
