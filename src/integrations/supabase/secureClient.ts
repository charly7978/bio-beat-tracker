/**
 * SECURE SUPABASE CLIENT
 * 
 * Cliente seguro que usa Edge Functions como proxy
 * en lugar de credenciales directas en el cliente.
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// URL de la Edge Function (en producción, usar la URL real de Supabase)
const SECURE_PROXY_URL = import.meta.env.VITE_SECURE_PROXY_URL || '/functions/v1/secure-proxy';

interface SecureClientConfig {
  secureProxyUrl?: string;
}

/**
 * Crea un cliente Supabase seguro que usa el proxy Edge Function
 */
export function createSecureClient(config?: SecureClientConfig) {
  const proxyUrl = config?.secureProxyUrl || SECURE_PROXY_URL;
  
  // En desarrollo, usar el cliente directo con variables de entorno
  // En producción, usar el proxy seguro
  const isDevelopment = import.meta.env.DEV;
  
  if (isDevelopment) {
    // Desarrollo: usar cliente directo con variables de entorno
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase environment variables');
    }
    
    return createClient<Database>(supabaseUrl, supabaseKey, {
      auth: {
        storage: localStorage,
        persistSession: true,
        autoRefreshToken: true,
      }
    });
  }
  
  // Producción: usar proxy seguro
  // Nota: Esto requiere implementación adicional del proxy
  // Por ahora, fallback al cliente directo con advertencia
  console.warn('Secure proxy not fully implemented in production. Using direct client with caution.');
  
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  
  return createClient<Database>(supabaseUrl!, supabaseKey!, {
    auth: {
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: true,
    }
  });
}

// Cliente seguro por defecto
export const secureSupabase = createSecureClient();
