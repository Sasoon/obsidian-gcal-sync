/**
 * Secure ID generator with cross-platform compatibility
 * Uses crypto.getRandomValues() for cryptographically secure random generation
 */
export class IdUtils {
    private static readonly CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
    private static readonly ID_LENGTH = 16;

    /**
     * Generates a cryptographically secure random ID
     * Uses crypto.getRandomValues() for secure random generation
     * @returns A random ID string (16 characters, alphanumeric lowercase)
     */
    static generateRandomId(): string {
        // Try to use crypto.randomUUID() first (most secure, returns 36-char UUID)
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            // Remove hyphens and take first 16 chars for compatibility
            return crypto.randomUUID().replace(/-/g, '').slice(0, this.ID_LENGTH);
        }

        // Fallback to crypto.getRandomValues() which is widely supported
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            const randomValues = new Uint8Array(this.ID_LENGTH);
            crypto.getRandomValues(randomValues);
            let id = '';
            for (let i = 0; i < this.ID_LENGTH; i++) {
                id += this.CHARS.charAt(randomValues[i] % this.CHARS.length);
            }
            return id;
        }

        // Final fallback for environments without crypto (should be rare)
        // Uses multiple entropy sources for better randomness
        let id = '';
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).slice(2);
        const combined = timestamp + random;

        for (let i = 0; i < this.ID_LENGTH; i++) {
            if (i < combined.length) {
                const charCode = combined.charCodeAt(i);
                id += this.CHARS.charAt(charCode % this.CHARS.length);
            } else {
                id += this.CHARS.charAt(Math.floor(Math.random() * this.CHARS.length));
            }
        }
        return id;
    }

    /**
     * Generates a secure time-based ID
     * @returns A time-based ID with cryptographically secure random suffix (16 characters)
     */
    static generateTimeBasedId(): string {
        // Get timestamp as base (provides ~8-9 chars in base36)
        const timestamp = Date.now().toString(36);

        // Generate secure random suffix
        const suffixLength = Math.max(this.ID_LENGTH - timestamp.length, 6);
        let randomSuffix = '';

        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            const randomValues = new Uint8Array(suffixLength);
            crypto.getRandomValues(randomValues);
            for (let i = 0; i < suffixLength; i++) {
                randomSuffix += this.CHARS.charAt(randomValues[i] % this.CHARS.length);
            }
        } else {
            // Fallback using Math.random (less secure but functional)
            for (let i = 0; i < suffixLength; i++) {
                randomSuffix += this.CHARS.charAt(Math.floor(Math.random() * this.CHARS.length));
            }
        }

        return (timestamp + randomSuffix).slice(0, this.ID_LENGTH);
    }
}