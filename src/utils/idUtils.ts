/**
 * Simple ID generator for mobile compatibility
 * Avoids the use of crypto or UUID libraries that may not be available on all platforms
 */
export class IdUtils {
    /**
     * Generates a random ID using a simple algorithm
     * This is safe for task tracking purposes (not meant for cryptographic use)
     * @returns A random ID string (8 characters, alphanumeric lowercase)
     */
    static generateRandomId(): string {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        // Generate a random 8-character ID
        for (let i = 0; i < 8; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }
    
    /**
     * Generates a simple time-based ID
     * @returns A time-based ID with random suffix
     */
    static generateTimeBasedId(): string {
        // Get timestamp as base
        const timestamp = Date.now().toString(36);
        
        // Add random suffix (4 chars)
        const randomChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let randomSuffix = '';
        for (let i = 0; i < 4; i++) {
            randomSuffix += randomChars.charAt(Math.floor(Math.random() * randomChars.length));
        }
        
        // Combine and trim to 8 chars if needed
        return (timestamp + randomSuffix).slice(0, 8);
    }
}