const PBKDF2_ITERATIONS = 210000;
const KEY_LENGTH = 256;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;

export class ZeroKnowledgeCrypto {
  private masterKey: CryptoKey | null = null;
  private initialized = false;

  async initialize(password: string): Promise<void> {
    const salt = this.getOrCreateSalt();
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password),
      'PBKDF2', false, ['deriveKey'],
    );
    this.masterKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false, ['encrypt', 'decrypt'],
    );
    this.initialized = true;
  }

  get isReady(): boolean { return this.initialized; }

  async encrypt(plaintext: string): Promise<string> {
    if (!this.masterKey) throw new Error('Not initialized');
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.masterKey, encoded,
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  async decrypt(encrypted: string): Promise<string> {
    if (!this.masterKey) throw new Error('Not initialized');
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.masterKey, ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  }

  async hash(data: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private getOrCreateSalt(): Uint8Array {
    const key = 'bio-beat-zk-salt';
    const stored = localStorage.getItem(key);
    if (stored) {
      return Uint8Array.from(atob(stored), c => c.charCodeAt(0));
    }
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    localStorage.setItem(key, btoa(String.fromCharCode(...salt)));
    return salt;
  }

  async generateIntegrityTag(data: string): Promise<string> {
    const hmacKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('bio-beat-hmac'),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(data));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export const zeroKnowledgeCrypto = new ZeroKnowledgeCrypto();
