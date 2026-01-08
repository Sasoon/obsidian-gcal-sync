export class TimeUtils {
    /**
     * Gets the timezone offset in the format +/-HH:mm
     */
    static getTimezoneOffset(): string {
        const date = new Date();
        const offset = -date.getTimezoneOffset();
        const hours = Math.floor(Math.abs(offset) / 60);
        const minutes = Math.abs(offset) % 60;
        return `${offset >= 0 ? '+' : '-'}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }

    /**
     * Formats date and time with timezone for Google Calendar API
     */
    static formatDateTime(date: string, time: string, timezone: string): string {
        return `${date}T${time}:00${timezone}`;
    }

    /**
     * Checks if a date is valid (rejects invalid dates like 2025-13-45 or Feb 30)
     */
    static isValidDate(date: string): boolean {
        const regex = /^\d{4}-\d{2}-\d{2}$/;
        if (!regex.test(date)) return false;

        const [year, month, day] = date.split('-').map(Number);
        if (month < 1 || month > 12) return false;
        if (day < 1 || day > 31) return false;

        // Create date and verify it didn't wrap (catches Feb 30, Apr 31, etc)
        const d = new Date(year, month - 1, day);
        return d.getFullYear() === year &&
               d.getMonth() === month - 1 &&
               d.getDate() === day;
    }

    /**
     * Checks if a time is valid (24-hour format)
     */
    static isValidTime(time: string): boolean {
        const regex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
        return regex.test(time);
    }

    /**
     * Gets current date in YYYY-MM-DD format
     */
    static getCurrentDate(): string {
        const date = new Date();
        return date.toISOString().split('T')[0];
    }

    /**
     * Gets current time in HH:mm format
     */
    static getCurrentTime(): string {
        const date = new Date();
        return date.toTimeString().slice(0, 5);
    }
} 