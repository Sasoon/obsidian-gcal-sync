export interface RepairProgress {
    phase: string;
    processedItems: number;
    totalItems: number;
}

export interface GoogleCalendarEvent {
    id: string;
    summary?: string;
    description?: string;
    start?: {
        dateTime?: string;
        date?: string;
        timeZone?: string;
    };
    end?: {
        dateTime?: string;
        date?: string;
        timeZone?: string;
    };
    updated?: string;
    extendedProperties?: {
        private?: {
            obsidianTaskId?: string;
            [key: string]: string | undefined;
        };
    };
} 