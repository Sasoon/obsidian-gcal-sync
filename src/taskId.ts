export class TaskId {
    private static readonly PREFIX = 'tid';
    private static readonly PATTERN = /\[\[tid:([a-z0-9]+)\]\]/;

    /**
     * Creates a task ID in the standard format
     */
    static create(id: string): string {
        return `[[${this.PREFIX}:${id}]]`;
    }

    /**
     * Extracts the ID from a task line
     */
    static extract(line: string): string | null {
        const match = line.match(this.PATTERN);
        return match ? match[1] : null;
    }

    /**
     * Removes the task ID from a line
     */
    static remove(line: string): string {
        return line.replace(this.PATTERN, '');
    }

    /**
     * Checks if a line contains a task ID
     */
    static exists(line: string): boolean {
        return this.PATTERN.test(line);
    }

    /**
     * Returns the regex pattern for finding task IDs
     */
    static getPattern(): RegExp {
        return this.PATTERN;
    }
}