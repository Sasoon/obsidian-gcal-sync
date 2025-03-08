import type { TFile } from 'obsidian';
import type { TaskMetadata } from '../core/types';
import type GoogleCalendarSyncPlugin from '../core/main';
import { LogUtils } from '../utils/logUtils';
import { ErrorUtils } from '../utils/errorUtils';
import { useStore } from '../core/store';

interface MetadataCache {
    [fileId: string]: {
        tasks: Map<string, TaskMetadata>;
        lastAccessed: number;
    }
}

export class MetadataManager {
    private cache: MetadataCache = {};
    private readonly CACHE_TTL = 1000 * 60 * 30; // 30 minutes

    constructor(
        private plugin: GoogleCalendarSyncPlugin,
        private maxCacheSize: number = 50
    ) { }

    async getTaskMetadata(taskId: string, file: TFile): Promise<TaskMetadata | null> {
        try {
            await this.ensureFileMetadata(file);
            return this.cache[file.path]?.tasks.get(taskId) || null;
        } catch (error) {
            LogUtils.error(`Failed to get task metadata: ${error}`);
            return null;
        }
    }

    async getEventId(taskId: string): Promise<string | undefined> {
        return this.plugin.settings.taskMetadata[taskId]?.eventId;
    }

    async removeTaskMetadata(taskId: string): Promise<void> {
        try {
            if (this.plugin.settings.taskMetadata[taskId]) {
                delete this.plugin.settings.taskMetadata[taskId];
                await this.plugin.saveSettings();
                LogUtils.debug(`Removed metadata for task: ${taskId}`);
            }
        } catch (error) {
            LogUtils.error(`Failed to remove task metadata: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    async setTaskMetadata(taskId: string, metadata: TaskMetadata, file: TFile): Promise<void> {
        try {
            await this.ensureFileMetadata(file);

            this.cache[file.path].tasks.set(taskId, metadata);
            this.cache[file.path].lastAccessed = Date.now();

            // Save to plugin settings
            this.plugin.settings.taskMetadata[taskId] = metadata;
            await this.plugin.saveSettings();
            LogUtils.debug(`Updated metadata for task: ${taskId}`);
        } catch (error) {
            LogUtils.error(`Failed to set task metadata: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    private async ensureFileMetadata(file: TFile): Promise<void> {
        if (!this.cache[file.path]) {
            try {
                // Load metadata for tasks in this file
                const content = await this.plugin.app.vault.read(file);
                const matches = Array.from(content.matchAll(/<!-- task-id: ([a-z0-9]+) -->/g));

                this.cache[file.path] = {
                    tasks: new Map(),
                    lastAccessed: Date.now()
                };

                // Load existing metadata for found tasks
                for (const match of matches) {
                    const taskId = match[1];
                    if (this.plugin.settings.taskMetadata[taskId]) {
                        this.cache[file.path].tasks.set(
                            taskId,
                            this.plugin.settings.taskMetadata[taskId]
                        );
                    }
                }

                this.pruneCache();
                LogUtils.debug(`Loaded metadata for file: ${file.path}`);
            } catch (error) {
                LogUtils.error(`Failed to load file metadata: ${error}`);
                throw ErrorUtils.handleCommonErrors(error);
            }
        }
    }

    private pruneCache(): void {
        const now = Date.now();
        const entries = Object.entries(this.cache);

        // Remove old entries
        entries
            .filter(([_, data]) => now - data.lastAccessed > this.CACHE_TTL)
            .forEach(([path, _]) => {
                delete this.cache[path];
                LogUtils.debug(`Pruned old cache entry: ${path}`);
            });

        // If still too many entries, remove oldest
        if (entries.length > this.maxCacheSize) {
            entries
                .sort(([_, a], [__, b]) => a.lastAccessed - b.lastAccessed)
                .slice(0, entries.length - this.maxCacheSize)
                .forEach(([path, _]) => {
                    delete this.cache[path];
                    LogUtils.debug(`Pruned excess cache entry: ${path}`);
                });
        }
    }

    async cleanup(): Promise<void> {
        LogUtils.info('Starting metadata cleanup...');
        const allFiles = this.plugin.app.vault.getMarkdownFiles();
        const validTaskIds = new Set<string>();
        const validMetadata = new Map<string, TaskMetadata>();
        const orphanedEventIds = new Set<string>();

        try {
            // First pass: collect all valid task IDs and their current state
            for (const file of allFiles) {
                const content = await this.plugin.app.vault.read(file);
                const matches = Array.from(content.matchAll(/<!-- task-id: ([a-z0-9]+) -->/g));

                // Updated regex to match IDs at the beginning of tasks after the checkbox
                const taskStates = new Map(Array.from(content.matchAll(/- \[([ xX])\] (?:<!-- task-id: ([a-z0-9]+) -->|.*?<!-- task-id: ([a-z0-9]+) -->)/g))
                    .map(match => [match[2] || match[3], match[1].toLowerCase() === 'x']));

                for (const match of matches) {
                    const taskId = match[1];
                    validTaskIds.add(taskId);

                    // Get existing metadata
                    const metadata = this.plugin.settings.taskMetadata[taskId];
                    if (metadata) {
                        // Update completion state from actual content
                        const isCompleted = taskStates.get(taskId) || false;

                        // Ensure all required fields exist and are valid
                        const validatedMetadata: TaskMetadata = {
                            ...metadata,
                            filePath: file.path,
                            eventId: metadata.eventId || undefined,
                            createdAt: metadata.createdAt || Date.now(),
                            lastModified: metadata.lastModified || Date.now(),
                            lastSynced: metadata.lastSynced || Date.now(),
                            completed: isCompleted
                        };

                        validMetadata.set(taskId, validatedMetadata);
                    }
                }
            }

            // Collect orphaned event IDs
            for (const [taskId, metadata] of Object.entries(this.plugin.settings.taskMetadata)) {
                if (!validTaskIds.has(taskId) && metadata.eventId) {
                    orphanedEventIds.add(metadata.eventId);
                }
            }

            // Clean up orphaned events if sync is available
            if (this.plugin.calendarSync) {
                for (const eventId of orphanedEventIds) {
                    try {
                        await this.plugin.calendarSync.deleteEvent(eventId);
                        LogUtils.info(`Cleaned up orphaned event: ${eventId}`);
                    } catch (error) {
                        LogUtils.error(`Failed to clean up orphaned event ${eventId}: ${error}`);
                    }
                }
            }

            // Update settings with only valid metadata
            this.plugin.settings.taskMetadata = Object.fromEntries(validMetadata);
            await this.plugin.saveSettings();

            // Reset cache
            this.cache = {};

            LogUtils.info(`Cleanup complete - Valid tasks: ${validTaskIds.size}, Valid metadata: ${validMetadata.size}, Cleaned events: ${orphanedEventIds.size}`);
        } catch (error) {
            LogUtils.error(`Failed to complete metadata cleanup: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    public async verifyMetadataConsistency(): Promise<void> {
        try {
            LogUtils.debug('🔍 Starting metadata consistency check');

            // Only verify metadata exists, don't delete anything during load
            const tasks = await this.plugin.taskParser?.getAllTasks() || [];
            LogUtils.debug(`🔍 Found ${tasks.length} tasks in total`);

            // Just log inconsistencies instead of fixing them automatically
            const metadata = this.plugin.settings.taskMetadata;
            const inconsistencies = Object.keys(metadata).filter(id =>
                !tasks.some(task => task.id === id)
            );

            if (inconsistencies.length > 0) {
                LogUtils.debug(`🔍 Found ${inconsistencies.length} metadata entries without matching tasks`);
            }

            LogUtils.debug('🔍 Metadata consistency check completed successfully');
        } catch (error) {
            LogUtils.error('Failed to verify metadata consistency:', error);
            throw error;
        }
    }
}