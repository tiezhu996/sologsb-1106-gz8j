import DraftList from '../pages/DraftList.svelte'
import BlockBoard from '../pages/BlockBoard.svelte'
import NodeTimeline from '../pages/NodeTimeline.svelte'
import BatchList from '../pages/BatchList.svelte'
import CarverList from '../pages/CarverList.svelte'
import WoodLogBoard from '../pages/WoodLogBoard.svelte'
import CrackDesk from '../pages/CrackDesk.svelte'

export const routes = {
  '/drafts': DraftList,
  '/drafts/:id/blocks': BlockBoard,
  '/blocks/:id/nodes': NodeTimeline,
  '/batches': BatchList,
  '/carvers': CarverList,
  '/woodlogs': WoodLogBoard,
  '/cracks': CrackDesk,
  '/cracks/new': CrackDesk,
  '*': DraftList,
}

export default routes
