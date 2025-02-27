import type GoogleCalendarSyncPlugin from '../core/main';
import { Task } from '../core/types';
import {
    RepairProgress,
    GoogleCalendarEvent,
    RepairResult,
    RepairError,
    TaskLockedError,
    CatastrophicError,
    RepairOperations,
    RepairPhases,
    RepairPhase
} from './types';
import { LogUtils } from '../utils/logUtils';
import { useStore } from '../core/store';
import { TFile } from 'obsidian';
import type { TaskStore } from '../core/store';

interface ProgressInfo {
    phase: RepairPhase;
    processedItems: number;
    totalItems: number;
    currentOperation: string;
    failedItems: string[];
    retryCount: number;
    currentBatch: number;
    errors: Array<{ id: string; error: string }>;
}

type ProgressCallback = (progress: ProgressInfo) => void;

export class RepairManager {
    private store: TaskStore;
    private readonly MIN_BATCH_SIZE = 5;
    private readonly MAX_BATCH_SIZE = 25;
    private readonly TARGET_BATCH_COUNT = 20;
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000;

    constructor(private plugin: GoogleCalendarSyncPlugin) {
        this.store = useStore.getState();
    }

    private calculateOptimalBatchSize(totalTasks: number): number {
        return Math.max(
            this.MIN_BATCH_SIZE,
            Math.min(
                this.MAX_BATCH_SIZE,
                Math.ceil(totalTasks / this.TARGET_BATCH_COUNT)
            )
        );
    }

    private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
        const store = useStore.getState();
        if (store.isTaskLocked(taskId)) {
            throw new TaskLockedError(taskId);
        }

        store.addProcessingTask(taskId);
        try {
            return await operation();
        } finally {
            store.removeProcessingTask(taskId);
        }
    }

    private async retryOperation<T>(
        operation: () => Promise<T>,
        taskId: string,
        maxRetries: number = this.MAX_RETRIES
    ): Promise<T> {
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error as Error;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * attempt));
                    LogUtils.debug(`Retrying operation for task ${taskId}, attempt ${attempt + 1}/${maxRetries}`);
                }
            }
        }

        throw new RepairError(
            `Failed after ${maxRetries} attempts: ${lastError?.message}`,
            taskId
        );
    }

    public async repairSyncState(onProgress?: ProgressCallback): Promise<RepairResult> {
        const startTime = Date.now();
        const errors: Map<string, Error> = new Map();
        const processed: Set<string> = new Set();
        const taskIds = new Set<string>();

        try {
            // Get initial state
            const tasks = await this.getAllTasks();
            tasks.forEach(task => task.id && taskIds.add(task.id));

            onProgress?.({
                phase: RepairPhases.init,
                processedItems: 0,
                totalItems: tasks.size,
                currentOperation: RepairOperations.INIT,
                failedItems: [],
                retryCount: 0,
                currentBatch: 0,
                errors: []
            });

            // Cleanup phase
            const calendarEvents = await this.plugin.calendarSync?.findAllObsidianEvents() || [];
            const obsidianEvents = calendarEvents;  // No need to filter since findAllObsidianEvents already returns only Obsidian tasks

            // Clean up orphaned events and metadata first
            const updateProgress = (progress: Partial<ProgressInfo>, phase: RepairPhase, operation: string) => {
                onProgress?.({
                    ...progress,
                    phase,
                    currentOperation: operation,
                    failedItems: progress.failedItems || [],
                    retryCount: progress.retryCount || 0,
                    currentBatch: progress.currentBatch || 0,
                    errors: progress.errors || [],
                    processedItems: progress.processedItems || 0,
                    totalItems: progress.totalItems || 0
                });
            };

            await this.deleteOrphanedEvents(calendarEvents, taskIds, (progress) => {
                updateProgress(progress, RepairPhases.delete, RepairOperations.CLEANUP_EVENTS);
            });

            await this.cleanupOrphanedMetadata(taskIds, (progress) => {
                updateProgress(progress, RepairPhases.metadata, RepairOperations.CLEANUP_METADATA);
            });

            // Sync phase - use the existing sync queue mechanism
            if (tasks.size > 0) {
                const store = useStore.getState();
                store.startSync();
                store.enableTempSync();

                try {
                    // Clear existing queue and add all tasks
                    store.clearSyncQueue();
                    const taskArray = Array.from(tasks.values());
                    await store.enqueueTasks(taskArray);

                    // Process queue immediately
                    await store.processSyncQueueNow();

                    // Track processed tasks and errors
                    taskArray.forEach(task => {
                        if (task.id) {
                            const failedSync = store.failedSyncs.get(task.id);
                            if (failedSync) {
                                errors.set(task.id, failedSync.error);
                            } else {
                                processed.add(task.id);
                            }
                        }
                    });

                    onProgress?.({
                        phase: 'update',
                        processedItems: processed.size,
                        totalItems: tasks.size,
                        currentOperation: 'Processing tasks',
                        failedItems: Array.from(errors.keys()),
                        retryCount: 0,
                        currentBatch: 1,
                        errors: Array.from(errors.entries()).map(([id, error]) => ({
                            id,
                            error: error.message
                        }))
                    });
                } finally {
                    store.disableTempSync();
                    store.endSync(errors.size === 0);
                }
            }

            // Verify final state
            const finalEvents = await this.plugin.calendarSync?.listEvents() || [];
            const finalObsidianEvents = finalEvents.filter(event =>
                event.extendedProperties?.private?.isObsidianTask === 'true'
            );

            LogUtils.debug(`Repair completed. Events: ${finalObsidianEvents.length}, Processed: ${processed.size}, Errors: ${errors.size}`);

            return {
                success: errors.size === 0,
                processedCount: processed.size,
                errors,
                skippedTasks: new Set([...taskIds].filter(id => !processed.has(id))),
                timestamp: Date.now(),
                duration: Date.now() - startTime
            };

        } catch (error) {
            const catastrophicError = new CatastrophicError(
                `Catastrophic repair failure: ${error.message}`,
                'unknown'
            );

            return {
                success: false,
                processedCount: processed.size,
                errors: new Map([['global', catastrophicError]]),
                skippedTasks: new Set(taskIds),
                timestamp: Date.now(),
                duration: Date.now() - startTime
            };
        }
    }

    public async deleteOrphanedEvents(
        calendarEvents: GoogleCalendarEvent[],
        activeTaskIds: Set<string>,
        progressCallback?: (progress: RepairProgress) => void
    ): Promise<void> {
        try {
            LogUtils.debug('Starting orphaned events cleanup');
            let processedItems = 0;
            const totalItems = calendarEvents.length;

            // Group events by task ID for efficient lookup
            const eventsByTaskId = new Map<string, GoogleCalendarEvent[]>();
            for (const event of calendarEvents) {
                const taskId = event.extendedProperties?.private?.obsidianTaskId;
                if (taskId) {
                    const events = eventsByTaskId.get(taskId) || [];
                    events.push(event);
                    eventsByTaskId.set(taskId, events);
                }
            }

            // Process each task ID
            for (const [taskId, events] of eventsByTaskId) {
                try {
                    // If task ID doesn't exist in Obsidian, delete all its events
                    if (!activeTaskIds.has(taskId)) {
                        LogUtils.debug(`Task ${taskId} not found in Obsidian, deleting ${events.length} events`);
                        for (const event of events) {
                            try {
                                await this.plugin.calendarSync?.deleteEvent(event.id, taskId);
                                LogUtils.debug(`Deleted orphaned event ${event.id} for task ${taskId}`);
                            } catch (error) {
                                LogUtils.error(`Failed to delete orphaned event ${event.id}:`, error);
                            }
                        }

                        // Clean up metadata for non-existent task
                        if (this.plugin.settings.taskMetadata[taskId]) {
                            delete this.plugin.settings.taskMetadata[taskId];
                            await this.plugin.saveSettings();
                        }
                    } else if (events.length > 1) {
                        // If multiple events exist for same task, keep only the most recent
                        const sortedEvents = events.sort((a, b) =>
                            (new Date(b.updated || 0)).getTime() - (new Date(a.updated || 0)).getTime()
                        );

                        // Delete all but the most recent event
                        for (let i = 1; i < sortedEvents.length; i++) {
                            try {
                                await this.plugin.calendarSync?.deleteEvent(sortedEvents[i].id, taskId);
                                LogUtils.debug(`Deleted duplicate event ${sortedEvents[i].id} for task ${taskId}`);
                            } catch (error) {
                                LogUtils.error(`Failed to delete duplicate event ${sortedEvents[i].id}:`, error);
                            }
                        }

                        // Update metadata to point to the most recent event
                        const metadata = this.plugin.settings.taskMetadata[taskId];
                        if (metadata) {
                            this.plugin.settings.taskMetadata[taskId] = {
                                ...metadata,
                                eventId: sortedEvents[0].id
                            };
                            await this.plugin.saveSettings();
                        }
                    }

                    processedItems += events.length;
                    if (progressCallback) {
                        progressCallback({
                            phase: RepairPhases.delete,
                            processedItems,
                            totalItems,
                            currentOperation: RepairOperations.CLEANUP_EVENTS,
                            failedItems: [],
                            retryCount: 0,
                            currentBatch: 0,
                            errors: []
                        });
                    }
                } catch (error) {
                    LogUtils.error(`Failed to process events for task ${taskId}:`, error);
                }
            }

            LogUtils.debug('Completed orphaned events cleanup');
        } catch (error) {
            LogUtils.error('Failed to cleanup orphaned events:', error);
            throw error;
        }
    }

    public async cleanupOrphanedMetadata(
        activeTaskIds: Set<string>,
        progressCallback?: (progress: RepairProgress) => void
    ): Promise<void> {
        try {
            LogUtils.debug('Starting orphaned metadata cleanup');
            const metadata = this.plugin.settings.taskMetadata;
            const totalItems = Object.keys(metadata).length;
            let processedItems = 0;

            for (const [taskId, taskMetadata] of Object.entries(metadata)) {
                try {
                    if (!activeTaskIds.has(taskId)) {
                        // If event still exists, delete it first
                        if (taskMetadata.eventId) {
                            try {
                                await this.plugin.calendarSync?.deleteEvent(taskMetadata.eventId, taskId);
                                LogUtils.debug(`Deleted orphaned event ${taskMetadata.eventId} for task ${taskId}`);
                            } catch (error) {
                                LogUtils.error(`Failed to delete orphaned event ${taskMetadata.eventId}:`, error);
                            }
                        }

                        // Delete metadata
                        delete metadata[taskId];
                        LogUtils.debug(`Deleted orphaned metadata for task ${taskId}`);
                    }

                    processedItems++;
                    if (progressCallback) {
                        progressCallback({
                            phase: RepairPhases.metadata,
                            processedItems,
                            totalItems,
                            currentOperation: RepairOperations.CLEANUP_METADATA,
                            failedItems: [],
                            retryCount: 0,
                            currentBatch: 0,
                            errors: []
                        });
                    }
                } catch (error) {
                    LogUtils.error(`Failed to process metadata for task ${taskId}:`, error);
                }
            }

            await this.plugin.saveSettings();
            LogUtils.debug('Completed orphaned metadata cleanup');
        } catch (error) {
            LogUtils.error('Failed to cleanup orphaned metadata:', error);
            throw error;
        }
    }

    private async getAllTasks(): Promise<Map<string, Task>> {
        const tasks = new Map<string, Task>();
        const files = await this.getMarkdownFiles();

        for (const file of files) {
            const fileTasks = await this.plugin.taskParser.parseTasksFromFile(file);
            for (const task of fileTasks) {
                if (task.id) {
                    tasks.set(task.id, task);
                }
            }
        }

        return tasks;
    }

    private async cleanupOrphanedEvent(eventId: string, taskId: string): Promise<void> {
        try {
            await this.plugin.calendarSync?.deleteEvent(eventId);
            if (this.plugin.settings.taskMetadata[taskId]) {
                delete this.plugin.settings.taskMetadata[taskId];
                await this.plugin.saveSettings();
            }
            LogUtils.debug(`Deleted orphaned event ${eventId} for task ${taskId}`);
        } catch (error) {
            LogUtils.error(`Failed to delete orphaned event ${eventId}:`, error);
            throw error;
        }
    }

    private async getMarkdownFiles(): Promise<TFile[]> {
        if (this.plugin.settings.includeFolders.length > 0) {
            return this.plugin.settings.includeFolders
                .map((folder: string) => this.plugin.app.vault.getAbstractFileByPath(folder))
                .filter((file): file is TFile => file instanceof TFile);
        }
        return this.plugin.app.vault.getMarkdownFiles();
    }
} 