import { Extension, StateField, StateEffect, RangeSet, RangeSetBuilder, EditorState, Transaction } from "@codemirror/state"
import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate } from "@codemirror/view"
import { TFile, Editor, Platform } from "obsidian"
import type GoogleCalendarSyncPlugin from '../core/main'
import { LogUtils } from '../utils/logUtils'
import { ErrorUtils } from '../utils/errorUtils'
import debounce from 'just-debounce-it'


class ZeroWidthWidget extends WidgetType {
    constructor(readonly content: string) {
        super()
    }

    eq(other: ZeroWidthWidget) {
        return other.content === this.content
    }

    toDOM() {
        const wrap = document.createElement('span')
        wrap.className = 'obsidian-gcal-task-id'
        wrap.setAttribute('aria-label', 'Task ID')
        // Extract just the ID from the comment
        const id = this.content.match(/<!-- task-id: ([a-z0-9]+) -->/)?.[1] || ''
        wrap.textContent = id
        return wrap
    }

    ignoreEvent() {
        return true
    }
}

export class TokenController {
    private plugin: GoogleCalendarSyncPlugin
    private modifyLock = false
    private readonly ID_PATTERN = /<!-- task-id: ([a-z0-9]+) -->/g
    private readonly COMPLETION_PATTERN = /✅ \d{4}-\d{2}-\d{2}/g
    private lastEditTime: number = 0

    constructor(plugin: GoogleCalendarSyncPlugin) {
        this.plugin = plugin
        this.registerEditorHandlers()
    }

    private registerEditorHandlers() {
        // Track edits and ensure IDs stay at end of lines
        this.plugin.registerEvent(
            this.plugin.app.workspace.on('editor-change', debounce((editor: Editor) => {
                this.lastEditTime = Date.now()
                this.ensureIdsAtEndOfLines(editor)
                this.checkForNewTasks(editor)
                this.handleTaskCompletionChanges(editor)
            }, 1000))
        )

        // Handle copy/paste to prevent ID duplication
        this.plugin.registerEvent(
            this.plugin.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor) => {
                const content = evt.clipboardData?.getData('text')
                if (!content) return

                // Remove any existing task IDs from pasted content
                const newContent = content.replace(this.ID_PATTERN, '')
                evt.clipboardData?.setData('text', newContent)
                LogUtils.debug('Stripped task IDs from pasted content')
            })
        )

        // Handle file modifications
        this.plugin.registerEvent(
            this.plugin.app.vault.on('modify', async (file: TFile) => {
                if (this.modifyLock) return

                try {
                    this.modifyLock = true
                    const content = await this.plugin.app.vault.read(file)
                    const currentIds = new Set(
                        Array.from(content.matchAll(this.ID_PATTERN))
                            .map(match => match[1])
                    )

                    let changed = false
                    // Only remove IDs that no longer exist in the file
                    for (const id of Object.keys(this.plugin.settings.taskMetadata)) {
                        if (!currentIds.has(id)) {
                            const metadata = this.plugin.settings.taskMetadata[id];
                            const eventId = metadata?.eventId;
                            await this.plugin.handleTaskDeletion(id, eventId);
                            changed = true;
                            LogUtils.debug(`Removed orphaned task ID: ${id}`);
                        }
                    }

                    if (changed) {
                        await this.plugin.saveSettings()
                    }
                } catch (error) {
                    LogUtils.error(`File modification handler error: ${error}`)
                } finally {
                    this.modifyLock = false
                }
            })
        )
    }

    /**
     * Handles task completion status changes, specifically handling the cleanup 
     * of completion markers when a task is unticked
     */
    private handleTaskCompletionChanges(editor: Editor) {
        // @ts-ignore - cm exists on editor but is not typed
        const view = editor.cm as EditorView
        if (!view) return

        const doc = view.state.doc
        const changes: { from: number, to: number, insert: string }[] = []

        for (let i = 1; i <= doc.lines; i++) {
            const line = doc.line(i)
            // Look for unchecked tasks with task IDs
            if (line.text.match(/^\s*- \[ \].*?<!-- task-id: ([a-z0-9]+) -->/)) {
                // Check if there are completion markers to clean up
                const hasCompletionMarkers = line.text.match(this.COMPLETION_PATTERN)

                if (hasCompletionMarkers) {
                    LogUtils.debug(`Found unticked task with completion markers: ${line.text}`)

                    // Get task ID
                    const idMatch = line.text.match(this.ID_PATTERN)
                    const taskId = idMatch ? idMatch[1] : null

                    // Check for reminder
                    const reminderMatch = line.text.match(/🔔\s*(\d+)([mhd])/)
                    const reminderText = reminderMatch ? reminderMatch[0] : null

                    // Remove all completion markers from the line
                    let newLine = line.text.replace(this.COMPLETION_PATTERN, '')
                    // Clean up any extra whitespace
                    newLine = newLine.replace(/\s+/g, ' ').trim()

                    // Ensure ID is at the end and reminder is at the beginning after checkbox
                    // Remove the ID and reminder first
                    if (taskId) {
                        newLine = newLine.replace(this.ID_PATTERN, '')
                    }
                    if (reminderText) {
                        newLine = newLine.replace(reminderText, '')
                    }
                    newLine = newLine.trim()

                    // Find the position after the checkbox for reminder
                    const checkboxMatch = newLine.match(/^(\s*- \[[ xX]\] )/)
                    if (checkboxMatch) {
                        // Add reminder after checkbox
                        if (reminderText) {
                            newLine = newLine.replace(checkboxMatch[0], checkboxMatch[0] + `${reminderText} `)
                        }

                        // Add ID at the end
                        if (taskId) {
                            newLine = newLine + ` <!-- task-id: ${taskId} -->`
                        }
                    }

                    LogUtils.debug(`Cleaning up completion markers in unticked task: ${taskId}`)
                    LogUtils.debug(`Original line: ${line.text}`)
                    LogUtils.debug(`Updated line: ${newLine}`)

                    changes.push({
                        from: line.from,
                        to: line.to,
                        insert: newLine
                    })
                }
            }
        }

        if (changes.length > 0) {
            view.dispatch({ changes })
        }
    }

    private checkForNewTasks(editor: Editor) {
        // @ts-ignore - cm exists on editor but is not typed
        const view = editor.cm as EditorView
        if (!view) return

        const doc = view.state.doc
        for (let i = 1; i <= doc.lines; i++) {
            const line = doc.line(i)
            if (line.text.match(/^\s*- \[[ x]\] /) && !line.text.match(this.ID_PATTERN)) {
                LogUtils.debug(`Found new task at line ${i}: ${line.text}`)
                this.generateTaskId(view, line.from)
            }
        }
    }

    private ensureIdsAtEndOfLines(editor: Editor) {
        // @ts-ignore - cm exists on editor but is not typed
        const view = editor.cm as EditorView
        if (!view) return

        const doc = view.state.doc
        const changes: { from: number, to: number, insert: string }[] = []

        for (let i = 1; i <= doc.lines; i++) {
            const line = doc.line(i)
            // Look for tasks with task IDs
            const taskIdMatches = [...line.text.matchAll(this.ID_PATTERN)]

            // Also look for reminders
            const reminderMatch = line.text.match(/🔔\s*(\d+)([mhd])/)

            // Handle task IDs that might be on wrong lines after line breaks
            if (taskIdMatches.length > 0 && !line.text.match(/^.*?- \[[ x]\].*/)) {
                // Found a task ID on a non-task line - move it to the previous task line
                const taskId = taskIdMatches[0][0]
                LogUtils.debug(`Found orphaned task ID on line ${i}: ${taskId}`)
                
                // Look for the previous task line
                if (i > 1) {
                    const prevLine = doc.line(i - 1)
                    if (prevLine.text.match(/^.*?- \[[ x]\].*/) && !prevLine.text.match(this.ID_PATTERN)) {
                        // Previous line is a task without an ID - move the ID there
                        changes.push({
                            from: prevLine.from,
                            to: prevLine.to,
                            insert: prevLine.text.trim() + ' ' + taskId
                        })
                        
                        // Remove the ID from current line
                        const cleanedLine = line.text.replace(this.ID_PATTERN, '').trim()
                        if (cleanedLine) {
                            changes.push({
                                from: line.from,
                                to: line.to,
                                insert: cleanedLine
                            })
                        } else {
                            // Line is empty after removing ID, remove the entire line
                            changes.push({
                                from: line.from - (i > 1 ? 1 : 0), // Include preceding newline if not first line
                                to: line.to,
                                insert: ''
                            })
                        }
                        continue
                    }
                }
            }

            if (line.text.match(/^.*?- \[[ x]\].*/)) {
                let needsUpdate = false
                let newLine = line.text

                // Handle IDs first - ensure they're at the end
                if (taskIdMatches.length > 0) {
                    // Check if there are multiple IDs (the issue)
                    if (taskIdMatches.length > 1) {
                        LogUtils.debug(`Found multiple task IDs in line: ${line.text}`)

                        // Keep only the first ID
                        const firstId = taskIdMatches[0][0]
                        // Remove all IDs from the line
                        newLine = newLine.replace(this.ID_PATTERN, '')
                        // Clean up any extra whitespace
                        newLine = newLine.replace(/\s+/g, ' ').trim()

                        // Add the ID at the end of the line
                        newLine = newLine + ' ' + firstId
                        needsUpdate = true
                    }
                    // If ID exists but is not at the end of the line
                    else {
                        const idMatch = taskIdMatches[0]
                        const idText = idMatch[0]
                        
                        // Check if ID is already at the end (with optional whitespace)
                        const isAtEnd = newLine.trim().endsWith(idText.trim())
                        
                        if (!isAtEnd) {
                            // Remove the ID from its current position
                            newLine = newLine.replace(idText, '')
                            // Clean up any extra whitespace
                            newLine = newLine.replace(/\s+/g, ' ').trim()

                            // Add the ID at the end of the line
                            newLine = newLine + ' ' + idText
                            needsUpdate = true
                        }
                    }
                }

                // Handle reminders - keep them near the beginning after the checkbox
                if (reminderMatch) {
                    const reminderText = reminderMatch[0]
                    const reminderIndex = newLine.indexOf(reminderText)

                    // Find the position after the checkbox
                    const checkboxMatch = newLine.match(/^(\s*- \[[ xX]\] )/)
                    if (checkboxMatch) {
                        const insertPos = checkboxMatch[0].length

                        // Only move if the reminder is not already near the beginning
                        if (reminderIndex > insertPos + 10) { // Allow some flexibility
                            // Remove the reminder from its current position
                            newLine = newLine.replace(reminderText, '')
                            // Clean up any extra whitespace
                            newLine = newLine.replace(/\s+/g, ' ').trim()

                            // Insert the reminder after the checkbox
                            newLine = newLine.replace(checkboxMatch[0], checkboxMatch[0] + reminderText + ' ')
                            needsUpdate = true
                        }
                    }
                }

                // Check for unchecked tasks with completion markers
                const isUnchecked = line.text.match(/^.*?- \[ \].*/)
                if (isUnchecked) {
                    const hasCompletionMarkers = line.text.match(this.COMPLETION_PATTERN)
                    if (hasCompletionMarkers) {
                        LogUtils.debug(`Found unticked task with completion markers during ID check: ${line.text}`)

                        // Get the current ID
                        const taskId = taskIdMatches.length > 0 ? taskIdMatches[0][1] : null

                        // Create a new line without completion markers
                        newLine = newLine.replace(this.COMPLETION_PATTERN, '')
                        // Clean up any extra whitespace
                        newLine = newLine.replace(/\s+/g, ' ').trim()

                        // Remove the ID temporarily
                        newLine = newLine.replace(this.ID_PATTERN, '').trim()

                        // Add the ID back at the end
                        if (taskId) {
                            const taskIdText = `<!-- task-id: ${taskId} -->`
                            newLine = newLine + ' ' + taskIdText
                        }

                        LogUtils.debug(`Cleaning up completion markers in unticked task during ID check: ${taskId}`)
                        LogUtils.debug(`Original line: ${line.text}`)
                        LogUtils.debug(`Updated line: ${newLine}`)

                        needsUpdate = true
                    }
                }

                // Only push changes if we actually modified the line
                if (needsUpdate && newLine !== line.text) {
                    changes.push({
                        from: line.from,
                        to: line.to,
                        insert: newLine
                    })
                }
            }
        }

        if (changes.length > 0) {
            view.dispatch({ changes })
        }
    }

    public getExtension(): Extension[] {
        const idPattern = this.ID_PATTERN;
        const plugin = this.plugin;
        const controller = this;

        // Create a ViewPlugin to handle task creation in real-time
        const taskCreationPlugin = ViewPlugin.fromClass(class {
            private lastChangeTime = 0;

            update(update: ViewUpdate) {
                if (!update.docChanged) return;

                const currentTime = Date.now();
                if (currentTime - this.lastChangeTime < 100) return; // Debounce rapid changes
                this.lastChangeTime = currentTime;

                // Check for new tasks in changed ranges
                update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                    const doc = update.view.state.doc;
                    const startLine = doc.lineAt(fromB);
                    const endLine = doc.lineAt(toB);

                    for (let pos = startLine.from; pos <= endLine.to;) {
                        const line = doc.lineAt(pos);
                        if (line.text.match(/^\s*- \[[ x]\] /) && !line.text.match(idPattern)) {
                            LogUtils.debug(`Real-time task detection: Found new task at line ${line.number}`);
                            controller.generateTaskId(update.view, line.from);
                        }
                        pos = line.to + 1;
                    }
                });
            }
        });

        // Add task completion state change detector
        const taskCompletionPlugin = ViewPlugin.fromClass(class {
            private lastChangeTime = 0;

            update(update: ViewUpdate) {
                if (!update.docChanged) return;

                const currentTime = Date.now();
                if (currentTime - this.lastChangeTime < 100) return; // Debounce rapid changes
                this.lastChangeTime = currentTime;

                // Process changes to detect task toggling
                update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                    const oldDoc = update.startState.doc;
                    const newDoc = update.state.doc;

                    // Find the lines of the changes
                    const oldStartLine = oldDoc.lineAt(fromA);
                    const newStartLine = newDoc.lineAt(fromB);

                    // Check if this might be a task checkbox toggle
                    const oldLineText = oldStartLine.text;
                    const newLineText = newStartLine.text;

                    // Check if the line had an ID (to ensure we're dealing with our tracked tasks)
                    const taskIdMatch = newLineText.match(controller.ID_PATTERN);
                    if (!taskIdMatch) return;

                    const taskId = taskIdMatch[1];

                    // Check if this is a task being unticked (checkbox state changed from '[x]' to '[ ]')
                    const wasChecked = oldLineText.match(/^\s*- \[[xX]\]/);
                    const isNowUnchecked = newLineText.match(/^\s*- \[ \]/);

                    if (wasChecked && isNowUnchecked) {
                        LogUtils.debug(`Task ${taskId} was unticked - will remove completion markers`);

                        // Look for completion markers on the line
                        const hasCompletionMarkers = newLineText.match(controller.COMPLETION_PATTERN);

                        // Check for reminder using the bell emoji (U+1F514)
                        const reminderPattern = /\u{1F514}\s*(\d+)([mhd])/u;
                        const reminderMatch = newLineText.match(reminderPattern);
                        const reminderText = reminderMatch ? reminderMatch[0] : null;

                        if (hasCompletionMarkers) {
                            LogUtils.debug(`Detected completion markers on unticked task ${taskId} - cleaning up`);

                            // Remove all completion markers
                            let cleanedLine = newLineText.replace(controller.COMPLETION_PATTERN, '');
                            // Clean up extra whitespace
                            cleanedLine = cleanedLine.replace(/\s+/g, ' ').trim();

                            // Ensure the ID is at the end and reminder is at the beginning after checkbox
                            // Remove the ID and reminder
                            cleanedLine = cleanedLine.replace(controller.ID_PATTERN, '').trim();
                            if (reminderText) {
                                cleanedLine = cleanedLine.replace(reminderText, '').trim();
                            }

                            // Find the position after the checkbox for reminder
                            const checkboxMatch = cleanedLine.match(/^(\s*- \[[ xX]\] )/);
                            if (checkboxMatch) {
                                // Add reminder after checkbox
                                if (reminderText) {
                                    cleanedLine = cleanedLine.replace(checkboxMatch[0], checkboxMatch[0] + reminderText + ' ');
                                }

                                // Add ID at the end
                                cleanedLine = cleanedLine + ' ' + taskIdMatch[0];
                            }

                            LogUtils.debug(`Original line: ${newLineText}`);
                            LogUtils.debug(`Cleaned line: ${cleanedLine}`);

                            // Apply the change
                            update.view.dispatch({
                                changes: [{ from: newStartLine.from, to: newStartLine.to, insert: cleanedLine }]
                            });
                        }
                    }
                });
            }
        });

        const taskIdField = StateField.define<DecorationSet>({
            create() {
                return Decoration.none
            },
            update(oldSet, tr) {
                // Only prevent standalone deletion of task IDs
                if (tr.changes.length > 0) {
                    const newDoc = tr.newDoc.toString();
                    const oldDoc = tr.startState.doc.toString();

                    // Get all task lines and their IDs from both states
                    const oldMatches = Array.from(oldDoc.matchAll(/^.*?- \[[ x]\].*?(<!-- task-id: [a-z0-9]+ -->)/gm));
                    const newMatches = Array.from(newDoc.matchAll(/^.*?- \[[ x]\].*?(<!-- task-id: [a-z0-9]+ -->)/gm));

                    // If we have fewer task IDs but the same number of tasks, prevent the change
                    // This catches standalone ID deletions while allowing task operations
                    if (oldMatches.length === newMatches.length &&
                        oldMatches.length > Array.from(newDoc.matchAll(idPattern)).length) {
                        return oldSet;
                    }
                }

                const builder = new RangeSetBuilder<Decoration>()
                const decorations: Array<{
                    from: number,
                    to: number,
                    decoration: Decoration
                }> = []

                // First collect all decorations
                for (let pos = 0; pos < tr.state.doc.length;) {
                    const line = tr.state.doc.lineAt(pos)
                    let match

                    idPattern.lastIndex = 0
                    while ((match = idPattern.exec(line.text)) !== null) {
                        const from = line.from + match.index
                        const to = from + match[0].length

                        // Replace the ID with a widget and make it atomic
                        decorations.push({
                            from,
                            to,
                            decoration: Decoration.replace({
                                widget: new ZeroWidthWidget(match[0]),
                                block: false,
                                side: 1  // Changed to 1 to prefer end of line
                            })
                        })
                    }
                    pos = line.to + 1
                }

                // Sort decorations by position
                decorations.sort((a, b) => a.from - b.from)

                // Add sorted decorations to builder
                for (const { from, to, decoration } of decorations) {
                    builder.add(from, to, decoration)
                }

                return builder.finish()
            },
            provide: f => EditorView.decorations.from(f)
        })

        // Enhanced atomic ranges to prevent selective deletion of IDs, but allow line deletion
        const atomicRanges = EditorView.atomicRanges.of(view => {
            const builder = new RangeSetBuilder();
            const content = view.state.doc.toString();
            let match;

            // Reset lastIndex to ensure we start from the beginning
            this.ID_PATTERN.lastIndex = 0;

            // First check if this is a large-scale deletion (multiple lines)
            // We don't want to interfere with multi-line deletions or cut operations
            const selection = view.state.selection;
            const hasLargeSelection = selection.ranges.some(range =>
                range.to - range.from > 10 || // More than a few characters
                content.slice(range.from, range.to).includes('\n') // Multi-line selection
            );

            // If there's a large selection active, don't make IDs atomic to allow deletion
            if (hasLargeSelection) {
                return builder.finish();
            }

            while ((match = this.ID_PATTERN.exec(content)) !== null) {
                if (match.index !== undefined) {
                    // Only make task IDs atomic inside task lines - not when selecting whole lines
                    const lineStart = content.lastIndexOf('\n', match.index) + 1;
                    let lineEnd = content.indexOf('\n', match.index);
                    if (lineEnd === -1) lineEnd = content.length;

                    // Check if the line contains a task
                    const line = content.slice(lineStart, lineEnd);
                    const isTaskLine = line.match(/^.*?- \[[ xX]\]/);

                    // Make the ID atomic only if it's in a task line and not being deleted as part of the whole line
                    if (isTaskLine) {
                        builder.add(
                            match.index,
                            match.index + match[0].length,
                            Decoration.mark({
                                inclusive: false,
                                atomic: true
                            })
                        );
                    }
                }
            }

            return builder.finish();
        });

        // Add transaction filter to prevent ID modifications except in whole task operations
        const preventDeletion = EditorState.transactionFilter.of(tr => {
            if (!tr.changes.length) return tr;

            let changes: { from: number, to: number, insert: string }[] = [];
            let shouldBlock = false;

            tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                const line = tr.startState.doc.lineAt(fromA);
                const taskMatch = line.text.match(/^.*?- \[[ xX]\].*?(<!-- task-id: [a-z0-9]+ -->)/);
                const insertedText = inserted.toString();

                // Allow complete line deletion (when a line is fully deleted and replaced with nothing)
                // Or when the line is part of a larger deletion (multi-line delete or cut)
                const isLineDeletion =
                    (toA - fromA >= line.length && inserted.length === 0) || // Full line deletion
                    (toA - fromA > 0 && line.text.includes(this.ID_PATTERN.source) && inserted.length === 0); // Partial containing ID

                if (isLineDeletion) {
                    // Handle task deletion logic in background
                    if (taskMatch) {
                        const idMatch = line.text.match(this.ID_PATTERN);
                        if (idMatch && idMatch[1]) {
                            const taskId = idMatch[1];
                            LogUtils.debug(`Task line deletion detected for task ${taskId}`);

                            // Schedule task cleanup asynchronously with a short delay
                            // to ensure the edit completes first
                            setTimeout(() => {
                                try {
                                    const metadata = this.plugin.settings.taskMetadata[taskId];
                                    this.plugin.handleTaskDeletion(taskId, metadata?.eventId)
                                        .catch(error => LogUtils.error(`Error cleaning up deleted task ${taskId}: ${error}`));
                                } catch (error) {
                                    LogUtils.error(`Error scheduling task deletion for ${taskId}: ${error}`);
                                }
                            }, 100);
                        }
                    }
                    return; // Always allow line deletions
                }

                if (taskMatch) {
                    const idIndex = line.text.indexOf('<!-- task-id:');
                    const idStartIndex = idIndex + '<!-- task-id: '.length;
                    const idEndIndex = idIndex + taskMatch[1].length - ' -->'.length;
                    const changeIndex = fromA - line.from;

                    // Check if this is a line break
                    if (insertedText.includes('\n')) {
                        // Only block if breaking within the actual ID
                        if (changeIndex > idStartIndex && changeIndex < idEndIndex) {
                            shouldBlock = true;
                            return;
                        }

                        // For line breaks within task content, let CodeMirror handle naturally
                        // We'll fix the ID position in a post-processing step via the ensureIdsAtEndOfLines method
                        // This prevents the character duplication bug caused by conflicting transaction handling

                        // Always allow the line break to proceed naturally
                        return;
                    }

                    // Check if this is a whole task operation
                    const isWholeTaskOperation =
                        // Entire line is being modified
                        (line.text.trim() === tr.startState.sliceDoc(fromA, toA).trim()) ||
                        // New task is being pasted
                        (insertedText.match(/^- \[[ xX]\]/));

                    // Block if trying to modify just the ID
                    if (!isWholeTaskOperation &&
                        changeIndex > idStartIndex && changeIndex < idEndIndex) {
                        shouldBlock = true;
                        return;
                    }
                }

                // Check for standalone ID deletion (but not if deleting the entire line)
                const deletedText = tr.startState.sliceDoc(fromA, toA);
                if (deletedText.match(this.ID_PATTERN) &&
                    !deletedText.match(/^.*?- \[[ xX]\]/) &&
                    !insertedText.match(/^.*?- \[[ xX]\]/) &&
                    !isLineDeletion) {
                    shouldBlock = true;
                    return;
                }
            });

            if (shouldBlock) {
                return [];
            }

            if (changes.length > 0) {
                return [tr, { changes }];
            }

            return tr;
        });

        // Add reminder shortcut conversion
        const reminderConverter = EditorState.transactionFilter.of(tr => {
            if (!tr.docChanged) return tr;

            const changes: { from: number, to: number, insert: string }[] = [];
            const doc = tr.newDoc;

            tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                const text = inserted.toString();
                if (text !== 'r') return;

                // Get the line and ensure it's a task
                const line = doc.lineAt(fromB);
                if (!line.text.match(/^- \[[ x]\]/)) return;

                // Look back for '@' character
                const beforePos = fromB - 1;
                if (beforePos < line.from) return;

                const beforeChar = doc.sliceString(beforePos, fromB);
                if (beforeChar !== '@') return;

                // Simply replace @r with the bell emoji at the cursor position
                // This allows the user to add the time value before it gets moved
                changes.push({
                    from: beforePos,
                    to: fromB + text.length,
                    insert: "🔔"
                });
            });

            if (!changes.length) return tr;

            // Create a new transaction with our changes
            return [tr, {
                changes,
                sequential: true
            }];
        });

        return [
            taskIdField,
            atomicRanges,
            preventDeletion,
            reminderConverter,
            taskCreationPlugin,
            taskCompletionPlugin
        ];
    }

    // Private implementation of generateTaskId
    private _generateTaskId(view: EditorView, pos: number): string {
        try {
            // Import the IdUtils class we created for mobile compatibility
            // Using delayed import to avoid potential issues on load
            const { IdUtils } = require('../utils/idUtils');

            // Generate a time-based ID for better uniqueness
            const id = IdUtils.generateTimeBasedId();
            const now = Date.now();
            const line = view.state.doc.lineAt(pos);
            const file = this.plugin.app.workspace.getActiveFile();
            if (!file) {
                LogUtils.error('No active file found');
                return '';
            }

            LogUtils.debug('Generating ID for line:', line.text);

            // Check if line already has an ID
            if (line.text.match(this.ID_PATTERN)) {
                LogUtils.debug('Line already has an ID');
                return '';
            }

            // Check if this is a task line
            const taskMatch = line.text.match(/^\s*- \[[ x]\] (.+)/)
            if (!taskMatch) {
                LogUtils.debug('Not a task line');
                return '';
            }

            // Create the task ID
            const taskId = `<!-- task-id: ${id} -->`;

            // Insert the ID at the end of the line
            // This helps with tag parsing and general readability
            let transaction;

            // Find the end of the line
            const insertPos = line.to;

            // Insert the ID at the end of the task line
            const changes = [{
                from: insertPos,
                to: insertPos,
                insert: ` ${taskId}`
            }];

            transaction = view.state.update({ changes });
            view.dispatch(transaction);

            // Store metadata about this task
            this.plugin.settings.taskMetadata[id] = {
                createdAt: now,
                lastModified: now,
                lastSynced: now,
                eventId: '', // Will be filled when synced with Google Calendar
                title: line.text.replace(/^\s*- \[[ xX]\] /, ''),
                date: new Date().toISOString().split('T')[0],
                completed: line.text.indexOf('- [x]') >= 0 || line.text.indexOf('- [X]') >= 0,
            };
            this.plugin.saveSettings();

            LogUtils.debug(`Generated new task ID: ${id}`);

            return id;
        } catch (error) {
            LogUtils.error(`Failed to generate task ID: ${error}`);
            return '';
        }
    }

    // Public method for generating task IDs with controlled debouncing
    // We maintain an internal queue to ensure we process all tasks even under high load
    private taskIdGenQueue: Array<{ view: EditorView, pos: number, time: number }> = [];
    private isProcessingQueue = false;

    private async processTaskIdGenQueue() {
        if (this.isProcessingQueue || this.taskIdGenQueue.length === 0) return;

        try {
            this.isProcessingQueue = true;

            // Sort by time (oldest first)
            this.taskIdGenQueue.sort((a, b) => a.time - b.time);

            // Process up to 5 items at a time
            const batch = this.taskIdGenQueue.splice(0, 5);

            for (const item of batch) {
                try {
                    // Add a small delay before checking to ensure editor state is stable
                    await new Promise(resolve => setTimeout(resolve, 10));

                    const line = item.view.state.doc.lineAt(item.pos);

                    // Only generate ID if line is a task and doesn't already have an ID
                    if (line.text.match(/^\s*- \[[ x]\] /) && !line.text.match(this.ID_PATTERN)) {
                        const id = this._generateTaskId(item.view, item.pos);
                        if (id) {
                            LogUtils.debug(`Added ID to new task: ${id}`);
                        }
                    }
                } catch (error) {
                    LogUtils.error(`Error processing task ID generation for item: ${error}`);
                }

                // Increased pause between operations to prevent editor lag and allow
                // previous updates to complete
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        } catch (error) {
            LogUtils.error(`Error processing task ID queue: ${error}`);
        } finally {
            this.isProcessingQueue = false;

            // If more items remain, continue processing after a longer delay
            // to ensure the editor has fully processed previous updates
            if (this.taskIdGenQueue.length > 0) {
                setTimeout(() => this.processTaskIdGenQueue(), 250);
            }
        }
    }

    public generateTaskId = (view: EditorView, pos: number): void => {
        // Add to queue
        this.taskIdGenQueue.push({
            view,
            pos,
            time: Date.now()
        });

        // Start processing if not already doing so
        if (!this.isProcessingQueue) {
            this.processTaskIdGenQueue();
        }
    }

    public getTaskId(state: EditorState, pos: number): string | null {
        try {
            const line = state.doc.lineAt(pos)
            // For single match operations, create a non-global version of the pattern
            const singleMatchPattern = /<!-- task-id: ([a-z0-9]+) -->/
            const match = line.text.match(singleMatchPattern)
            return match ? match[1] : null
        } catch (error) {
            LogUtils.error(`Error getting task ID: ${error}`)
            return null
        }
    }

    public debugIds(state: EditorState) {
        LogUtils.debug('Task IDs in document:')
        const lines = state.doc.toString().split('\n')
        lines.forEach((line, index) => {
            const match = line.match(this.ID_PATTERN)
            if (match) {
                LogUtils.debug(`Line ${index + 1}: ID ${match[1]}`)
            }
        })
    }
}
