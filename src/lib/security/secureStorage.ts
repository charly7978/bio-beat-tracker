import { zeroKnowledgeCrypto } from './zeroKnowledge';

interface SecureEntry {
  data: string;
  integrity: string;
  timestamp: number;
  version: number;
}

export class SecureStorage {
  private readonly PREFIX = 'bb-secure-';

  async set(key: string, value: string): Promise<void> {
    const encrypted = await zeroKnowledgeCrypto.encrypt(value);
    const integrity = await zeroKnowledgeCrypto.generateIntegrityTag(encrypted);
    const entry: SecureEntry = {
      data: encrypted,
      integrity,
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(this.PREFIX + key, JSON.stringify(entry));
  }

  async get(key: string): Promise<string | null> {
    const raw = localStorage.getItem(this.PREFIX + key);
    if (!raw) return null;
    try {
      const entry: SecureEntry = JSON.parse(raw);
      const expectedTag = await zeroKnowledgeCrypto.generateIntegrityTag(entry.data);
      if (expectedTag !== entry.integrity) {
        console.warn(`[SecureStorage] Integrity check failed for key: ${key}`);
        return null;
      }
      return await zeroKnowledgeCrypto.decrypt(entry.data);
    } catch {
      console.warn(`[SecureStorage] Failed to decrypt key: ${key}`);
      return null;
    }
  }

  remove(key: string): void {
    localStorage.removeItem(this.PREFIX + key);
  }

  clear(): void {
    const keys = this.keys();
    keys.forEach(k => this.remove(k));
  }

  keys(): string[] {
    const result: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(this.PREFIX)) {
        result.push(k.slice(this.PREFIX.length));
      }
    }
    return result;
  }
}

export const secureStorage = new SecureStorage();
