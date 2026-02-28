import { createStore, type StateCreator } from 'zustand/vanilla';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Only enable devtools in development
const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
import { enableMapSet } from 'immer';
import type { Task, TaskMetadata } from './types';
import { LogUtils } from '../utils/logUtils';
import { TIMING } from '../config/constants';
import { hasTaskChanged } from '../utils/taskUtils';
import type GoogleCalendarSyncPlugin from './main';
import { TFile } from 'obsidian';

/**
 * Simple cross-platform hash function for mobile compatibility
 * @param str The string to hash
 * @returns A simple hash string
 */
function simpleHash(str: string): string {
    let hash = 0;
    if (str.length === 0) return hash.toString(16);

    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }

    // Convert to hex string and ensure it's positive
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// Enable Map and Set support for Immer
enableMapSet();

// Module-level cache for isSyncAllowed to avoid triggering Zustand subscribers on every call
const _syncAllowedCacheExternal = { allowed: false, lastChecked: 0 };

export interface TaskStore {
    // Sync State
    syncEnabled: boolean;
    authenticated: boolean;
    status: 'connected' | 'disconnected' | 'syncing' | 'error' | 'refreshing_token';
    error: Error | null;
    tempSyncEnableCount: number;
    processingTasks: Set<string>;
    taskVersions: Map<string, number>;
    locks: Set<string>;
    lockTimeouts: Map<string, number>;
    lockTimestamps: Map<string, number>; // When locks were acquired (for diagnostics)
    lastSyncTime: number | null;
    syncInProgress: boolean;
    syncQueue: Set<string>;
    failedSyncs: Map<string, { error: Error; attempts: number }>;

    // Sync Configuration
    syncConfig: {
        batchSize: number;
        batchDelay: number;
        maxCacheSize: number;
        maxRetries: number;
        retryDelay: number;
        calendarRateLimit?: number; // Added for new rate limiting
        calendarRateWindow?: number; // Added for new rate limiting
    };

    // Rate Limiting
    rateLimit: {
        lastRequest: number;
        requestCount: number;
        resetTime: number;
        window: number;
        maxRequests: number;
        backoffMultiplier: number; // Add backoff multiplier support
    };

    // Sync Queue State
    syncTimeout: number | null;
    processingBatch: boolean;
    lastProcessTime: number;
    syncQueueCheckerId: number | null;
    syncQueueCheckerTimeout: number | null;

    // Sync Queue Actions
    enqueueTasks: (tasks: Task[]) => Promise<void>;
    processSyncQueue: () => Promise<void>;
    processSyncQueueNow: () => Promise<void>;
    clearSyncTimeout: () => void;
    clearSyncQueueCheckers: () => void;

    // Actions
    setState: (newState: Partial<TaskStore>) => void;
    setSyncEnabled: (enabled: boolean) => void;
    setAuthenticated: (authenticated: boolean) => void;
    setStatus: (status: TaskStore['status'], error?: Error) => void;
    addProcessingTask: (taskId: string) => void;
    removeProcessingTask: (taskId: string) => void;
    updateTaskVersion: (taskId: string, version: number) => void;
    clearStaleProcessingTasks: (timeout?: number) => void;
    reset: () => void;
    isTaskLocked: (taskId: string) => boolean;
    getLockTimestamp: (taskId: string) => number | undefined;
    isSyncEnabled: () => boolean;
    isSyncAllowed: () => boolean;
    tryLock: (lockKey: string) => boolean;
    startSync: () => void;
    endSync: (success: boolean) => void;
    addToSyncQueue: (taskId: string) => void;
    removeFromSyncQueue: (taskId: string) => void;
    recordSyncFailure: (taskId: string, error: Error) => void;
    clearSyncFailure: (taskId: string) => void;
    enableTempSync: () => void;
    disableTempSync: () => void;
    clearSyncQueue: () => void;

    // Sync Config Actions
    updateSyncConfig: (config: Partial<TaskStore['syncConfig']>) => void;

    // Rate Limit Actions
    updateRateLimit: (limit: Partial<TaskStore['rateLimit']>) => void;
    resetRateLimit: () => void;
    incrementRateLimit: () => void;

    // Lock Attempts
    lockAttempts: Map<string, number>;
    getLockAttempts: (key: string) => number;
    incrementLockAttempts: (key: string) => void;
    resetLockAttempts: (key: string) => void;

    // Task Cache
    taskCache: Map<string, {
        task: Task;
        metadata: TaskMetadata;
        lastChecked: number;
    }>;

    // Cache Configuration
    cacheConfig: {
        maxAge: number;  // Maximum age of cache entries in milliseconds
        cleanupInterval: number;  // Interval for cache cleanup in milliseconds
    };

    // Cache Actions
    cacheTask: (taskId: string, task: Task, metadata: TaskMetadata) => void;
    getCachedTask: (taskId: string) => { task: Task; metadata: TaskMetadata } | undefined;
    clearTaskCache: () => void;
    cleanupCache: () => void;

    // File Cache State
    fileCache: Map<string, {
        content: string;
        modifiedTime: number;
        hash: string;
    }>;

    // File Cache Actions
    getFileContent: (filePath: string) => Promise<string>;
    invalidateFileCache: (filePath: string) => void;
    updateFileCache: (filePath: string, content: string, modifiedTime: number) => void;
    clearFileCache: () => void;

    plugin: GoogleCalendarSyncPlugin;

    // Task Management
    getTaskData: (taskId: string) => Promise<Task | null>;
    getTaskMetadata: (taskId: string) => TaskMetadata | undefined;
    hasTaskChanged: (task: Task, metadata?: TaskMetadata) => boolean;
    syncTask: (task: Task) => Promise<void>;

    // Sync Queue State
    lastSyncAttempt: number;

    autoSyncCount: number;
    REPAIR_INTERVAL: number;

}

type TaskStoreState = Pick<TaskStore,
    | 'syncEnabled'
    | 'authenticated'
    | 'status'
    | 'error'
    | 'tempSyncEnableCount'
    | 'processingTasks'
    | 'taskVersions'
    | 'locks'
    | 'lockTimeouts'
    | 'lastSyncTime'
    | 'syncInProgress'
    | 'syncQueue'
    | 'failedSyncs'
>;

type StoreWithMiddlewares = StateCreator<
    TaskStore,
    [
        ['zustand/devtools', never],
        ['zustand/persist', TaskStoreState],
        ['zustand/immer', never]
    ],
    [],
    TaskStore
>;

type PersistState = {
    syncEnabled?: boolean;
    authenticated?: boolean;
    taskVersions?: [string, number][];
    lastSyncTime?: number;
};

type StorePersist = {
    name: string;
    version: number;
    partialize: (state: TaskStore) => PersistState;
    merge: (persistedState: PersistState, currentState: TaskStore) => TaskStore;
};

/**
 * Persist middleware configuration for zustand store.
 *
 * PERFORMANCE NOTE: The current implementation loads persisted state synchronously
 * from localStorage during store initialization. This adds ~50ms to startup time,
 * which is acceptable for this use case.
 *
 * FUTURE OPTIMIZATION: If startup performance becomes critical, consider implementing
 * lazy hydration using zustand's `onRehydrateStorage` callback to defer state
 * restoration until after the initial render. This would involve:
 * 1. Adding an `isHydrated` flag to track hydration status
 * 2. Using `onRehydrateStorage` to set the flag when complete
 * 3. Showing loading states in UI components while `isHydrated === false`
 *
 * Example:
 * ```typescript
 * persist(
 *   storeCreator,
 *   {
 *     ...persistConfig,
 *     onRehydrateStorage: () => (state) => {
 *       state?.setHydrated(true);
 *     }
 *   }
 * )
 * ```
 */
const persistConfig: StorePersist = {
    name: 'obsidian-gcal-sync-storage',
    version: 1,
    partialize: (state: TaskStore) => ({
        syncEnabled: state.syncEnabled,
        authenticated: state.authenticated,
        taskVersions: Array.from(state.taskVersions.entries()),
        lastSyncTime: state.lastSyncTime || undefined
        // NOTE: processingTasks, locks, lockTimeouts, lockTimestamps, syncQueue,
        // and failedSyncs are ephemeral runtime state and must NOT be persisted.
        // They are stale after a restart and cause tasks to appear permanently locked.
    }),
    merge: (persistedState, currentState) => ({
        ...currentState,
        syncEnabled: persistedState.syncEnabled ?? currentState.syncEnabled,
        authenticated: persistedState.authenticated ?? currentState.authenticated,
        taskVersions: new Map(persistedState.taskVersions || []),
        lastSyncTime: persistedState.lastSyncTime ?? currentState.lastSyncTime
    })
};

export const store = createStore<TaskStore>()(
    devtools(
        persist(
            immer((set, get) => ({
                // State
                syncEnabled: false,
                authenticated: false,
                status: 'disconnected' as const,
                error: null,
                tempSyncEnableCount: 0,
                processingTasks: new Set<string>(),
                taskVersions: new Map(),
                locks: new Set<string>(),
                lockTimeouts: new Map(),
                lockTimestamps: new Map<string, number>(),
                lastSyncTime: 0,
                syncInProgress: false,
                syncQueue: new Set<string>(),
                failedSyncs: new Map(),

                // Sync Configuration
                syncConfig: {
                    batchSize: 10,
                    batchDelay: 50,
                    maxCacheSize: 100,
                    maxRetries: 3,
                    retryDelay: 1000,
                },

                // Rate Limiting
                rateLimit: {
                    lastRequest: 0,
                    requestCount: 0,
                    resetTime: 0,
                    window: 100 * 1000, // 100 second window
                    maxRequests: 100, // max 100 requests per window
                    backoffMultiplier: 1.5, // Add backoff multiplier support
                },

                // Sync Queue State
                syncTimeout: null,
                processingBatch: false,
                lastProcessTime: 0,
                syncQueueCheckerId: null,
                syncQueueCheckerTimeout: null,

                // Sync Queue Actions
                enqueueTasks: async (tasks: Task[]) => {
                    const state = get();
                    if (!state.isSyncAllowed()) {
                        LogUtils.debug('Sync is disabled, skipping task enqueue');
                        return;
                    }

                    // Skip if no tasks provided
                    if (!tasks || tasks.length === 0) {
                        return;
                    }

                    // Add valid tasks to queue - with deduplication
                    const validTaskIds = [];
                    const newTasksAdded = [];

                    set(state => {
                        tasks.forEach(task => {
                            if (task && task.id) {
                                // Skip the redundant pre-check for changes - we trust the caller
                                // The caller has already determined this task needs to be synced
                                // This helps avoid race conditions where metadata was just updated

                                // But log the task state for debugging purposes
                                const existingMetadata = state.plugin.settings.taskMetadata?.[task.id];
                                if (state.plugin.settings.verboseLogging) {
                                    LogUtils.debug(`Enqueueing task ${task.id}:
                                        Task state: title=${task.title}, date=${task.date}, reminder=${task.reminder}
                                        Metadata: ${existingMetadata ?
                                            `title=${existingMetadata.title}, date=${existingMetadata.date}, reminder=${existingMetadata.reminder}` :
                                            'none'}`);
                                }

                                // Check for specific conditions that would cause us to skip enqueueing
                                const metadata = state.plugin.settings.taskMetadata?.[task.id];

                                // Skip if the task was just synced
                                if (metadata?.justSynced && metadata.syncTimestamp) {
                                    const syncAge = Date.now() - metadata.syncTimestamp;
                                    if (syncAge < TIMING.JUST_SYNCED_WINDOW_MS) {
                                        LogUtils.debug(`Task ${task.id} was just synced ${syncAge}ms ago, skipping redundant enqueue`);
                                        return;
                                    }
                                }

                                // Check if task is already being processed
                                if (state.processingTasks.has(task.id)) {
                                    // Instead of skipping, add to sync queue for later processing
                                    // This ensures the task will be processed after current operation completes
                                    LogUtils.debug(`Task ${task.id} is already being processed, adding to sync queue for later processing`);
                                    state.syncQueue.add(task.id);
                                    validTaskIds.push(task.id);
                                    newTasksAdded.push(task.id);
                                    return;
                                }

                                // Check if already in queue first (for logging)
                                const alreadyInQueue = state.syncQueue.has(task.id);

                                // Always add to queue - we'll deduplicate later when processing
                                // This ensures changes made during processing aren't missed
                                LogUtils.debug(`Enqueueing task ${task.id} with title='${task.title}', reminder=${task.reminder}`);
                                state.syncQueue.add(task.id);
                                validTaskIds.push(task.id);

                                // Only count as newly added if it wasn't in the queue before
                                if (!alreadyInQueue) {
                                    newTasksAdded.push(task.id);
                                } else {
                                    LogUtils.debug(`Task ${task.id} was already in queue, will be re-processed with latest changes`);
                                }
                            }
                        });
                    });

                    // Log task count - only if we actually added new tasks
                    if (newTasksAdded.length > 0) {
                        LogUtils.debug(`Added ${newTasksAdded.length} new tasks to sync queue (total: ${validTaskIds.length})`);
                    } else if (validTaskIds.length > 0) {
                        LogUtils.debug(`No new tasks added, ${validTaskIds.length} already in queue`);
                        return; // No new tasks to process, exit early
                    } else {
                        return; // No valid tasks to process
                    }

                    // Clear any existing timeout
                    const currentState = get();
                    if (currentState.syncTimeout) {
                        clearTimeout(currentState.syncTimeout);
                    }

                    // Calculate delay with improved debouncing
                    const now = Date.now();
                    const timeSinceLastProcess = now - currentState.lastProcessTime;
                    const queueSize = currentState.syncQueue.size;
                    const baseDelay = currentState.syncConfig.batchDelay;

                    // Lightweight debounce: small penalty if recently processed or sync in progress
                    // to allow batching of rapid edits, but not so large as to feel sluggish
                    const recentProcessDelay = timeSinceLastProcess < 500 ? 100 : 0;
                    const syncInProgressDelay = currentState.syncInProgress ? 200 : 0;

                    const delay = Math.min(
                        baseDelay +
                        Math.floor(baseDelay * Math.log(queueSize || 1) * 0.3) +
                        recentProcessDelay +
                        syncInProgressDelay,
                        500 // Low maximum delay cap for snappy sync
                    );

                    // Set new timeout for processing
                    set(state => {
                        state.syncTimeout = window.setTimeout(async () => {
                            const latestState = get();
                            set(state => { state.lastProcessTime = Date.now(); });

                            if (!latestState.syncInProgress) {
                                LogUtils.debug(`Processing sync queue with ${latestState.syncQueue.size} tasks`);
                                try {
                                    await latestState.processSyncQueue();
                                } catch (error) {
                                    // Clear timeout reference on error to prevent memory leaks
                                    set(state => { state.syncTimeout = null; });
                                    LogUtils.error('Process sync queue failed:', error);
                                }
                            } else {
                                LogUtils.debug('Sync already in progress, tasks will be processed when current sync completes');

                                // Set a checker to process the queue once current sync finishes
                                // Use a single interval ID stored in state to prevent multiple intervals
                                if (latestState.syncQueueCheckerId) {
                                    clearInterval(latestState.syncQueueCheckerId);
                                }

                                const intervalId = window.setInterval(() => {
                                    try {
                                        const currentState = get();
                                        if (!currentState.syncInProgress && currentState.syncQueue.size > 0) {
                                            LogUtils.debug('Previous sync completed, processing pending tasks in queue');
                                            currentState.processSyncQueue();
                                            clearInterval(intervalId);
                                            set(state => { state.syncQueueCheckerId = null; });
                                        } else if (currentState.syncQueue.size === 0) {
                                            // No tasks left in queue, clear interval
                                            clearInterval(intervalId);
                                            set(state => { state.syncQueueCheckerId = null; });
                                        }
                                    } catch (error) {
                                        // Clear interval on error to prevent memory leaks
                                        clearInterval(intervalId);
                                        set(state => { state.syncQueueCheckerId = null; });
                                        LogUtils.error('Sync queue check failed:', error);
                                    }
                                }, TIMING.SYNC_QUEUE_CHECK_INTERVAL_MS);

                                set(state => {
                                    state.syncQueueCheckerId = intervalId as unknown as number;

                                    // Safety cleanup after timeout to avoid lingering intervals
                                    state.syncQueueCheckerTimeout = window.setTimeout(() => {
                                        if (state.syncQueueCheckerId) {
                                            clearInterval(state.syncQueueCheckerId);
                                            state.syncQueueCheckerId = null;
                                        }
                                    }, TIMING.SYNC_QUEUE_SAFETY_TIMEOUT_MS) as unknown as number;
                                });
                            }
                        }, delay) as unknown as number;
                    });
                },

                processSyncQueue: async () => {
                    const state = get();

                    // Ensure plugin is initialized
                    if (!state.plugin) {
                        LogUtils.error('Plugin not initialized, skipping auto sync');
                        return;
                    }

                    // 1. Better state validation and cleanup
                    if (state.syncInProgress) {
                        // Check if sync is actually stuck (5 minutes timeout)
                        if (Date.now() - state.lastSyncAttempt > 5 * 60 * 1000) {
                            LogUtils.debug('🔄 Previous sync appears stuck, resetting state');
                            set(state => {
                                state.syncInProgress = false;
                                state.processingBatch = false;
                                state.status = 'connected';
                            });
                        } else {
                            LogUtils.debug('🔄 Skipping sync: already in progress');
                            return;
                        }
                    }

                    if (state.syncQueue.size === 0) {
                        LogUtils.debug('🔄 Skipping sync: no tasks in queue');
                        return;
                    }

                    if (state.processingBatch) {
                        LogUtils.debug('🔄 Batch already in progress, will process remaining tasks after completion');
                        return;
                    }

                    if (!state.isSyncAllowed()) {
                        LogUtils.debug('🔄 Sync not allowed, skipping');
                        return;
                    }

                    // Check if we need to run repair
                    const needsRepair = (state.autoSyncCount + 1) % state.REPAIR_INTERVAL === 0;

                    try {
                        // 2. Start sync with proper state tracking
                        set(state => {
                            state.processingBatch = true;
                            state.syncInProgress = true;
                            state.status = 'syncing';
                            state.lastSyncAttempt = Date.now();
                            state.autoSyncCount++; // Increment counter
                        });

                        // Clear task cache to ensure we get fresh data
                        state.clearTaskCache();

                        // Clean up any stale locks that might prevent task processing
                        state.clearStaleProcessingTasks(TIMING.LOCK_TIMEOUT_MS);

                        LogUtils.debug('🔄 Starting auto sync process');

                        // Run repair if needed
                        if (needsRepair && state.plugin.repairManager) {
                            LogUtils.debug('Running periodic repair during auto sync');
                            await state.plugin.repairManager.repairSyncState((progress) => {
                                // Only log at significant milestones
                                if (progress.processedItems % 10 === 0 || progress.processedItems === progress.totalItems) {
                                    LogUtils.debug(`Repair progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`);
                                }
                            });
                        }

                        // Get fresh task data for all queued tasks - WITH OPTIMIZATION
                        const taskData = new Map();
                        const taskIds = Array.from(state.syncQueue);
                        const filesToProcess = new Set<string>();

                        // First, gather all files that contain tasks we need to process
                        // This optimizes the file reading process to minimize redundancy
                        for (const taskId of taskIds) {
                            const metadata = state.plugin.settings.taskMetadata[taskId];
                            if (metadata?.filePath) {
                                filesToProcess.add(metadata.filePath);
                            }
                        }

                        // Process each file once to get all tasks
                        for (const filePath of filesToProcess) {
                            try {
                                const file = state.plugin.app.vault.getAbstractFileByPath(filePath);
                                if (file instanceof TFile) {
                                    const tasks = await state.plugin.taskParser.parseTasksFromFile(file);
                                    for (const task of tasks) {
                                        if (task.id && state.syncQueue.has(task.id)) {
                                            taskData.set(task.id, task);
                                        }
                                    }
                                }
                            } catch (error) {
                                LogUtils.error(`Failed to process file ${filePath}:`, error);
                            }
                        }

                        // For any tasks not found in files, try to get them by ID
                        for (const taskId of taskIds) {
                            if (!taskData.has(taskId)) {
                                try {
                                    const task = await state.plugin.taskParser.getTaskById(taskId);
                                    if (task) {
                                        taskData.set(taskId, task);
                                    } else {
                                        LogUtils.warn(`Task ${taskId} not found in any file, will be removed from queue`);
                                    }
                                } catch (error) {
                                    LogUtils.error(`Failed to get task ${taskId}:`, error);
                                }
                            }
                        }

                        // Process tasks in batches
                        const batchSize = state.syncConfig.batchSize;
                        const tasks = Array.from(taskData.values());
                        const totalTasks = tasks.length;

                        LogUtils.debug(`Found ${totalTasks} tasks to sync`);

                        // Filter out tasks that were just synced to avoid redundant processing
                        const filteredTasks = tasks.filter(task => {
                            if (!task.id) return false;

                            // Check if task was just synced
                            const metadata = state.plugin.settings.taskMetadata[task.id];
                            if (metadata?.justSynced && metadata.syncTimestamp) {
                                const syncAge = Date.now() - metadata.syncTimestamp;
                                if (syncAge < TIMING.JUST_SYNCED_WINDOW_MS) {
                                    LogUtils.debug(`Skipping task ${task.id} that was just synced ${syncAge}ms ago`);
                                    // Also remove from queue since we're skipping it
                                    state.removeFromSyncQueue(task.id);
                                    return false;
                                }
                            }
                            return true;
                        });

                        // Process filtered tasks in batches
                        const actualTaskCount = filteredTasks.length;
                        LogUtils.debug(`After filtering, processing ${actualTaskCount}/${totalTasks} tasks`);

                        for (let i = 0; i < filteredTasks.length; i += batchSize) {
                            const batch = filteredTasks.slice(i, i + batchSize);

                            // Process each task in the batch
                            const results = await Promise.allSettled(
                                batch.map(task => state.syncTask(task))
                            );

                            // Log results
                            const succeeded = results.filter(r => r.status === 'fulfilled').length;
                            const failed = results.filter(r => r.status === 'rejected').length;

                            LogUtils.debug(`Batch progress: ${i + batch.length}/${actualTaskCount} (${succeeded} succeeded, ${failed} failed)`);

                            // Remove processed tasks from queue
                            for (const task of batch) {
                                if (task.id) {
                                    state.removeFromSyncQueue(task.id);
                                }
                            }

                            // Add delay between batches if configured
                            if (i + batchSize < tasks.length && state.syncConfig.batchDelay > 0) {
                                await new Promise(resolve => setTimeout(resolve, state.syncConfig.batchDelay));
                            }
                        }

                        // Clean up any tasks that weren't found
                        for (const taskId of taskIds) {
                            if (!taskData.has(taskId)) {
                                state.removeFromSyncQueue(taskId);
                            }
                        }

                        LogUtils.debug('✅ Full sync completed');
                    } catch (error) {
                        LogUtils.error('Failed to process sync queue:', error);
                    } finally {
                        set(state => {
                            state.processingBatch = false;
                            state.syncInProgress = false;
                            state.status = 'connected';
                            state.lastSyncTime = Date.now();
                        });
                    }
                },

                processSyncQueueNow: async () => {
                    const state = get();

                    // Clear any pending sync timeouts
                    state.clearSyncTimeout();

                    // Clear any sync queue checkers
                    state.clearSyncQueueCheckers();

                    // Process the queue immediately
                    await state.processSyncQueue();

                    // Log completion
                    LogUtils.debug('🔄 Manual sync completed');
                },

                clearSyncTimeout: () => {
                    const state = get();
                    if (state.syncTimeout) {
                        LogUtils.debug('🔄 Clearing sync timeout');
                        clearTimeout(state.syncTimeout);
                        set(state => {
                            state.syncTimeout = null;
                        });
                    }
                },

                clearSyncQueueCheckers: () => {
                    const state = get();

                    // Clear interval checker
                    if (state.syncQueueCheckerId) {
                        LogUtils.debug('🔄 Clearing sync queue checker interval');
                        clearInterval(state.syncQueueCheckerId);

                        set(state => {
                            state.syncQueueCheckerId = null;
                        });
                    }

                    // Clear timeout for the checker
                    if (state.syncQueueCheckerTimeout) {
                        clearTimeout(state.syncQueueCheckerTimeout);

                        set(state => {
                            state.syncQueueCheckerTimeout = null;
                        });
                    }
                },

                // Actions
                setState: (newState: Partial<TaskStore>) =>
                    set(state => {
                        Object.assign(state, newState);
                    }),

                setSyncEnabled: (enabled: boolean) =>
                    set(state => {
                        LogUtils.debug(`🔄 Setting sync enabled: ${enabled}`);
                        state.syncEnabled = enabled;
                        if (!enabled) {
                            state.syncQueue.clear();
                            state.failedSyncs.clear();
                        }
                    }),

                setAuthenticated: (authenticated: boolean) =>
                    set(state => {
                        LogUtils.debug(`🔄 Setting authenticated: ${authenticated}`);
                        state.authenticated = authenticated;
                    }),

                setStatus: (status: TaskStore['status'], error?: Error) =>
                    set(state => {
                        LogUtils.debug(`🔄 Setting status: ${status}${error ? ` (${error.message})` : ''}`);
                        state.status = status;
                        state.error = error || null;
                    }),

                addProcessingTask: (taskId: string) =>
                    set(state => {
                        if (!state.processingTasks.has(taskId)) {
                            state.processingTasks.add(taskId);
                            // Store both an expiration time and the lock acquisition time
                            const now = Date.now();
                            state.lockTimeouts.set(taskId, now + TIMING.LOCK_TIMEOUT_MS);
                            state.lockTimestamps.set(taskId, now);
                            LogUtils.debug(`Added processing task ${taskId} at ${new Date(now).toISOString()}`);
                        }
                    }),

                removeProcessingTask: (taskId: string) =>
                    set(state => {
                        // Capture lock duration before deleting the timestamp
                        const startTime = state.lockTimestamps.get(taskId);
                        const duration = startTime ? Date.now() - startTime : undefined;

                        state.processingTasks.delete(taskId);
                        state.locks.delete(taskId);
                        state.lockTimeouts.delete(taskId);
                        state.lockTimestamps.delete(taskId);

                        if (duration !== undefined) {
                            LogUtils.debug(`Removed processing task ${taskId} (lock held for ${duration}ms)`);
                        } else {
                            LogUtils.debug(`Removed processing task ${taskId}`);
                        }
                    }),

                updateTaskVersion: (taskId: string, version: number) =>
                    set(state => {
                        const currentVersion = state.taskVersions.get(taskId) || 0;
                        if (version > currentVersion) {
                            state.taskVersions.set(taskId, version);
                            LogUtils.debug(`Updated version for task ${taskId}: ${version}`);
                        } else {
                            LogUtils.debug(`Skipped version update for task ${taskId}: current ${currentVersion}, new ${version}`);
                        }
                    }),

                clearStaleProcessingTasks: (timeout: number = 30000) =>
                    set(state => {
                        const now = Date.now();
                        let staleLocksCleared = 0;

                        // Collect all locks to check in an array first to avoid mutation during iteration
                        const locksToCheck = Array.from(state.lockTimeouts.entries());

                        // First pass: identify stale locks
                        const staleKeys = locksToCheck
                            .filter(([_, timeoutValue]) => now > timeoutValue)
                            .map(([key]) => key);

                        // Log stale lock information with acquisition time if available
                        for (const lockKey of staleKeys) {
                            const lockTime = state.lockTimestamps?.get(lockKey);
                            const lockDuration = lockTime ? (now - lockTime) : 'unknown';

                            LogUtils.warn(`Clearing stale lock for ${lockKey} (held for ${lockDuration}ms)`);

                            // Remove from all lock-related collections
                            state.processingTasks.delete(lockKey);
                            state.locks.delete(lockKey);
                            state.lockTimeouts.delete(lockKey);
                            if (state.lockTimestamps) {
                                state.lockTimestamps.delete(lockKey);
                            }

                            staleLocksCleared++;
                        }

                        if (staleLocksCleared > 0) {
                            LogUtils.debug(`Cleared ${staleLocksCleared} stale locks`);
                        }
                    }),

                reset: () => {
                    const currentState = get();

                    // Clear any pending timers to prevent memory leaks
                    if (currentState.syncTimeout) {
                        clearTimeout(currentState.syncTimeout);
                    }
                    if (currentState.syncQueueCheckerId) {
                        clearInterval(currentState.syncQueueCheckerId);
                    }
                    if (currentState.syncQueueCheckerTimeout) {
                        clearTimeout(currentState.syncQueueCheckerTimeout);
                    }

                    set(state => {
                        for (const [lockKey] of state.lockTimeouts) {
                            state.processingTasks.delete(lockKey);
                            state.locks.delete(lockKey);
                        }
                        state.lockTimeouts.clear();
                        state.lockAttempts.clear();

                        // Clear lock timestamps if they exist
                        if (state.lockTimestamps) {
                            state.lockTimestamps.clear();
                        }

                        // Clear timer references
                        state.syncTimeout = null;
                        state.syncQueueCheckerId = null;
                        state.syncQueueCheckerTimeout = null;

                        state.syncEnabled = false;
                        state.authenticated = false;
                        state.status = 'disconnected';
                        state.error = null;
                        state.tempSyncEnableCount = 0;
                        state.processingTasks.clear();
                        state.taskVersions.clear();
                        state.locks.clear();
                        state.syncQueue.clear();
                        state.failedSyncs.clear();
                        state.lastSyncTime = null;
                        state.syncInProgress = false;
                    });
                },

                isTaskLocked: (taskId: string) => {
                    const state = get();
                    return state.locks.has(taskId) || state.processingTasks.has(taskId);
                },

                getLockTimestamp: (taskId: string) => {
                    const state = get();
                    return state.lockTimestamps.get(taskId);
                },

                isSyncEnabled: () => {
                    return get().syncEnabled;
                },

                isSyncAllowed: () => {
                    const state = get();
                    const now = Date.now();

                    // Use module-level cache to avoid triggering store subscribers
                    if (now - _syncAllowedCacheExternal.lastChecked < 200) {
                        return _syncAllowedCacheExternal.allowed;
                    }

                    const allowed = state.syncEnabled || state.tempSyncEnableCount > 0;

                    if (allowed !== _syncAllowedCacheExternal.allowed) {
                        LogUtils.debug(`🔄 Sync allowed status changed: ${allowed} (enabled: ${state.syncEnabled}, temp count: ${state.tempSyncEnableCount})`);
                    }

                    _syncAllowedCacheExternal.allowed = allowed;
                    _syncAllowedCacheExternal.lastChecked = now;

                    return allowed;
                },

                tryLock: (lockKey: string) => {
                    const state = get();
                    if (state.locks.has(lockKey)) {
                        const timeout = state.lockTimeouts.get(lockKey);
                        if (timeout && Date.now() > timeout) {
                            set(state => {
                                state.locks.delete(lockKey);
                                state.processingTasks.delete(lockKey);
                                state.lockTimeouts.delete(lockKey);
                                LogUtils.debug(`Force released expired lock for ${lockKey}`);
                            });
                        } else {
                            LogUtils.debug(`Lock acquisition failed for ${lockKey}: already locked`);
                            return false;
                        }
                    }

                    set(state => {
                        state.locks.add(lockKey);
                        state.processingTasks.add(lockKey);
                        state.lockTimeouts.set(lockKey, Date.now() + TIMING.LOCK_TIMEOUT_MS);
                        LogUtils.debug(`Acquired lock for ${lockKey}`);
                    });
                    return true;
                },

                startSync: () =>
                    set(state => {
                        if (state.syncInProgress) {
                            LogUtils.debug('Sync already in progress, skipping');
                            return;
                        }
                        state.syncInProgress = true;
                        state.status = 'syncing';
                    }),

                endSync: (success: boolean) =>
                    set(state => {
                        state.syncInProgress = false;
                        state.lastSyncTime = Date.now();
                        state.status = success ? 'connected' : 'error';
                        if (success) {
                            state.error = null;
                        }
                    }),

                addToSyncQueue: (taskId: string) =>
                    set(state => {
                        state.syncQueue.add(taskId);
                    }),

                removeFromSyncQueue: (taskId: string) =>
                    set(state => {
                        state.syncQueue.delete(taskId);
                    }),

                recordSyncFailure: (taskId: string, error: Error) =>
                    set(state => {
                        const existing = state.failedSyncs.get(taskId);
                        state.failedSyncs.set(taskId, {
                            error,
                            attempts: (existing?.attempts || 0) + 1
                        });
                    }),

                clearSyncFailure: (taskId: string) =>
                    set(state => {
                        state.failedSyncs.delete(taskId);
                    }),

                enableTempSync: () =>
                    set(state => {
                        state.tempSyncEnableCount++;
                        LogUtils.debug(`🔄 Enabled temporary sync (count: ${state.tempSyncEnableCount})`);
                    }),

                disableTempSync: () =>
                    set(state => {
                        if (state.tempSyncEnableCount > 0) {
                            state.tempSyncEnableCount--;
                            LogUtils.debug(`🔄 Disabled temporary sync (count: ${state.tempSyncEnableCount})`);
                        }
                    }),

                clearSyncQueue: () =>
                    set(state => {
                        state.syncQueue = new Set();
                    }),

                updateSyncConfig: (config: Partial<TaskStore['syncConfig']>) =>
                    set(state => {
                        Object.assign(state.syncConfig, config);
                    }),

                updateRateLimit: (limit: Partial<TaskStore['rateLimit']>) =>
                    set(state => {
                        Object.assign(state.rateLimit, limit);
                    }),

                resetRateLimit: () =>
                    set(state => {
                        const now = Date.now();
                        state.rateLimit = {
                            ...state.rateLimit,
                            lastRequest: now,
                            requestCount: 0,
                            resetTime: now + state.rateLimit.window,
                            window: state.rateLimit.window,
                            maxRequests: state.rateLimit.maxRequests,
                            backoffMultiplier: state.rateLimit.backoffMultiplier || 1.0
                        };
                    }),

                incrementRateLimit: () =>
                    set(state => {
                        state.rateLimit.requestCount++;
                        state.rateLimit.lastRequest = Date.now();
                    }),

                // Lock Attempts
                lockAttempts: new Map(),

                getLockAttempts: (key: string) => get().lockAttempts.get(key) || 0,

                incrementLockAttempts: (key: string) =>
                    set(state => {
                        state.lockAttempts = new Map(state.lockAttempts).set(key, (state.lockAttempts.get(key) || 0) + 1);
                    }),

                resetLockAttempts: (key: string) =>
                    set(state => {
                        const newAttempts = new Map(state.lockAttempts);
                        newAttempts.delete(key);
                        state.lockAttempts = newAttempts;
                    }),

                // Initialize new cache state
                taskCache: new Map(),
                cacheConfig: {
                    maxAge: 500,  // 500ms - very short-lived cache
                    cleanupInterval: 30000  // 30 seconds
                },

                // Cache Actions
                cacheTask: (taskId: string, task: Task, metadata: TaskMetadata) =>
                    set(state => {
                        // Only cache if we have complete information
                        if (!task || !metadata || !task.id) {
                            return;
                        }

                        try {
                            state.taskCache.set(taskId, {
                                task: { ...task },
                                metadata: { ...metadata },
                                lastChecked: Date.now()
                            });

                            // Ensure cache doesn't grow too large
                            if (state.taskCache.size > state.syncConfig.maxCacheSize) {
                                // Remove oldest entries
                                const entries = Array.from(state.taskCache.entries());
                                entries.sort((a, b) => a[1].lastChecked - b[1].lastChecked);

                                // Remove oldest 20% of entries
                                const toRemove = Math.max(1, Math.floor(entries.length * 0.2));
                                for (let i = 0; i < toRemove; i++) {
                                    state.taskCache.delete(entries[i][0]);
                                }
                            }
                        } catch (error) {
                            // If caching fails, just log and continue (non-critical)
                            LogUtils.debug(`Failed to cache task ${taskId}: ${error.message}`);
                        }
                    }),

                getCachedTask: (taskId: string) => {
                    try {
                        const state = get();
                        const cached = state.taskCache.get(taskId);
                        const maxAge = state.cacheConfig.maxAge;

                        if (cached && Date.now() - cached.lastChecked < maxAge) {
                            return {
                                task: { ...cached.task },
                                metadata: { ...cached.metadata }
                            };
                        }
                    } catch (error) {
                        // If cache retrieval fails, just return undefined
                        LogUtils.debug(`Failed to get cached task ${taskId}: ${error.message}`);
                    }
                    return undefined;
                },

                clearTaskCache: () =>
                    set(state => {
                        state.taskCache.clear();
                    }),

                cleanupCache: () =>
                    set(state => {
                        const now = Date.now();
                        for (const [id, entry] of state.taskCache.entries()) {
                            if (now - entry.lastChecked > state.cacheConfig.maxAge) {
                                state.taskCache.delete(id);
                            }
                        }
                    }),

                // File Cache State
                fileCache: new Map(),

                // File Cache Actions
                getFileContent: async (filePath: string) => {
                    try {
                        const state = get();
                        const file = state.plugin.app.vault.getAbstractFileByPath(filePath);

                        if (!(file instanceof TFile)) {
                            throw new Error(`File not found or not a file: ${filePath}`);
                        }

                        const stats = file.stat;
                        const cached = state.fileCache.get(filePath);
                        if (cached && cached.modifiedTime === stats.mtime) {
                            return cached.content;
                        }

                        // Read content directly using Obsidian API
                        const content = await state.plugin.app.vault.read(file);

                        // Generate hash using our simple function
                        const contentHash = simpleHash(content);

                        // Update cache with content and hash
                        set(state => {
                            state.fileCache.set(filePath, {
                                content,
                                modifiedTime: stats.mtime,
                                hash: contentHash
                            });
                        });

                        return content;
                    } catch (error) {
                        LogUtils.error(`Failed to read file ${filePath}:`, error);
                        throw error;
                    }
                },

                invalidateFileCache: (filePath: string) => set(state => {
                    state.fileCache.delete(filePath);

                    // Also invalidate any cached tasks from this file
                    // Iterate task cache and remove entries with matching filePath
                    for (const [taskId, cached] of state.taskCache.entries()) {
                        if (cached.task?.filePath === filePath) {
                            state.taskCache.delete(taskId);
                        }
                    }
                }),

                updateFileCache: (filePath: string, content: string, modifiedTime: number) => {
                    try {
                        // Generate hash using our simple function
                        const contentHash = simpleHash(content);

                        // Update cache
                        set(state => {
                            state.fileCache.set(filePath, {
                                content,
                                modifiedTime,
                                hash: contentHash
                            });
                        });
                    } catch (error) {
                        LogUtils.error(`Failed to update file cache for ${filePath}:`, error);
                    }
                },

                clearFileCache: () => set(state => {
                    state.fileCache.clear();
                }),

                plugin: null as unknown as GoogleCalendarSyncPlugin,

                // Task Management
                getTaskData: async (taskId: string) => {
                    const state = get();
                    const cached = state.taskCache.get(taskId);
                    if (cached) {
                        return cached.task;
                    }
                    return null;
                },

                getTaskMetadata: (taskId: string) => {
                    const state = get();
                    const cached = state.taskCache.get(taskId);
                    if (cached) {
                        return cached.metadata;
                    }
                    return undefined;
                },

                hasTaskChanged: (task: Task, metadata?: TaskMetadata) => {
                    const state = get();

                    // If no metadata provided, try to get the latest directly from settings
                    if (!metadata && task.id && state.plugin.settings.taskMetadata) {
                        metadata = state.plugin.settings.taskMetadata[task.id];
                    }

                    // Use the standardized implementation from taskUtils
                    const result = hasTaskChanged(task, metadata, task.id);
                    return result.changed;
                },

                syncTask: async (task: Task) => {
                    const state = get();
                    if (!task?.id) {
                        LogUtils.warn('Cannot sync task without ID');
                        return;
                    }

                    if (!state.isSyncAllowed()) {
                        LogUtils.debug(`Sync is disabled, skipping task sync for ${task.id}`);
                        return;
                    }

                    try {
                        // Check if task is locked
                        if (state.isTaskLocked(task.id)) {
                            LogUtils.debug(`Task ${task.id} is already being processed, queueing for later sync`);
                            state.addToSyncQueue(task.id);
                            return;
                        }

                        // Lock the task and process it
                        state.addProcessingTask(task.id);

                        // Trust the task data provided by the caller — processSyncQueue already
                        // parsed fresh data from files, and editor handlers parse at the cursor line.
                        // Re-fetching here added 200ms+ of latency per task with no practical benefit
                        // since the debounce window already coalesces rapid edits.
                        LogUtils.debug(`Syncing task ${task.id} with title='${task.title}', date=${task.date}, reminder=${task.reminder}`);

                        // Sync the task with calendar
                        await state.plugin.calendarSync?.syncTask(task);

                        // Update task version
                        state.updateTaskVersion(task.id, Date.now());

                        // Cache the current state - with updated task data
                        const updatedMetadata = state.plugin.settings.taskMetadata[task.id];
                        if (updatedMetadata) {
                            state.cacheTask(task.id, task, updatedMetadata);
                        }
                    } catch (error) {
                        LogUtils.error(`Failed to sync task ${task.id}:`, error);
                        state.recordSyncFailure(task.id, error instanceof Error ? error : new Error(String(error)));
                        throw error;
                    } finally {
                        state.removeProcessingTask(task.id);
                    }
                },

                // Sync Queue State
                lastSyncAttempt: 0,

                autoSyncCount: 0,
                REPAIR_INTERVAL: 10, // Run repair every 10 auto syncs
            })), persistConfig
        ),
        { enabled: IS_DEV }
    )
);

// Export a simplified API for consumers using slices pattern
interface TaskStoreApi {
    setSyncEnabled: (enabled: boolean) => void;
    setAuthenticated: (authenticated: boolean) => void;
    setStatus: (status: TaskStore['status'], error?: Error) => void;
    addProcessingTask: (taskId: string) => void;
    removeProcessingTask: (taskId: string) => void;
    updateTaskVersion: (taskId: string, version: number) => void;
    clearStaleProcessingTasks: (timeout?: number) => void;
    reset: () => void;
    isTaskLocked: (taskId: string) => boolean;
    getLockTimestamp: (taskId: string) => number | undefined;
    isSyncEnabled: () => boolean;
    isSyncAllowed: () => boolean;
    tryLock: (lockKey: string) => boolean;
    startSync: () => void;
    endSync: (success: boolean) => void;
    addToSyncQueue: (taskId: string) => void;
    removeFromSyncQueue: (taskId: string) => void;
    recordSyncFailure: (taskId: string, error: Error) => void;
    clearSyncFailure: (taskId: string) => void;
    enableTempSync: () => void;
    disableTempSync: () => void;
    enqueueTasks: (tasks: Task[]) => Promise<void>;
    processSyncQueue: () => Promise<void>;
    processSyncQueueNow: () => Promise<void>;
    clearSyncTimeout: () => void;
    clearSyncQueueCheckers: () => void;
    clearSyncQueue: () => void;
    updateSyncConfig: (config: Partial<TaskStore['syncConfig']>) => void;
    updateRateLimit: (limit: Partial<TaskStore['rateLimit']>) => void;
    resetRateLimit: () => void;
    incrementRateLimit: () => void;
}

export const useStore = {
    getState: store.getState,
    setState: store.setState,
    subscribe: store.subscribe,
    api: {
        setSyncEnabled: (enabled: boolean) => store.getState().setSyncEnabled(enabled),
        setAuthenticated: (authenticated: boolean) => store.getState().setAuthenticated(authenticated),
        setStatus: (status: TaskStore['status'], error?: Error) => store.getState().setStatus(status, error),
        addProcessingTask: (taskId: string) => store.getState().addProcessingTask(taskId),
        removeProcessingTask: (taskId: string) => store.getState().removeProcessingTask(taskId),
        updateTaskVersion: (taskId: string, version: number) => store.getState().updateTaskVersion(taskId, version),
        clearStaleProcessingTasks: (timeout?: number) => store.getState().clearStaleProcessingTasks(timeout),
        reset: () => store.getState().reset(),
        isTaskLocked: (taskId: string) => store.getState().isTaskLocked(taskId),
        getLockTimestamp: (taskId: string) => store.getState().getLockTimestamp(taskId),
        isSyncEnabled: () => store.getState().isSyncEnabled(),
        isSyncAllowed: () => store.getState().isSyncAllowed(),
        tryLock: (lockKey: string) => store.getState().tryLock(lockKey),
        startSync: () => store.getState().startSync(),
        endSync: (success: boolean) => store.getState().endSync(success),
        addToSyncQueue: (taskId: string) => store.getState().addToSyncQueue(taskId),
        removeFromSyncQueue: (taskId: string) => store.getState().removeFromSyncQueue(taskId),
        recordSyncFailure: (taskId: string, error: Error) => store.getState().recordSyncFailure(taskId, error),
        clearSyncFailure: (taskId: string) => store.getState().clearSyncFailure(taskId),
        enableTempSync: () => store.getState().enableTempSync(),
        disableTempSync: () => store.getState().disableTempSync(),
        enqueueTasks: (tasks: Task[]) => store.getState().enqueueTasks(tasks),
        processSyncQueue: () => store.getState().processSyncQueue(),
        processSyncQueueNow: () => store.getState().processSyncQueueNow(),
        clearSyncTimeout: () => store.getState().clearSyncTimeout(),
        clearSyncQueueCheckers: () => store.getState().clearSyncQueueCheckers(),
        clearSyncQueue: () => store.getState().clearSyncQueue(),
        updateSyncConfig: (config: Partial<TaskStore['syncConfig']>) => store.getState().updateSyncConfig(config),
        updateRateLimit: (limit: Partial<TaskStore['rateLimit']>) => store.getState().updateRateLimit(limit),
        resetRateLimit: () => store.getState().resetRateLimit(),
        incrementRateLimit: () => store.getState().incrementRateLimit()
    }
} satisfies {
    getState: () => TaskStore;
    setState: (state: Partial<TaskStore>) => void;
    subscribe: (listener: (state: TaskStore, prevState: TaskStore) => void) => () => void;
    api: TaskStoreApi;
};

export const initializeStore = (pluginInstance: GoogleCalendarSyncPlugin) => {
    store.setState(state => {
        // Cast to any to bypass the immutability check since we know this is initialization
        (state as any).plugin = pluginInstance;
    });
};