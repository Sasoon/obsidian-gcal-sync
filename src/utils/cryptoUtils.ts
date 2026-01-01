/**
 * Cryptographic utilities for secure token storage
 * Uses Web Crypto API (AES-256-GCM) for encryption
 */

import { LogUtils } from './logUtils';

// Salt for key derivation - unique to this plugin
const PLUGIN_SALT = 'obsidian-gcal-sync-v1';

export class CryptoUtils {
    /**
     * Derives an encryption key from a salt string using PBKDF2
     * The salt should be something unique to the installation (e.g., vault path hash)
     */
    static async deriveKey(salt: string): Promise<CryptoKey> {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode(salt + PLUGIN_SALT),
            'PBKDF2',
            false,
            ['deriveKey']
        );

        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: encoder.encode(PLUGIN_SALT),
                iterations: 10000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Encrypts a string using AES-256-GCM
     * Returns base64-encoded string containing IV + ciphertext
     */
    static async encrypt(data: string, key: CryptoKey): Promise<string> {
        try {
            const encoder = new TextEncoder();
            const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM

            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                encoder.encode(data)
            );

            // Combine IV and ciphertext
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(encrypted), iv.length);

            // Return as base64
            return btoa(String.fromCharCode(...combined));
        } catch (error) {
            LogUtils.error('Encryption failed:', error);
            throw new Error('Failed to encrypt data');
        }
    }

    /**
     * Decrypts an AES-256-GCM encrypted string
     * Expects base64-encoded string containing IV + ciphertext
     */
    static async decrypt(encryptedData: string, key: CryptoKey): Promise<string> {
        try {
            // Decode from base64
            const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));

            // Extract IV (first 12 bytes) and ciphertext
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);

            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                ciphertext
            );

            return new TextDecoder().decode(decrypted);
        } catch (error) {
            LogUtils.error('Decryption failed:', error);
            throw new Error('Failed to decrypt data');
        }
    }

    /**
     * Generates a unique salt based on vault identifier
     * This ensures tokens are tied to a specific vault installation
     */
    static generateVaultSalt(vaultPath: string, pluginId: string): string {
        // Create a deterministic but unique salt for this vault/plugin combination
        return `${vaultPath}:${pluginId}`;
    }

    /**
     * Encrypts an object (e.g., OAuth tokens) to a string
     */
    static async encryptObject<T>(obj: T, key: CryptoKey): Promise<string> {
        return this.encrypt(JSON.stringify(obj), key);
    }

    /**
     * Decrypts a string back to an object
     */
    static async decryptObject<T>(encryptedData: string, key: CryptoKey): Promise<T> {
        const decrypted = await this.decrypt(encryptedData, key);
        return JSON.parse(decrypted) as T;
    }

    /**
     * Checks if a string appears to be encrypted (base64 with expected length)
     */
    static isEncrypted(data: string): boolean {
        // Encrypted data should be base64 and at least 12 bytes (IV) + some ciphertext
        if (!data || data.length < 20) return false;
        try {
            const decoded = atob(data);
            // Minimum: 12 bytes IV + at least some ciphertext
            return decoded.length >= 16;
        } catch {
            return false;
        }
    }
}
