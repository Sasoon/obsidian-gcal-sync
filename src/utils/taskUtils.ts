import { Task, TaskMetadata } from '../core/types';
import { LogUtils } from './logUtils';

/**
 * Determines if a task has changed compared to its metadata.
 * This is a shared implementation used by both the store and calendar sync
 * to ensure consistent change detection.
 * 
 * @param task The current task state
 * @param metadata The task metadata to compare against
 * @param taskId Optional task ID for logging
 * @returns Boolean indicating if the task has changed and an object detailing what changed
 */
export function hasTaskChanged(task: Task, metadata?: TaskMetadata, taskId?: string): {
    changed: boolean;
    changes?: {
        title: boolean;
        date: boolean;
        time: boolean;
        endTime: boolean;
        reminder: boolean;
        completed: boolean;
        filePath: boolean;
    };
} {
    // If no metadata exists, task has changed
    if (!metadata) return { changed: true };

    // Check for "just synced" flag - prevent rapid consecutive syncs
    // This prevents the double-sync issue where a task is requeued immediately after being processed
    if (metadata.justSynced === true && metadata.syncTimestamp) {
        // Only skip if the sync was very recent (within 1.5 seconds)
        const syncAge = Date.now() - metadata.syncTimestamp;
        if (syncAge < 1500) {
            LogUtils.debug(`Task ${taskId} was just synced ${syncAge}ms ago, skipping redundant sync`);
            return { changed: false };
        }
    }

    // Always consider completed tasks as changed to ensure they get synced
    if (task.completed) {
        return {
            changed: true,
            changes: {
                title: false,
                date: false,
                time: false,
                endTime: false,
                reminder: false,
                completed: true,
                filePath: false
            }
        };
    }

    // Normalize titles by trimming
    const normalizedTaskTitle = task.title?.trim() || '';
    const normalizedMetadataTitle = metadata.title?.trim() || '';

    // Compare only the fields that affect the calendar event
    const changes = {
        title: normalizedTaskTitle !== normalizedMetadataTitle,
        date: task.date !== metadata.date,
        time: task.time !== metadata.time,
        endTime: task.endTime !== metadata.endTime,
        reminder: task.reminder !== metadata.reminder && (task.reminder !== undefined || metadata.reminder !== undefined),
        completed: task.completed !== metadata.completed,
        filePath: !!task.filePath && metadata.filePath !== task.filePath // Track file moves
    };

    const hasChanged = Object.values(changes).some(change => change);

    if (hasChanged && taskId) {
        LogUtils.debug(`Task ${taskId} changed: ${JSON.stringify(changes)}`);
    }

    return { changed: hasChanged, changes };
}