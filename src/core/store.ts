import { createStore, type StoreApi, type StateCreator } from 'zustand/vanilla';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type { Draft } from 'immer';
import type { Task, TaskMetadata } from './types';
import { LogUtils } from '../utils/logUtils';
import type GoogleCalendarSyncPlugin from './main';
import { TFile, TAbstractFile } from 'obsidian';
import { Platform } from 'obsidian';

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
    };

    // Rate Limiting
    rateLimit: {
        lastRequest: number;
        requestCount: number;
        resetTime: number;
        window: number;
        maxRequests: number;
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

    // Cache for sync allowed status
    _syncAllowedCache: {
        allowed: boolean;
        lastChecked: number;
        cacheTime: number; // Cache valid for 1 second
    };
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
    processingTasks?: string[];
    locks?: string[];
    lockTimeouts?: [string, number][];
    syncQueue?: string[];
    failedSyncs?: [string, { error: Error; attempts: number }][];
    lastSyncTime?: number;
};

type StorePersist = {
    name: string;
    version: number;
    partialize: (state: TaskStore) => PersistState;
    merge: (persistedState: PersistState, currentState: TaskStore) => TaskStore;
};

const persistConfig: StorePersist = {
    name: 'obsidian-gcal-sync-storage',
    version: 1,
    partialize: (state: TaskStore) => ({
        syncEnabled: state.syncEnabled,
        authenticated: state.authenticated,
        taskVersions: Array.from(state.taskVersions.entries()),
        processingTasks: Array.from(state.processingTasks),
        locks: Array.from(state.locks),
        lockTimeouts: Array.from(state.lockTimeouts.entries()),
        syncQueue: Array.from(state.syncQueue),
        failedSyncs: Array.from(state.failedSyncs.entries()),
        lastSyncTime: state.lastSyncTime || undefined
    }),
    merge: (persistedState, currentState) => ({
        ...currentState,
        syncEnabled: persistedState.syncEnabled ?? currentState.syncEnabled,
        authenticated: persistedState.authenticated ?? currentState.authenticated,
        taskVersions: new Map(persistedState.taskVersions || []),
        processingTasks: new Set(persistedState.processingTasks || []),
        locks: new Set(persistedState.locks || []),
        lockTimeouts: new Map(persistedState.lockTimeouts || []),
        syncQueue: new Set(persistedState.syncQueue || []),
        failedSyncs: new Map(persistedState.failedSyncs || []),
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
                    maxRequests: 100 // max 100 requests per window
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
                                // Skip if this task is already being processed to prevent duplicate handling
                                if (state.processingTasks.has(task.id)) {
                                    LogUtils.debug(`Task ${task.id} is already being processed, skipping duplicate enqueue`);
                                    return;
                                }

                                // Pre-check if task has actually changed to avoid unnecessary queue entries
                                const metadata = state.plugin.settings.taskMetadata?.[task.id];
                                const hasChanged = state.hasTaskChanged(task, metadata);

                                if (!hasChanged) {
                                    LogUtils.debug(`Task ${task.id} has not changed, skipping enqueue`);
                                    return;
                                }

                                // Only add the task if it's not already in the queue
                                if (!state.syncQueue.has(task.id)) {
                                    // Log detailed task information to help with debugging
                                    LogUtils.debug(`Enqueueing task ${task.id} with title='${task.title}', reminder=${task.reminder}`);
                                    state.syncQueue.add(task.id);
                                    validTaskIds.push(task.id);
                                    newTasksAdded.push(task.id);
                                } else {
                                    LogUtils.debug(`Task ${task.id} already in queue, skipping duplicate`);
                                    validTaskIds.push(task.id); // Still count as valid for logging
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

                    // Enhanced debounce logic:
                    // 1. If we recently processed (< 1s ago), use longer delay
                    // 2. If sync is in progress, use even longer delay
                    // 3. Scale delay with queue size but with a reasonable cap
                    const recentProcessDelay = timeSinceLastProcess < 1000 ? 500 : 0;
                    const syncInProgressDelay = currentState.syncInProgress ? 800 : 0;

                    const delay = Math.min(
                        baseDelay +
                        Math.floor(baseDelay * Math.log(queueSize || 1) * 0.5) + // Reduced scaling factor
                        recentProcessDelay +
                        syncInProgressDelay,
                        1500 // Reasonable maximum delay cap
                    );

                    // Set new timeout for processing
                    set(state => {
                        state.syncTimeout = window.setTimeout(async () => {
                            const latestState = get();
                            set(state => { state.lastProcessTime = Date.now(); });

                            if (!latestState.syncInProgress) {
                                LogUtils.debug(`Processing sync queue with ${latestState.syncQueue.size} tasks`);
                                await latestState.processSyncQueue();
                            } else {
                                LogUtils.debug('Sync already in progress, tasks will be processed when current sync completes');

                                // Set a checker to process the queue once current sync finishes
                                // Use a single interval ID stored in state to prevent multiple intervals
                                if (latestState.syncQueueCheckerId) {
                                    clearInterval(latestState.syncQueueCheckerId);
                                }

                                const intervalId = window.setInterval(() => {
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
                                }, 500);

                                set(state => {
                                    state.syncQueueCheckerId = intervalId as unknown as number;

                                    // Safety cleanup after 10 seconds to avoid lingering intervals
                                    state.syncQueueCheckerTimeout = window.setTimeout(() => {
                                        if (state.syncQueueCheckerId) {
                                            clearInterval(state.syncQueueCheckerId);
                                            state.syncQueueCheckerId = null;
                                        }
                                    }, 10000) as unknown as number;
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

                    if (state.syncQueue.size === 0 || state.processingBatch) {
                        LogUtils.debug('🔄 Skipping sync: no tasks or batch in progress');
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
                        state.clearStaleProcessingTasks(30000);

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
                            // Try to get file path from metadata
                            const metadata = state.plugin.settings.taskMetadata[taskId];
                            if (metadata && metadata.filePath) {
                                filesToProcess.add(metadata.filePath);
                            }
                        }

                        // Process tasks file by file to reduce repeated file reads
                        if (filesToProcess.size > 0) {
                            // Use the Obsidian file cache for faster access
                            for (const filePath of filesToProcess) {
                                try {
                                    // Get file content with caching
                                    const fileContent = await state.getFileContent(filePath);
                                    if (!fileContent) continue;

                                    // Parse tasks from this file in one go
                                    const fileTasks = await state.plugin.taskParser.parseTasksFromContent(fileContent, filePath);

                                    // Match tasks to our task IDs
                                    for (const task of fileTasks) {
                                        if (task.id && taskIds.includes(task.id)) {
                                            taskData.set(task.id, task);
                                        }
                                    }
                                } catch (error) {
                                    LogUtils.error(`Failed to process file ${filePath}:`, error);
                                }
                            }
                        }

                        // For any remaining tasks not found in files, try to get them individually
                        for (const taskId of taskIds) {
                            if (!taskData.has(taskId)) {
                                try {
                                    const task = await state.plugin.taskParser.getTaskById(taskId);
                                    if (task) {
                                        taskData.set(taskId, task);
                                    } else {
                                        LogUtils.debug(`Task ${taskId} not found in any file`);
                                    }
                                } catch (error) {
                                    LogUtils.error(`Failed to get task ${taskId}:`, error);
                                }
                            }
                        }

                        // Process in batches for better performance
                        const batchSize = state.syncConfig.batchSize;
                        const taskBatches = [];

                        // Group tasks into batches - with optimized batching logic
                        let currentBatch = [];

                        // Group tasks by similarity to optimize API calls
                        // First, handle all tasks for the same date together
                        const tasksByDate = new Map<string, Task[]>();

                        for (const [taskId, task] of taskData.entries()) {
                            if (!task.date) continue;
                            if (!tasksByDate.has(task.date)) {
                                tasksByDate.set(task.date, []);
                            }
                            tasksByDate.get(task.date)!.push(task);
                        }

                        // Create batches based on date grouping first
                        for (const [date, dateTasks] of tasksByDate.entries()) {
                            for (const task of dateTasks) {
                                currentBatch.push(task);
                                if (currentBatch.length >= batchSize) {
                                    taskBatches.push([...currentBatch]);
                                    currentBatch = [];
                                }
                            }
                        }

                        // Add any tasks that didn't have dates
                        for (const [taskId, task] of taskData.entries()) {
                            if (!task.date && !currentBatch.some(t => t.id === task.id)) {
                                currentBatch.push(task);
                                if (currentBatch.length >= batchSize) {
                                    taskBatches.push([...currentBatch]);
                                    currentBatch = [];
                                }
                            }
                        }

                        // Add any remaining tasks
                        if (currentBatch.length > 0) {
                            taskBatches.push(currentBatch);
                        }

                        // Process batches
                        for (const batch of taskBatches) {
                            try {
                                set(state => {
                                    state.processingBatch = true;
                                });

                                // Process each task in the batch
                                for (const task of batch) {
                                    if (!task || !task.id) continue;

                                    // Skip tasks that are already being processed
                                    if (state.processingTasks.has(task.id)) {
                                        LogUtils.debug(`Task ${task.id} is already being processed in another operation, skipping`);
                                        continue;
                                    }

                                    // Double-check if the task has actually changed before syncing
                                    const metadata = state.plugin.settings.taskMetadata[task.id];
                                    const hasChanged = state.plugin.calendarSync?.hasTaskChanged(task, metadata);

                                    if (!hasChanged) {
                                        LogUtils.debug(`Task ${task.id} has not changed, skipping sync`);
                                        continue;
                                    }

                                    try {
                                        // Log what we're processing
                                        LogUtils.debug(`Processing task ${task.id}: ${JSON.stringify({
                                            title: task.title,
                                            date: task.date,
                                            completed: task.completed
                                        })}`);

                                        // Process the task
                                        await state.syncTask(task);
                                    } catch (error) {
                                        LogUtils.error(`Error processing task ${task.id}:`, error);
                                    } finally {
                                        // Remove task from the queue regardless of success/failure
                                        set(state => {
                                            state.syncQueue.delete(task.id);
                                        });
                                    }
                                }

                                // Small delay between batches to avoid overwhelming the system
                                if (batch !== taskBatches[taskBatches.length - 1]) {
                                    await new Promise(resolve => setTimeout(resolve, state.syncConfig.batchDelay));
                                }
                            } catch (error) {
                                LogUtils.error('Batch processing failed:', error);
                            }
                        }

                        // Cleanup and save
                        await state.plugin.saveSettings();

                        // On mobile, ensure we refresh file cache after sync
                        if (Platform.isMobile) {
                            // Clear any cached file content to ensure we get fresh data on next sync
                            state.clearFileCache();
                            LogUtils.debug('Mobile: cleared file cache after sync to prevent stale data');
                        }

                        // Clean up any lingering sync checkers
                        state.clearSyncQueueCheckers();

                        set(state => {
                            state.processingBatch = false;
                            state.syncInProgress = false;
                            state.status = 'connected';
                            state.lastSyncTime = Date.now();
                        });

                        LogUtils.debug(`🔄 Auto sync completed successfully with ${taskData.size} tasks`);
                    } catch (error) {
                        LogUtils.error('Auto sync failed:', error);
                        set(state => {
                            state.processingBatch = false;
                            state.syncInProgress = false;
                            state.status = 'error';
                            state.error = error as Error;
                        });
                    }
                },

                processSyncQueueNow: () => {
                    const state = get();
                    LogUtils.debug('🔄 Manual sync triggered');

                    // Clear any existing timeout
                    if (state.syncTimeout) {
                        clearTimeout(state.syncTimeout);
                        set({ syncTimeout: null });
                    }

                    // Clear any queue checkers
                    state.clearSyncQueueCheckers();

                    // Reset sync state to ensure we can start a new sync
                    if (state.syncInProgress) {
                        set({ syncInProgress: false });
                    }

                    // Start new sync process
                    LogUtils.debug('🔄 Starting manual sync process');
                    return state.processSyncQueue();
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
                            state.lockTimeouts.set(taskId, Date.now() + 30000);
                            LogUtils.debug(`Added processing task ${taskId}`);
                        }
                    }),

                removeProcessingTask: (taskId: string) =>
                    set(state => {
                        state.processingTasks.delete(taskId);
                        state.locks.delete(taskId);
                        state.lockTimeouts.delete(taskId);
                        LogUtils.debug(`Removed processing task ${taskId}`);
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
                        for (const [lockKey, timeoutValue] of state.lockTimeouts) {
                            if (now > timeoutValue) {
                                state.processingTasks.delete(lockKey);
                                state.locks.delete(lockKey);
                                state.lockTimeouts.delete(lockKey);
                                LogUtils.debug(`Released stale lock for ${lockKey}`);
                            }
                        }
                    }),

                reset: () => set(state => {
                    for (const [lockKey] of state.lockTimeouts) {
                        state.processingTasks.delete(lockKey);
                        state.locks.delete(lockKey);
                    }
                    state.lockTimeouts.clear();
                    state.lockAttempts.clear();

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
                }),

                isTaskLocked: (taskId: string) => {
                    const state = get();
                    return state.locks.has(taskId) || state.processingTasks.has(taskId);
                },

                isSyncEnabled: () => {
                    const state = get();
                    const enabled = state.syncEnabled;
                    LogUtils.debug(`🔄 Checking sync enabled: ${enabled}`);
                    return enabled;
                },

                // Cache for sync allowed status
                _syncAllowedCache: {
                    allowed: false,
                    lastChecked: 0,
                    cacheTime: 200  // 200ms cache - very short to prevent issues
                },

                isSyncAllowed: () => {
                    const state = get();
                    const now = Date.now();
                    const cache = state._syncAllowedCache;

                    // Only use cache for rapid consecutive calls
                    if (now - cache.lastChecked < cache.cacheTime) {
                        return cache.allowed;
                    }

                    const allowed = state.syncEnabled || state.tempSyncEnableCount > 0;

                    // Update cache (without logging unless changed)
                    if (allowed !== cache.allowed) {
                        LogUtils.debug(`🔄 Sync allowed status changed: ${allowed} (enabled: ${state.syncEnabled}, temp count: ${state.tempSyncEnableCount})`);

                        set(state => {
                            state._syncAllowedCache = {
                                ...state._syncAllowedCache,
                                allowed,
                                lastChecked: now
                            };
                        });
                    } else {
                        // Silent update of lastChecked time only
                        set(state => {
                            state._syncAllowedCache = {
                                ...state._syncAllowedCache,
                                lastChecked: now
                            };
                        });
                    }

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
                        state.lockTimeouts.set(lockKey, Date.now() + 30000);
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
                            resetTime: now + state.rateLimit.window
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
                            // Create deep copies of objects to prevent reference issues
                            const taskCopy = JSON.parse(JSON.stringify(task));
                            const metadataCopy = JSON.parse(JSON.stringify(metadata));

                            state.taskCache.set(taskId, {
                                task: taskCopy,
                                metadata: metadataCopy,
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

                        // Use an even shorter cache time for reads
                        if (cached && Date.now() - cached.lastChecked < maxAge) {
                            // Return deep copies to prevent mutations
                            return {
                                task: JSON.parse(JSON.stringify(cached.task)),
                                metadata: JSON.parse(JSON.stringify(cached.metadata))
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

                    // First check cached data
                    const cached = task.id ? state.taskCache.get(task.id) : null;

                    if (cached && cached.metadata) {
                        // Thorough comparison of all fields that might change
                        const hasChanged =
                            !cached.task ||
                            cached.task.title !== task.title ||
                            cached.task.date !== task.date ||
                            cached.task.time !== task.time ||
                            cached.task.endTime !== task.endTime ||
                            cached.task.reminder !== task.reminder ||
                            cached.task.completed !== task.completed;

                        if (hasChanged) {
                            // Log specific changes for debugging
                            const changes = [];
                            if (cached.task?.title !== task.title) changes.push(`title: '${cached.task?.title}' -> '${task.title}'`);
                            if (cached.task?.date !== task.date) changes.push(`date: '${cached.task?.date}' -> '${task.date}'`);
                            if (cached.task?.time !== task.time) changes.push(`time: '${cached.task?.time}' -> '${task.time}'`);
                            if (cached.task?.endTime !== task.endTime) changes.push(`endTime: '${cached.task?.endTime}' -> '${task.endTime}'`);
                            if (cached.task?.reminder !== task.reminder) changes.push(`reminder: '${cached.task?.reminder}' -> '${task.reminder}'`);
                            if (cached.task?.completed !== task.completed) changes.push(`completed: '${cached.task?.completed}' -> '${task.completed}'`);

                            if (changes.length > 0) {
                                LogUtils.debug(`Task ${task.id} changed: ${changes.join(', ')}`);
                            }

                            return true;
                        }

                        return false;
                    }

                    // If no cached data, compare to metadata
                    if (metadata) {
                        const hasMetadataChanged =
                            metadata.title !== task.title ||
                            metadata.date !== task.date ||
                            metadata.time !== task.time ||
                            metadata.endTime !== task.endTime ||
                            metadata.reminder !== task.reminder ||
                            metadata.completed !== task.completed;

                        if (hasMetadataChanged) {
                            // Log specific changes for debugging
                            const changes = [];
                            if (metadata.title !== task.title) changes.push(`title: '${metadata.title}' -> '${task.title}'`);
                            if (metadata.date !== task.date) changes.push(`date: '${metadata.date}' -> '${task.date}'`);
                            if (metadata.time !== task.time) changes.push(`time: '${metadata.time}' -> '${task.time}'`);
                            if (metadata.endTime !== task.endTime) changes.push(`endTime: '${metadata.endTime}' -> '${task.endTime}'`);
                            if (metadata.reminder !== task.reminder) changes.push(`reminder: '${metadata.reminder}' -> '${task.reminder}'`);
                            if (metadata.completed !== task.completed) changes.push(`completed: '${metadata.completed}' -> '${task.completed}'`);

                            if (changes.length > 0) {
                                LogUtils.debug(`Task ${task.id} metadata changed: ${changes.join(', ')}`);
                            }

                            return true;
                        }

                        return false;
                    }

                    // No metadata or cache - treat as changed
                    return true;
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

                        // Check if the task is in taskCache and hasn't changed - we can skip processing
                        const cached = state.taskCache.get(task.id);
                        if (cached && cached.task) {
                            // Perform quick equality check of essential fields first
                            const isTaskUnchanged =
                                cached.task.title === task.title &&
                                cached.task.date === task.date &&
                                cached.task.time === task.time &&
                                cached.task.endTime === task.endTime &&
                                cached.task.reminder === task.reminder &&
                                cached.task.completed === task.completed;

                            if (isTaskUnchanged) {
                                LogUtils.debug(`Task ${task.id} matches cache exactly, skipping sync`);
                                state.removeProcessingTask(task.id);
                                return;
                            }
                        }

                        // CRITICAL: Enhanced task data verification but with optimizations
                        let freshTask: Task = task; // Initialize with input task
                        let taskChangedDuringProcess = false;

                        try {
                            if (state.plugin.taskParser) {
                                // Get fresh task data - but only once by default for improved performance
                                const initialTask = await state.plugin.taskParser.getTaskById(task.id);

                                if (initialTask) {
                                    // Compare original task with fresh task
                                    const originalJson = JSON.stringify({
                                        title: task.title,
                                        date: task.date,
                                        time: task.time,
                                        endTime: task.endTime,
                                        reminder: task.reminder,
                                        completed: task.completed
                                    });

                                    const freshJson = JSON.stringify({
                                        title: initialTask.title,
                                        date: initialTask.date,
                                        time: initialTask.time,
                                        endTime: initialTask.endTime,
                                        reminder: initialTask.reminder,
                                        completed: initialTask.completed
                                    });

                                    if (originalJson !== freshJson) {
                                        // Only log if there's an actual change
                                        LogUtils.debug(`Task ${task.id} changed during retrieval:
                                            Original: title='${task.title}', date=${task.date}, time=${task.time}
                                            Current: title='${initialTask.title}', date=${initialTask.date}, time=${initialTask.time}`);

                                        freshTask = initialTask;
                                        taskChangedDuringProcess = true;
                                    } else {
                                        // No change detected, use original task data
                                        LogUtils.debug(`Task ${task.id} unchanged during retrieval`);
                                    }
                                }

                                // Only do a second check if we detected an initial change
                                // This reduces unnecessary file reads for stable tasks
                                if (taskChangedDuringProcess) {
                                    // Wait briefly (100ms) for potential additional changes
                                    await new Promise(resolve => setTimeout(resolve, 100));

                                    // Perform one final check to catch very recent edits
                                    const finalTask = await state.plugin.taskParser.getTaskById(task.id);
                                    if (finalTask) {
                                        const newFreshJson = JSON.stringify({
                                            title: finalTask.title,
                                            date: finalTask.date,
                                            time: finalTask.time,
                                            endTime: finalTask.endTime,
                                            reminder: finalTask.reminder,
                                            completed: finalTask.completed
                                        });

                                        const currentFreshJson = JSON.stringify({
                                            title: freshTask.title,
                                            date: freshTask.date,
                                            time: freshTask.time,
                                            endTime: freshTask.endTime,
                                            reminder: freshTask.reminder,
                                            completed: freshTask.completed
                                        });

                                        if (newFreshJson !== currentFreshJson) {
                                            LogUtils.debug(`Task ${task.id} changed again during final check:
                                                Before: title='${freshTask.title}', date=${freshTask.date}
                                                After: title='${finalTask.title}', date=${finalTask.date}`);

                                            freshTask = finalTask;
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            // If we can't get fresh data, use the original task
                            LogUtils.debug(`Couldn't get fresh task data for ${task.id}, using provided data`);
                            // freshTask is already initialized with task
                        }

                        // Get metadata
                        const metadata = state.getTaskMetadata(task.id);

                        // Check if task has changed
                        const hasChanged = state.plugin.calendarSync?.hasTaskChanged(freshTask, metadata);
                        if (!hasChanged) {
                            LogUtils.debug(`Task ${task.id} has not changed, skipping sync`);
                            state.removeProcessingTask(task.id);
                            return;
                        }

                        // Log the actual data we're syncing to help with debugging
                        LogUtils.debug(`Syncing task ${task.id} with title='${freshTask.title}', date=${freshTask.date}, reminder=${freshTask.reminder}`);

                        // Sync the task with calendar
                        await state.plugin.calendarSync?.syncTask(freshTask);

                        // Update task version
                        state.updateTaskVersion(task.id, Date.now());

                        // Cache the current state - with updated task data
                        const updatedMetadata = state.plugin.settings.taskMetadata[task.id];
                        if (updatedMetadata) {
                            state.cacheTask(task.id, freshTask, updatedMetadata);
                        }
                    } catch (error) {
                        LogUtils.error(`Failed to sync task ${task.id}:`, error);
                        state.recordSyncFailure(task.id, error as Error);
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
        )
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