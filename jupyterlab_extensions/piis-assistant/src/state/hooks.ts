/**
 * React hooks for consuming FlowQuestStore state.
 *
 * Built on ``useSyncExternalStore`` for correct, tear-free reads with stable
 * subscribe/snapshot functions — no constant unsubscribe/resubscribe churn.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { FlowQuestStore, NotebookSlice, SyncStatus } from './store';
import type { QuestState } from '../types';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/**
 * Subscribe to the store's global QuestState. Re-renders only when the
 * global state reference actually changes.
 */
export function useGlobalState(store: FlowQuestStore): QuestState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribeGlobal(onStoreChange),
    [store]
  );
  const getSnapshot = useCallback(() => store.getGlobalState(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------------------
// Per-notebook state
// ---------------------------------------------------------------------------

/**
 * Subscribe to a specific notebook's slice. Returns a merged view where
 * the global state fields are overlaid onto the notebook's own state.
 *
 * Uses a cached merge so the same object reference is returned when
 * neither the global state nor the notebook slice has changed.
 */
export function useNotebookState(
  store: FlowQuestStore,
  notebookPath: string
): NotebookSlice {
  // Cache the last merged result so we return a stable reference when
  // neither input has changed.
  const cacheRef = useRef<{
    global: QuestState;
    slice: NotebookSlice;
    merged: NotebookSlice;
  } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // Listen to both global and notebook-level changes.
      const unsub1 = store.subscribeGlobal(onStoreChange);
      const unsub2 = store.subscribeNotebook(notebookPath, onStoreChange);
      return () => {
        unsub1();
        unsub2();
      };
    },
    [store, notebookPath]
  );

  const getSnapshot = useCallback((): NotebookSlice => {
    const global = store.getGlobalState();
    const slice = store.getNotebookSlice(notebookPath);

    const cache = cacheRef.current;
    if (cache && cache.global === global && cache.slice === slice) {
      return cache.merged;
    }

    // Merge global fields into the notebook slice's state so consumers
    // see a unified view with level, xpTotal, etc. alongside analysis.
    const merged: NotebookSlice =
      global !== slice.state
        ? { ...slice, state: { ...slice.state, ...global } }
        : slice;

    cacheRef.current = { global, slice, merged };
    return merged;
  }, [store, notebookPath]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

/**
 * Subscribe to the store's sync status (syncing / error / idle).
 */
export function useSyncStatus(store: FlowQuestStore): SyncStatus {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribeSyncStatus(onStoreChange),
    [store]
  );
  const getSnapshot = useCallback(() => store.getSyncStatus(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Subscribe to the store's endpoint status.
 */
export function useEndpointStatus(store: FlowQuestStore): import('../types').EndpointStatus {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribeEndpointStatus(onStoreChange),
    [store]
  );
  const getSnapshot = useCallback(() => store.getEndpointStatus(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
