import { TFile, Editor, MarkdownPostProcessor, MarkdownPostProcessorContext, Notice, MarkdownView } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { Task, TaskMetadata } from '../core/types';
import type GoogleCalendarSyncPlugin from '../core/main';
import { useStore } from '../core/store';
import { LogUtils } from '../utils/logUtils';
import { ErrorUtils } from '../utils/errorUtils';
import { TimeUtils } from '../utils/timeUtils';
import { Platform } from 'obsidian';

export class TaskId {
    private static readonly PATTERN = /<!-- task-id: [a-z0-9]+ -->/;

    public static exists(line: string): boolean {
        return this.PATTERN.test(line);
    }
}

export class TaskParser {
    private readonly DATE_PATTERN = /📅 (\d{4}-\d{2}-\d{2})/;
    private readonly TIME_PATTERN = /⏰ (\d{1,2}:\d{2})/;
    private readonly END_TIME_PATTERN = /➡️ (\d{1,2}:\d{2})/;
    private readonly REMINDER_PATTERN = /🔔\s*(\d+)([mhd])/;
    private readonly TASK_PATTERN = /^- \[[ xX]\] (.+)/;
    private readonly COMPLETION_PATTERN = /✅ (\d{4}-\d{2}-\d{2})/;
    private readonly ID_PATTERN = /<!-- task-id: ([a-z0-9]+) -->/;

    constructor(private plugin: GoogleCalendarSyncPlugin) { }

    private getFilteredFiles(): TFile[] {
        if (this.plugin.settings.includeFolders.length > 0) {
            return this.plugin.settings.includeFolders
                .flatMap(folder => {
                    const file = this.plugin.app.vault.getAbstractFileByPath(folder);
                    if (file instanceof TFile) {
                        return [file];
                    }
                    // If it's a folder, get all markdown files in it
                    return this.plugin.app.vault.getMarkdownFiles()
                        .filter(f => f.path.startsWith(folder));
                });
        }
        return this.plugin.app.vault.getMarkdownFiles();
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
                            tasks.push(task);
                        }

                        // Update line number to continue from last processed line
                        lineNumber = nextLineNumber - 1;
                    } catch (error) {
                        LogUtils.error(`Failed to parse task in file ${file.path} at line ${lineNumber + 1}: ${error}`);
                    }
                }
                lineNumber++;
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
            const taskData = this.parseTaskData(line);
            if (!taskData || !this.isValidTaskData(taskData)) {
                LogUtils.debug('Invalid task data:', taskData);
                return null;
            }

            const title = this.cleanTaskTitle(line);
            if (!title) {
                LogUtils.debug('Empty task title');
                return null;
            }

            // Extract ID without affecting display
            const idMatch = line.match(this.ID_PATTERN);
            const id = idMatch ? idMatch[1] : '';

            // Get existing metadata if available
            const metadata = id ? this.plugin.settings.taskMetadata[id] : null;
            LogUtils.debug(`Found metadata for task: ${id}`, metadata);

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
                const hasChanged = this.hasTaskChanged(task, metadata);
                if (hasChanged) {
                    LogUtils.debug(`Task has changed: ${id}`, task);

                    // Ensure we're not locked before updating
                    if (!state.isTaskLocked(id)) {
                        try {
                            state.addProcessingTask(id);
                            this.plugin.settings.taskMetadata[id] = {
                                ...metadata,
                                title: task.title,
                                date: task.date,
                                time: task.time,
                                endTime: task.endTime,
                                reminder: task.reminder,
                                completed: task.completed,
                                completedDate: task.completedDate,
                                lastModified: Date.now(),
                                filePath: filePath || metadata.filePath
                            };
                            await this.plugin.saveSettings();

                            // Enqueue task for sync
                            if (state.isSyncAllowed()) {
                                await state.enqueueTasks([task]);
                            }
                        } finally {
                            useStore.getState().removeProcessingTask(id);
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
        if (!metadata) return true;

        return task.title !== metadata.title ||
            task.date !== metadata.date ||
            task.time !== metadata.time ||
            task.endTime !== metadata.endTime ||
            task.reminder !== metadata.reminder ||
            task.completed !== metadata.completed;
    }

    public async createTask(task: Task) {
        try {
            const taskContent = `${task.title} 📅 ${task.date}` +
                (task.time ? ` ⏰ ${task.time}` : '') +
                (task.endTime ? ` ➡️ ${task.endTime}` : '') +
                (task.reminder ? ` 🔔 ${task.reminder}m` : '');

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

            for (const file of files) {
                try {
                    const fileTasks = await this.parseTasksFromFile(file);
                    tasks.push(...fileTasks);
                } catch (error) {
                    LogUtils.error(`Failed to parse tasks from file ${file.path}: ${error}`);
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

        header = header.replace(/^- \[[x ]\] /, '');  // Remove checkbox
        header = header.replace(this.DATE_PATTERN, '');  // Remove date
        header = header.replace(this.TIME_PATTERN, '');  // Remove time
        header = header.replace(this.END_TIME_PATTERN, '');  // Remove end time
        header = header.replace(this.REMINDER_PATTERN, '');  // Remove reminder
        header = header.replace(/✅ \d{4}-\d{2}-\d{2}/, '');  // Remove completion date
        header = header.replace(/<!-- task-id: [a-z0-9]+ -->/, '');  // Remove task ID
        header = header.trim();

        // If there are additional lines, append them
        if (lines.length > 1) {
            return header + '\n' + lines.slice(1).join('\n');
        }

        return header;
    }

    private parseTaskData(line: string): { date?: string, time?: string, endTime?: string, reminder?: number } {
        LogUtils.debug(`Parsing task data from line: ${line}`);
        const dateMatch = line.match(this.DATE_PATTERN);
        const timeMatch = line.match(this.TIME_PATTERN);
        const endTimeMatch = line.match(this.END_TIME_PATTERN);
        const reminderMatch = line.match(this.REMINDER_PATTERN);

        const result = {
            date: dateMatch?.[1],
            time: timeMatch?.[1]?.padStart(5, '0'),
            endTime: endTimeMatch?.[1]?.padStart(5, '0'),
            reminder: this.parseReminder(reminderMatch)
        };
        LogUtils.debug('Parsed task data:', result);
        return result;
    }

    private parseReminder(match: RegExpMatchArray | null): number | undefined {
        if (!match) return undefined;

        const [_, value, unit] = match;
        const numValue = parseInt(value);

        switch (unit) {
            case 'h': return numValue * 60;
            case 'd': return numValue * 24 * 60;
            default: return numValue;
        }
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
        const files = this.getFilteredFiles();

        for (const file of files) {
            const tasks = await this.parseTasksFromFile(file);
            const task = tasks.find(t => t.id === taskId);
            if (task) {
                return task;
            }
        }

        return null;
    }
}