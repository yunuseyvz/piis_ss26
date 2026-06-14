/**
 * React context for the FlowQuest store.
 *
 * Instead of prop-drilling the ``FlowQuestStore`` instance through every
 * component tree, Lumino wrappers mount their React sub-trees inside a
 * ``<StoreProvider>`` and any descendant can call ``useFlowQuestStore()``
 * to get the singleton.
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { FlowQuestStore } from './store';

const StoreCtx = createContext<FlowQuestStore | null>(null);

/**
 * Wrap a React sub-tree so every descendant can access the store via
 * ``useFlowQuestStore()``.
 */
export function StoreProvider({
  store,
  children
}: {
  store: FlowQuestStore;
  children: ReactNode;
}): JSX.Element {
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>;
}

/**
 * Retrieve the FlowQuestStore from the nearest ``<StoreProvider>``.
 *
 * Throws if called outside a provider — this is intentional so misuse
 * is caught during development rather than silently returning ``null``.
 */
export function useFlowQuestStore(): FlowQuestStore {
  const store = useContext(StoreCtx);
  if (!store) {
    throw new Error(
      'useFlowQuestStore() called outside of <StoreProvider>. ' +
        'Wrap your component tree in <StoreProvider store={...}>.'
    );
  }
  return store;
}
