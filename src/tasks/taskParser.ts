import { TFile, Editor, MarkdownPostProcessor, MarkdownPostProcessorContext, Notice, MarkdownView } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { Task, TaskMetadata } from '../core/types';
import type GoogleCalendarSyncPlugin from '../core/main';
import { useStore } from '../core/store';
import { LogUtils } from '../utils/logUtils';
import { ErrorUtils } from '../utils/errorUtils';
import { TimeUtils } from '../utils/timeUtils';
import { hasTaskChanged } from '../utils/taskUtils';
import { Platform } from 'obsidian';

export class TaskId {
    private static readonly PATTERN = /<!-- task-id: [a-z0-9]+ -->/;

    public static exists(line: string): boolean {
        return this.PATTERN.test(line);
    }
}

export class TaskParser {
    private readonly DATE_PATTERN = /📅\s*(\d{4}-\d{2}-\d{2})/;
    private readonly TIME_PATTERN = /⏰\s*(\d{1,2}:\d{2})/;
    private readonly END_TIME_PATTERN = /➡️\s*(\d{1,2}:\d{2})/;
    private readonly REMINDER_PATTERN = /🔔\s*(\d+)([mhd])/;
    private readonly TASK_PATTERN = /^- \[[ xX]\] (.+)/;
    private readonly COMPLETION_PATTERN = /✅\s*(\d{4}-\d{2}-\d{2})/;
    private readonly ID_PATTERN = /<!-- task-id: ([a-z0-9]+) -->/;

    constructor(private plugin: GoogleCalendarSyncPlugin) { }

    private getFilteredFiles(): TFile[] {
        const allFiles = this.plugin.app.vault.getMarkdownFiles();

        // If no include settings, return all files
        if (!this.plugin.settings.includeFolders || this.plugin.settings.includeFolders.length === 0) {
            return allFiles;
        }

        // Create result array for matched files
        const matchedFiles: TFile[] = [];

        // Process each inclusion path
        for (const includePath of this.plugin.settings.includeFolders) {
            // Check if this is a direct file reference (not ending with /)
            const isLikelyFile = !includePath.endsWith('/') && includePath.includes('.');

            if (isLikelyFile) {
                // Try to get this specific file
                const exactFile = allFiles.find(file => file.path === includePath);
                if (exactFile) {
                    matchedFiles.push(exactFile);
                    continue;
                }
            }

            // Handle as folder (strict matching with trailing slash)
            const folderMatchedFiles = allFiles.filter(file =>
                file.path === includePath || file.path.startsWith(includePath + '/')
            );

            if (folderMatchedFiles.length > 0) {
                matchedFiles.push(...folderMatchedFiles);
                continue;
            }

            // Try lenient folder matching (without trailing slash)
            const folderNoSlash = includePath.endsWith('/') ? includePath.slice(0, -1) : includePath;
            const lenientMatches = allFiles.filter(file =>
                file.path === folderNoSlash || file.path.startsWith(folderNoSlash + '/')
            );

            if (lenientMatches.length > 0) {
                matchedFiles.push(...lenientMatches);
            }
        }

        // Remove duplicates
        const uniqueFiles = Array.from(new Set(matchedFiles.map(file => file.path)))
            .map(path => allFiles.find(file => file.path === path))
            .filter((file): file is TFile => file !== undefined);

        // If no files found after all approaches, use all files with a warning
        if (uniqueFiles.length === 0) {
            LogUtils.warn(`No files match folder inclusion settings. Using all files as fallback. Check your settings.`);
            return allFiles;
        }

        return uniqueFiles;
    }

    public async parseTasksFromFile(file: TFile): Promise<Task[]> {
        const { isSyncAllowed } = useStore.getState();
        if (!isSyncAllowed()) {
            LogUtils.debug('Sync is disabled, skipping task parsing');
            return [];
        }

        // Check if file is in included folders
        if (this.plugin.settings.includeFolders.length > 0 &&
            !this.plugin.settings.includeFolders.some(folder => file.path.startsWith(folder))) {
            LogUtils.debug(`File ${file.path} not in included folders, skipping`);
            return [];
        }

        try {
            // Force cache invalidation before reading
            const state = useStore.getState();

            // More aggressive cache invalidation on mobile
            if (Platform.isMobile) {
                state.invalidateFileCache(file.path);
                // Small delay to ensure file system has latest content
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            state.invalidateFileCache(file.path);

            // Get fresh content
            const content = await state.getFileContent(file.path);
            const tasks: Task[] = [];
            const lines = content.split('\n');
            let lineNumber = 0;

            // Define batch size - smaller on mobile for better performance
            const BATCH_SIZE = Platform.isMobile ? 25 : 100;
            const taskBatch: Task[] = [];

            while (lineNumber < lines.length) {
                const line = lines[lineNumber];
                if (this.isTaskLine(line)) {
                    try {
                        // Get the task ID from the header line first
                        const idMatch = line.match(this.ID_PATTERN);
                        const taskId = idMatch ? idMatch[1] : '';

                        // Handle multi-line tasks with proper indentation
                        let taskHeader = line;
                        let taskContent = '';
                        let nextLineNumber = lineNumber + 1;

                        // Continue collecting indented content
                        while (nextLineNumber < lines.length) {
                            const nextLine = lines[nextLineNumber];
                            // Check for proper indentation (4 spaces)
                            if (nextLine.startsWith('    ')) {
                                // Don't include any task IDs that might be in the content
                                const contentWithoutId = nextLine.replace(this.ID_PATTERN, '').trimEnd();
                                if (contentWithoutId) {
                                    taskContent += (taskContent ? '\n' : '') + contentWithoutId;
                                }
                                nextLineNumber++;
                            } else {
                                // Break on any non-indented line
                                break;
                            }
                        }

                        // Combine header and content, ensuring ID stays with header
                        const fullTaskContent = taskContent
                            ? `${taskHeader}\n${taskContent}`
                            : taskHeader;

                        const task = await this.parseTask(fullTaskContent, file.path);
                        if (task) {
                            // Ensure task has the ID from the header
                            task.id = taskId;
                            taskBatch.push(task);

                            // Process tasks in batches to avoid memory issues with large files
                            if (taskBatch.length >= BATCH_SIZE) {
                                tasks.push(...taskBatch);
                                taskBatch.length = 0; // Clear the batch array

                                // Add a small delay on mobile to prevent UI freezing
                                if (Platform.isMobile) {
                                    await new Promise(resolve => setTimeout(resolve, 5));
                                }
                            }
                        }

                        // Update line number to continue from last processed line
                        lineNumber = nextLineNumber - 1;
                    } catch (error) {
                        LogUtils.error(`Failed to parse task in file ${file.path} at line ${lineNumber + 1}: ${error}`);
                    }
                }
                lineNumber++;
            }

            // Add any remaining tasks from the last batch
            if (taskBatch.length > 0) {
                tasks.push(...taskBatch);
            }

            return tasks;
        } catch (error) {
            LogUtils.error(`Failed to read file ${file.path}: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    public isTaskLine(line: string): boolean {
        return this.TASK_PATTERN.test(line.trim());
    }

    public async parseTask(line: string, filePath?: string): Promise<Task | null> {
        try {
            // Quick check for completed tasks without required date format
            // This avoids expensive processing for tasks that will ultimately be rejected
            if (this.isTaskCompleted(line) && !line.includes('📅')) {
                // Only log in verbose mode
                if (this.plugin.settings.verboseLogging) {
                    LogUtils.debug('Skipping completed task without date format');
                }
                return null;
            }

            const taskData = this.parseTaskData(line);
            // Silently skip invalid tasks without logging
            if (!taskData || !this.isValidTaskData(taskData)) {
                // Only log in verbose mode
                if (this.plugin.settings.verboseLogging) {
                    LogUtils.debug('Invalid task data:', taskData);
                }
                return null;
            }

            const title = this.cleanTaskTitle(line);
            if (!title) {
                // Only log in verbose mode
                if (this.plugin.settings.verboseLogging) {
                    LogUtils.debug('Empty task title');
                }
                return null;
            }

            // Extract ID without affecting display
            const idMatch = line.match(this.ID_PATTERN);
            const id = idMatch ? idMatch[1] : '';

            // Get existing metadata if available
            const metadata = id ? this.plugin.settings.taskMetadata[id] : null;
            if (this.plugin.settings.verboseLogging) {
                LogUtils.debug(`Found metadata for task: ${id}`, metadata);
            }

            const task: Task = {
                id,
                title,
                date: taskData.date || '',
                time: taskData.time,
                endTime: taskData.endTime,
                reminder: taskData.reminder,
                completed: this.isTaskCompleted(line),
                createdAt: metadata?.createdAt || Date.now(),
                completedDate: this.getCompletionDate(line)
            };

            // Use atomic state access
            const state = useStore.getState();
            if (state.isSyncAllowed() && id && metadata?.eventId) {
                const result = hasTaskChanged(task, metadata, task.id);
                const hasChanged = result.changed;
                if (hasChanged) {
                    LogUtils.debug(`Task has changed: ${id}`, task);

                    // Simple lock check with timeout to prevent permanent locks
                    // If the task has been in the processing state for more than 30 seconds,
                    // assume the lock is stale and proceed anyway
                    const isLocked = state.isTaskLocked(id);
                    const lockTimeout = 30000; // 30 seconds

                    // Use a fallback mechanism to detect stale locks
                    let shouldProcess = !isLocked;

                    // Check if this is a potentially stale lock
                    if (isLocked) {
                        // We don't have a direct way to check lock time, so we'll use metadata
                        const currentTime = Date.now();
                        const lastModified = metadata.lastModified || 0;
                        const timeSinceLastUpdate = currentTime - lastModified;

                        // If it's been more than 30 seconds since the last update,
                        // the lock is likely stale
                        if (timeSinceLastUpdate > lockTimeout) {
                            LogUtils.debug(`Potential stale lock detected for task ${id} (${timeSinceLastUpdate}ms since update)`);
                            shouldProcess = true;
                        } else {
                            // Don't add to sync queue here - this can cause double-syncing
                            // The task will be properly synced once the lock is released or expires
                            LogUtils.debug(`Task ${id} is locked, will be synced after lock is released`);
                            // No enqueueTasks call to prevent double-sync
                        }
                    }

                    if (shouldProcess) {
                        try {
                            state.addProcessingTask(id);

                            // Update the metadata with the new task data
                            // Get current version and increment it
                            const currentVersion = metadata.version || 0;
                            const newVersion = currentVersion + 1;

                            // Generate an operation ID for better tracing
                            const opId = `${id.substring(0, 4)}-${newVersion}-${Math.random().toString(36).substring(2, 5)}`;

                            LogUtils.debug(`Updating task metadata for ${id} (op:${opId}) to version ${newVersion}`);

                            const updatedMetadata = {
                                ...metadata,
                                title: task.title,
                                date: task.date,
                                time: task.time,
                                endTime: task.endTime,
                                reminder: task.reminder,
                                completed: task.completed,
                                completedDate: task.completedDate,
                                lastModified: Date.now(),
                                filePath: filePath || metadata.filePath,
                                version: newVersion,
                                syncOperationId: opId
                            };

                            // Update metadata in settings
                            this.plugin.settings.taskMetadata[id] = updatedMetadata;
                            await this.plugin.saveSettings();

                            // Create a fresh task object that incorporates the latest changes
                            // This ensures the task object passed to enqueueTasks reflects the current state
                            const freshTask: Task = {
                                ...task,
                                title: updatedMetadata.title,
                                date: updatedMetadata.date,
                                time: updatedMetadata.time,
                                endTime: updatedMetadata.endTime,
                                reminder: updatedMetadata.reminder,
                                completed: updatedMetadata.completed,
                                completedDate: updatedMetadata.completedDate
                            };

                            // Ensure task is properly enqueued for sync
                            if (state.isSyncAllowed()) {
                                LogUtils.debug(`Enqueueing changed task ${id} for sync`);
                                // Pass the freshTask to ensure it contains all changes
                                await state.enqueueTasks([freshTask]);
                            }
                        } catch (error) {
                            LogUtils.error(`Error updating task ${id}: ${error}`);
                        } finally {
                            state.removeProcessingTask(id);
                        }
                    } else {
                        LogUtils.debug(`Task ${id} is locked, skipping metadata update`);
                    }
                } else {
                    LogUtils.debug(`Task unchanged: ${id}`);
                }
            } else if (!state.isSyncAllowed()) {
                LogUtils.debug('Sync is disabled, skipping metadata update');
            }

            return task;
        } catch (error) {
            LogUtils.error(`Failed to parse task: ${error}`);
            return null;
        }
    }

    private isTaskCompleted(line: string): boolean {
        // Normalize whitespace and case
        const normalizedLine = line.toLowerCase().trim();

        // Check for various completion markers
        return normalizedLine.includes('[x]') ||
            normalizedLine.includes('[✓]') ||
            normalizedLine.includes('[✔]') ||
            normalizedLine.includes('[✕]') ||
            normalizedLine.includes('[✖]') ||
            normalizedLine.includes('[✗]') ||
            normalizedLine.includes('[✘]');
    }

    private getCompletionDate(line: string): string | undefined {
        const match = line.match(this.COMPLETION_PATTERN);
        return match ? match[1] : undefined;
    }

    private isValidTaskData(taskData: any): boolean {
        if (!taskData.date) return false;

        // Validate date format
        if (!TimeUtils.isValidDate(taskData.date)) {
            LogUtils.debug(`Invalid date format: ${taskData.date}`);
            return false;
        }

        // Validate time format if present
        if (taskData.time && !TimeUtils.isValidTime(taskData.time)) {
            LogUtils.debug(`Invalid time format: ${taskData.time}`);
            return false;
        }

        // Validate end time format if present
        if (taskData.endTime && !TimeUtils.isValidTime(taskData.endTime)) {
            LogUtils.debug(`Invalid end time format: ${taskData.endTime}`);
            return false;
        }

        // Validate time range if both times are present
        if (taskData.time && taskData.endTime) {
            const startTime = taskData.time.split(':').map(Number);
            const endTime = taskData.endTime.split(':').map(Number);
            const startMinutes = startTime[0] * 60 + startTime[1];
            const endMinutes = endTime[0] * 60 + endTime[1];

            if (startMinutes >= endMinutes) {
                LogUtils.debug(`Invalid time range: ${taskData.time} - ${taskData.endTime}`);
                return false;
            }
        }

        // Validate reminder
        if (taskData.reminder !== undefined) {
            if (typeof taskData.reminder !== 'number' || taskData.reminder <= 0) {
                LogUtils.debug(`Invalid reminder value: ${taskData.reminder}`);
                return false;
            }
        }

        return true;
    }

    private hasTaskChanged(task: Task, metadata: TaskMetadata): boolean {
        const result = hasTaskChanged(task, metadata, task.id);

        // Additional logging for task parser verbose mode
        if (result.changed && this.plugin.settings.verboseLogging) {
            if (result.changes?.title) {
                LogUtils.debug(`Title changed: "${metadata?.title}" → "${task.title}"`);
            }
        }

        return result.changed;
    }

    public async createTask(task: Task) {
        try {
            // Reorder components to put reminder at the beginning
            let taskContent = "";

            // Add reminder at the beginning if present
            if (task.reminder) {
                taskContent = `🔔 ${task.reminder}m `;
            }

            // Add title and other components with proper spacing
            taskContent += `${task.title}` +
                (task.date ? ` 📅 ${task.date}` : '') +
                (task.time ? ` ⏰ ${task.time}` : '') +
                (task.endTime ? ` ➡️ ${task.endTime}` : '');

            // Format task with proper indentation for multi-line content
            const formattedTaskLine = task.title.includes('\n')
                ? `- [ ] ${taskContent.split('\n').join('\n    ')}`
                : `- [ ] ${taskContent}`;

            const importFilePath = 'Tasks imported from Google Calendar.md';
            let file = this.plugin.app.vault.getAbstractFileByPath(importFilePath);

            if (!file) {
                file = await this.plugin.app.vault.create(
                    importFilePath,
                    '# Tasks imported from Google Calendar\n'
                );
            }

            if (file instanceof TFile) {
                const content = await this.plugin.app.vault.read(file);
                await this.plugin.app.vault.modify(file, content + '\n' + formattedTaskLine);

                const view = this.getEditorView(file);
                if (view) {
                    const offset = content.length + formattedTaskLine.length + 1;
                    this.plugin.tokenController.generateTaskId(view, offset);
                }
                LogUtils.debug(`Created task: ${task.title}`);
            }
        } catch (error) {
            LogUtils.error(`Failed to create task: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    public async getAllTasks(): Promise<Task[]> {
        try {
            const tasks: Task[] = [];
            const files = this.getFilteredFiles();
            LogUtils.debug(`Processing ${files.length} files for tasks`);

            // Process files in batches on mobile for better performance
            const MOBILE_BATCH_SIZE = 10; // Process 10 files at a time on mobile

            if (Platform.isMobile) {
                // Process files in smaller batches on mobile
                for (let i = 0; i < files.length; i += MOBILE_BATCH_SIZE) {
                    const fileBatch = files.slice(i, i + MOBILE_BATCH_SIZE);

                    for (const file of fileBatch) {
                        try {
                            const fileTasks = await this.parseTasksFromFile(file);
                            tasks.push(...fileTasks);
                        } catch (error) {
                            LogUtils.error(`Failed to parse tasks from file ${file.path}: ${error}`);
                        }
                    }

                    // Add a small delay between batches on mobile to prevent UI freezing
                    if (i + MOBILE_BATCH_SIZE < files.length) {
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
            } else {
                // Process all files at once on desktop
                for (const file of files) {
                    try {
                        const fileTasks = await this.parseTasksFromFile(file);
                        tasks.push(...fileTasks);
                    } catch (error) {
                        LogUtils.error(`Failed to parse tasks from file ${file.path}: ${error}`);
                    }
                }
            }

            LogUtils.debug(`Found ${tasks.length} tasks in total`);
            return tasks;
        } catch (error) {
            LogUtils.error(`Failed to get all tasks: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    private getEditorView(file: TFile): EditorView | null {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== file.path) return null;
        // @ts-ignore - cm exists on editor but is not typed
        return view.editor?.cm;
    }

    public cleanTaskTitle(line: string): string {
        // First clean the task header (first line)
        const lines = line.split('\n');
        let header = lines[0];

        // Remove checkbox with proper spacing handling
        header = header.replace(/^- \[[xX ]\]\s*/, '');

        // Process date, time, and other markers with consistent spacing
        // This helps prevent data corruption and ensures consistent format
        // Use a more flexible approach that doesn't care about the order of components
        header = header.replace(this.DATE_PATTERN, '').trim();
        header = header.replace(this.TIME_PATTERN, '').trim();
        header = header.replace(this.END_TIME_PATTERN, '').trim();
        header = header.replace(this.REMINDER_PATTERN, '').trim();
        header = header.replace(/✅ \d{4}-\d{2}-\d{2}/, '').trim();

        // Remove the ID with better spacing handling
        header = header.replace(/<!--\s*task-id:\s*[a-z0-9]+\s*-->/, '').trim();

        // Remove hashtags/tags (including those with numbers like #1a1a1a)
        header = header.replace(/#[a-zA-Z0-9_]+/g, '').trim();

        // Remove Obsidian Tasks plugin emojis and their associated values
        // Start date: 🛫 YYYY-MM-DD  
        header = header.replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, '').trim();
        // Scheduled date: ⏳ YYYY-MM-DD
        header = header.replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '').trim();
        // Recurrence: 🔁 (followed by recurrence pattern)
        header = header.replace(/🔁\s*[^\s]*/g, '').trim();
        // Date: 📅 (followed by date)
        header = header.replace(/📅\s*[^\s]*/g, '').trim();
        // Priority emojis (no additional text needed)
        header = header.replace(/[⏫🔼🔽🔺⏬]/g, '').trim();
        // Other task property emojis (may have text after them) 
        // This pattern matches: emoji + optional space + any non-whitespace characters
        header = header.replace(/🆔\s*[^\s]+/g, '').trim();
        header = header.replace(/[⛔❌➕⏩]\s*[^\s]+/g, '').trim();
        
        // Remove standalone dates that weren't caught by emoji patterns
        header = header.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').trim();

        // Clean up any double spaces that might have been created
        header = header.replace(/\s{2,}/g, ' ').trim();

        // If there are additional lines, append them
        if (lines.length > 1) {
            return header + '\n' + lines.slice(1).join('\n');
        }

        return header;
    }

    private parseTaskData(line: string): { date?: string, time?: string, endTime?: string, reminder?: number } {
        // Only log if verbose logging is enabled
        if (this.plugin.settings.verboseLogging) {
            LogUtils.debug(`Parsing task data from line: ${line}`);
        }

        // Parse each component independently for more flexibility,
        // supporting any order of components in the task line
        const dateMatch = line.match(this.DATE_PATTERN);
        const timeMatch = line.match(this.TIME_PATTERN);
        const endTimeMatch = line.match(this.END_TIME_PATTERN);
        const reminderMatch = line.match(this.REMINDER_PATTERN);

        // Parse reminder if present
        let reminder: number | undefined = undefined;
        if (reminderMatch) {
            const [_, value, unit] = reminderMatch;
            const numValue = parseInt(value);
            switch (unit) {
                case 'h': reminder = numValue * 60; break;
                case 'd': reminder = numValue * 24 * 60; break;
                default: reminder = numValue; break;
            }
        }

        const result = {
            date: dateMatch?.[1],
            time: timeMatch?.[1]?.padStart(5, '0'),
            endTime: endTimeMatch?.[1]?.padStart(5, '0'),
            reminder
        };

        // Only log if verbose logging is enabled
        if (this.plugin.settings.verboseLogging) {
            LogUtils.debug('Parsed task data:', result);
        }

        return result;
    }

    public async mergeTaskChanges(base: Task, local: Task, remote: Task): Promise<Task> {
        try {
            const merged = { ...base };
            const conflicts: string[] = [];

            // Compare and merge each field
            if (local.title !== base.title && remote.title !== base.title) {
                conflicts.push('title');
                merged.title = this.resolveConflict('title', local.title, remote.title, base.title);
            } else {
                merged.title = local.title !== base.title ? local.title : remote.title;
            }

            // Handle date and time conflicts
            if (local.date !== remote.date || local.time !== remote.time || local.endTime !== remote.endTime) {
                const localTimestamp = this.getTaskTimestamp(local);
                const remoteTimestamp = this.getTaskTimestamp(remote);
                const baseTimestamp = this.getTaskTimestamp(base);

                if (localTimestamp !== baseTimestamp && remoteTimestamp !== baseTimestamp) {
                    conflicts.push('schedule');
                    // Use the most recent change based on metadata
                    const useLocal = this.isLocalNewer(local.id);
                    merged.date = useLocal ? local.date : remote.date;
                    merged.time = useLocal ? local.time : remote.time;
                    merged.endTime = useLocal ? local.endTime : remote.endTime;
                } else {
                    merged.date = local.date !== base.date ? local.date : remote.date;
                    merged.time = local.time !== base.time ? local.time : remote.time;
                    merged.endTime = local.endTime !== base.endTime ? local.endTime : remote.endTime;
                }
            }

            // Handle reminder conflicts
            if (local.reminder !== remote.reminder && local.reminder !== base.reminder && remote.reminder !== base.reminder) {
                conflicts.push('reminder');
                // For reminders, use the shorter reminder time in case of conflict
                merged.reminder = Math.min(
                    local.reminder || Number.MAX_SAFE_INTEGER,
                    remote.reminder || Number.MAX_SAFE_INTEGER
                );
                if (merged.reminder === Number.MAX_SAFE_INTEGER) {
                    merged.reminder = undefined;
                }
            } else {
                merged.reminder = local.reminder !== base.reminder ? local.reminder : remote.reminder;
            }

            // Completion status is merged with OR logic
            merged.completed = local.completed || remote.completed;

            // If there were any conflicts, notify the user
            if (conflicts.length > 0) {
                this.notifyConflicts(merged.id, conflicts);

                // Store conflict information in metadata
                const metadata = this.plugin.settings.taskMetadata[merged.id] || {};
                metadata.conflicts = conflicts;
                metadata.conflictResolution = {
                    timestamp: Date.now(),
                    fields: conflicts,
                    resolution: 'auto'
                };
                this.plugin.settings.taskMetadata[merged.id] = metadata;
                await this.plugin.saveSettings();
            }

            return merged;
        } catch (error) {
            LogUtils.error(`Failed to merge task changes: ${error}`);
            throw ErrorUtils.handleCommonErrors(error);
        }
    }

    private getTaskTimestamp(task: Task): string {
        return `${task.date}${task.time || ''}${task.endTime || ''}`;
    }

    private resolveConflict(field: string, localValue: string, remoteValue: string, baseValue: string): string {
        // If one value matches base, use the other value
        if (localValue === baseValue) return remoteValue;
        if (remoteValue === baseValue) return localValue;

        // For conflicting changes, create a merged version
        return `${localValue} [!] ${remoteValue}`;
    }

    private notifyConflicts(taskId: string, fields: string[]): void {
        const notice = new Notice(
            `Conflict detected in task ${taskId}:\n` +
            `Fields: ${fields.join(', ')}\n` +
            `Changes have been auto-merged. Check the task for [!] markers.`,
            10000 // Show for 10 seconds
        );

        LogUtils.warn(`Conflicts in task ${taskId}:`, fields);
    }

    private isLocalNewer(taskId: string): boolean {
        const metadata = this.plugin.settings.taskMetadata[taskId];
        const localModified = metadata?.lastModified || 0;
        const lastSynced = metadata?.lastSynced || 0;
        return localModified > lastSynced;
    }

    public async getTaskById(taskId: string): Promise<Task | null> {
        // First check the currently active file in the editor (handles unsaved changes)
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (activeFile instanceof TFile) {
            const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView?.editor) {
                try {
                    // Parse tasks from current editor content (unsaved changes)
                    const editorContent = activeView.editor.getValue();
                    const tasks = await this.parseTasksFromContent(editorContent, activeFile.path);
                    const task = tasks.find(t => t.id === taskId);
                    if (task) {
                        LogUtils.debug(`Found task ${taskId} in current editor`);
                        return task;
                    }
                } catch (error) {
                    LogUtils.debug(`Failed to parse current editor content for task ${taskId}:`, error);
                }
            }
        }

        // Then try using metadata to locate the file directly (more efficient)
        const metadata = this.plugin.settings.taskMetadata[taskId];
        if (metadata?.filePath) {
            try {
                // Force cache invalidation before reading
                const state = useStore.getState();
                state.invalidateFileCache(metadata.filePath);

                // Add a small delay to ensure filesystem has the latest content
                await new Promise(resolve => setTimeout(resolve, 50));

                // Get file by path
                const file = this.plugin.app.vault.getAbstractFileByPath(metadata.filePath);
                if (file instanceof TFile) {
                    // Parse all tasks from this specific file
                    const tasks = await this.parseTasksFromFile(file);
                    const task = tasks.find(t => t.id === taskId);
                    if (task) {
                        return task;
                    }
                }
            } catch (error) {
                LogUtils.error(`Failed to get task ${taskId} from known file ${metadata.filePath}:`, error);
                // Fall back to full search below
            }
        }

        // If not found or metadata doesn't have file path, do a full search
        const files = this.getFilteredFiles();
        for (const file of files) {
            try {
                // Force cache invalidation for each file
                const state = useStore.getState();
                state.invalidateFileCache(file.path);

                const tasks = await this.parseTasksFromFile(file);
                const task = tasks.find(t => t.id === taskId);
                if (task) {
                    return task;
                }
            } catch (error) {
                LogUtils.error(`Failed to parse tasks from file ${file.path}:`, error);
                // Continue with next file
            }
        }

        return null;
    }

    /**
     * Parse tasks from file content without needing to read the file again
     * @param content File content as string
     * @param filePath Path to the file (for reference)
     * @returns Array of parsed tasks
     */
    public async parseTasksFromContent(content: string, filePath: string): Promise<Task[]> {
        const tasks: Task[] = [];
        const lines = content.split('\n');
        let currentTaskLine = '';
        let inMultilineTask = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check if this is a new task line
            if (this.isTaskLine(line)) {
                // If we were in a multiline task, parse the previous task
                if (inMultilineTask) {
                    const task = await this.parseTask(currentTaskLine, filePath);
                    if (task) {
                        tasks.push(task);
                    }
                }

                // Start a new task
                currentTaskLine = line;
                inMultilineTask = true;

                // Look ahead for indented continuation lines
                let j = i + 1;
                while (j < lines.length && lines[j].startsWith('    ')) {
                    // For mobile compatibility, ensure all task IDs stay on the main task line
                    // Move any IDs found in indented lines to the main task line
                    const idMatch = lines[j].match(this.ID_PATTERN);
                    if (idMatch) {
                        // Remove the ID from the indented line
                        lines[j] = lines[j].replace(this.ID_PATTERN, '').trim();

                        // If the main task line doesn't already have this ID, add it
                        if (!currentTaskLine.includes(idMatch[0])) {
                            // If the task line already has an ID, log but don't add another
                            if (currentTaskLine.match(this.ID_PATTERN)) {
                                LogUtils.debug(`Task already has an ID, skipping additional ID: ${idMatch[0]}`);
                            } else {
                                currentTaskLine += ' ' + idMatch[0];
                            }
                        }
                    }

                    // Add the indented line (without IDs) to the current task
                    currentTaskLine += '\n' + lines[j];
                    j++;
                }

                // Skip ahead if we processed indented lines
                i = j - 1;
            }
        }

        // Parse the last task if there was one
        if (inMultilineTask) {
            const task = await this.parseTask(currentTaskLine, filePath);
            if (task) {
                tasks.push(task);
            }
        }

        return tasks;
    }
}