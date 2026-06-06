import { zeroKnowledgeCrypto } from './zeroKnowledge';

export type AuditAction =
  | 'MEASUREMENT_CREATED' | 'MEASUREMENT_VIEWED' | 'MEASUREMENT_EXPORTED'
  | 'MEASUREMENT_DELETED' | 'SESSION_STARTED' | 'SESSION_ENDED'
  | 'CALIBRATION_CHANGED' | 'PROFILE_UPDATED' | 'TELEMEDICINE_CALL'
  | 'ENCRYPTION_INITIALIZED' | 'SECURE_STORAGE_ACCESS';

interface AuditEntry {
  id: string;
  action: AuditAction;
  timestamp: number;
  details?: string;
  integrity: string;
  previousHash: string;
}

export class AuditLog {
  private readonly STORAGE_KEY = 'bb-audit-log';
  private chain: AuditEntry[] = [];

  constructor() {
    this.load();
  }

  async log(action: AuditAction, details?: string): Promise<void> {
    const previousHash = this.chain.length > 0
      ? this.chain[this.chain.length - 1].integrity
      : '0'.repeat(64);

    const entry: Omit<AuditEntry, 'integrity'> = {
      id: crypto.randomUUID(),
      action,
      timestamp: Date.now(),
      details,
      previousHash,
    };

    const integrity = await zeroKnowledgeCrypto.generateIntegrityTag(
      JSON.stringify(entry),
    );

    if (this.chain.length > 0) {
      const last = this.chain[this.chain.length - 1];
      if (last.integrity !== entry.previousHash) {
        console.error('[AuditLog] Chain integrity breach detected!');
        return;
      }
    }

    this.chain.push({ ...entry, integrity });
    this.save();
  }

  verifyChain(): boolean {
    for (let i = 1; i < this.chain.length; i++) {
      if (this.chain[i].previousHash !== this.chain[i - 1].integrity) {
        return false;
      }
    }
    return true;
  }

  getEntries(action?: AuditAction): AuditEntry[] {
    return action
      ? this.chain.filter(e => e.action === action)
      : [...this.chain];
  }

  clear(): void {
    this.chain = [];
    localStorage.removeItem(this.STORAGE_KEY);
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) this.chain = JSON.parse(raw);
    } catch { this.chain = []; }
  }

  private save(): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.chain));
  }
}

export const auditLog = new AuditLog();
