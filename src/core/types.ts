import { TFile } from 'obsidian';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import "obsidian";

declare module "obsidian" {
    interface App {
        unregisterProtocolHandler?: (protocol: string) => void;
        plugins: {
            plugins: {
                [key: string]: any;
            };
        };
        commands: {
            commands: {
                [key: string]: any;
            };
            removeCommand: (commandId: string) => void;
        };
    }
}

export interface Task {
    id: string;
    title: string;
    date: string;
    eventId?: string;
    time?: string;
    endTime?: string;
    reminder?: number;
    completed: boolean;
    completedDate?: string;
    createdAt: number;
    filePath?: string;
}

export interface TaskMetadata {
    filePath?: string;
    eventId?: string;
    title: string;
    date: string;
    time?: string;
    endTime?: string;
    reminder?: number;
    completed: boolean;
    completedDate?: string;
    createdAt: number;
    lastModified: number;
    lastSynced: number;
    conflicts?: string[];
    conflictResolution?: {
        timestamp: number;
        fields: string[];
        resolution: 'auto' | 'manual';
    };
}

export interface GoogleCalendarSettings {
    clientId: string;
    clientSecret?: string;
    oauth2Tokens?: {
        access_token: string;
        refresh_token: string;
        scope: string;
        token_type: string;
        expiry_date: number;
    };
    syncEnabled: boolean;
    defaultReminder: number;
    includeFolders: string[];
    taskMetadata: Record<string, TaskMetadata>;
    taskIds: Record<string, string>;
    verboseLogging: boolean;
    hasCompletedOnboarding?: boolean;
    mobileSyncLimit?: number; // Limit number of files to search on mobile (default: 100)
    mobileOptimizations?: boolean; // Enable mobile-specific optimizations (default: true)
    tempAuthState?: string; // Temporary storage for mobile auth state parameter
    tempCodeVerifier?: string; // Temporary storage for mobile auth code verifier
}

export interface Pos {
    start: number;
    end: number;
}

export interface TaskCache {
    task: string;
    position: Pos;
    parent?: number;
}

export interface OAuth2Tokens {
    access_token: string;
    refresh_token?: string;
    scope: string;
    token_type: string;
    expiry_date: number;
}

export interface FileChangeEvent {
    type: 'create' | 'modify' | 'delete';
    file: TFile;
}

export interface CacheChangeEvent {
    type: 'resolve' | 'change';
    file?: TFile;
}

export interface GoogleAuthManagerInterface {
    getOAuth2Client(): OAuth2Client;
    startAuthFlow(): Promise<void>;
    refreshTokens(tokens: Credentials): Promise<Credentials>;
    revokeTokens(tokens: Credentials): Promise<void>;
    onunload(): Promise<void>;
}

// Constants for task versioning and validation
export const CURRENT_TASK_VERSION = 1;
export const GCAL_SYNC_TAG_REGEX = /\^gcal-([a-f0-9-]+)-([a-f0-9]{8})/;

export interface TaskIdMapping {
    id: string;
    from: number;
    to: number;
}

export interface GoogleCalendarEvent {
    id: string;
    summary: string;
    start: {
        date?: string;
        dateTime?: string;
        timeZone?: string;
    };
    end: {
        date?: string;
        dateTime?: string;
        timeZone?: string;
    };
    extendedProperties?: {
        private?: {
            obsidianTaskId?: string;
            isObsidianTask?: string;
            version?: string;
        };
    };
    reminders?: {
        useDefault: boolean;
        overrides?: Array<{
            method: string;
            minutes: number;
        }>;
    };
}

export interface TaskStore {
    lastSyncTime: number;
    lastSyncAttempt: number;
}