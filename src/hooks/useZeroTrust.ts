import { useState, useCallback, useEffect, useRef } from 'react';
import { zeroKnowledgeCrypto } from '../lib/security/zeroKnowledge';
import { secureStorage } from '../lib/security/secureStorage';
import { auditLog, type AuditAction } from '../lib/security/auditLog';

export function useZeroTrust(password?: string) {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef(password);

  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  const initialize = useCallback(async (pw: string) => {
    if (isInitializing || isInitialized) return;
    setIsInitializing(true);
    setError(null);
    try {
      await zeroKnowledgeCrypto.initialize(pw);
      setIsInitialized(true);
      auditLog.log('ENCRYPTION_INITIALIZED');
    } catch (e) {
      setError('Failed to initialize encryption');
    } finally {
      setIsInitializing(false);
    }
  }, [isInitializing, isInitialized]);

  const encryptData = useCallback(async (data: string): Promise<string> => {
    if (!zeroKnowledgeCrypto.isReady) throw new Error('Encryption not initialized');
    return zeroKnowledgeCrypto.encrypt(data);
  }, []);

  const decryptData = useCallback(async (data: string): Promise<string> => {
    if (!zeroKnowledgeCrypto.isReady) throw new Error('Encryption not initialized');
    return zeroKnowledgeCrypto.decrypt(data);
  }, []);

  const storeSecure = useCallback(async (key: string, value: string) => {
    await secureStorage.set(key, value);
    auditLog.log('SECURE_STORAGE_ACCESS', `Stored: ${key}`);
  }, []);

  const retrieveSecure = useCallback(async (key: string): Promise<string | null> => {
    const val = await secureStorage.get(key);
    auditLog.log('SECURE_STORAGE_ACCESS', `Retrieved: ${key}`);
    return val;
  }, []);

  const logAudit = useCallback(async (action: AuditAction, details?: string) => {
    await auditLog.log(action, details);
  }, []);

  const verifyAuditChain = useCallback((): boolean => {
    return auditLog.verifyChain();
  }, []);

  return {
    isInitialized, isInitializing, error,
    initialize, encryptData, decryptData,
    storeSecure, retrieveSecure,
    logAudit, verifyAuditChain,
  };
}
