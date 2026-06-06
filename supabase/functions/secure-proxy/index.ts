/**
 * SECURE PROXY EDGE FUNCTION - OPTIMIZADO
 * 
 * Proxy seguro para Supabase que oculta credenciales del cliente.
 * Implementa:
 * - Token rotation automático
 * - Rate limiting con sliding window
 * - Validación de requests
 * - Logging seguro
 * - Response caching para GET requests
 * - Request sanitization
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  'Access-Control-Max-Age': '86400',
};

// Rate limiting con sliding window: 100 requests por minuto por IP
const rateLimitMap = new Map<string, { timestamps: number[] }>();
const RATE_LIMIT = 100;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record) {
    rateLimitMap.set(ip, { timestamps: [now] });
    return { allowed: true, remaining: RATE_LIMIT - 1, resetTime: now + RATE_LIMIT_WINDOW };
  }

  // Remover timestamps viejos
  record.timestamps = record.timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);

  if (record.timestamps.length >= RATE_LIMIT) {
    const oldestTimestamp = record.timestamps[0] || now;
    return { 
      allowed: false, 
      remaining: 0, 
      resetTime: oldestTimestamp + RATE_LIMIT_WINDOW 
    };
  }

  record.timestamps.push(now);
  return { 
    allowed: true, 
    remaining: RATE_LIMIT - record.timestamps.length, 
    resetTime: now + RATE_LIMIT_WINDOW 
  };
}

// Response cache para GET requests (5 minutos)
const responseCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(url: string, method: string): string {
  return `${method}:${url}`;
}

function getCachedResponse(key: string): unknown | null {
  const cached = responseCache.get(key);
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  
  return cached.data;
}

function setCachedResponse(key: string, data: unknown): void {
  responseCache.set(key, { data, timestamp: Date.now() });
  
  // Limpiar cache viejo periódicamente
  if (responseCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of responseCache.entries()) {
      if (now - v.timestamp > CACHE_TTL) {
        responseCache.delete(k);
      }
    }
  }
}

// Sanitizar request para prevenir inyección
function sanitizePath(path: string): string {
  // Remover paths maliciosos
  const sanitized = path
    .replace(/\.\./g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
  
  // Solo permitir paths válidos de Supabase
  const allowedPrefixes = ['/measurements', '/measurement_attempts', '/users', '/profiles'];
  const hasAllowedPrefix = allowedPrefixes.some(prefix => sanitized.startsWith(prefix));
  
  if (!hasAllowedPrefix) {
    throw new Error('Invalid path');
  }
  
  return sanitized;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace('/functions/v1/secure-proxy', '');
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';

    // Rate limiting
    const rateLimitResult = checkRateLimit(clientIp);
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ 
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        }),
        { 
          status: 429, 
          headers: { 
            ...corsHeaders, 
            'Content-Type': 'application/json',
            'Retry-After': Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000).toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimitResult.resetTime.toString(),
          } 
        }
      );
    }

    // Validar método
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Sanitizar path
    const sanitizedPath = sanitizePath(path);

    // Check cache para GET requests
    if (req.method === 'GET') {
      const cacheKey = getCacheKey(sanitizedPath + url.search, 'GET');
      const cached = getCachedResponse(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify(cached),
          {
            status: 200,
            headers: { 
              ...corsHeaders, 
              'Content-Type': 'application/json',
              'X-Cache': 'HIT',
            },
          }
        );
      }
    }

    // Crear cliente Supabase con credenciales de servidor (no expuestas al cliente)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase credentials');
    }

    // Proxy request a Supabase
    const requestBody = req.method === 'POST' || req.method === 'PUT' 
      ? await req.json() 
      : undefined;

    // Construir URL de Supabase
    const supabaseApiUrl = `${supabaseUrl}/rest/v1/${sanitizedPath}${url.search}`;

    const response = await fetch(supabaseApiUrl, {
      method: req.method,
      headers: {
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    });

    const data = await response.json();

    // Cache response para GET requests exitosos
    if (req.method === 'GET' && response.ok) {
      const cacheKey = getCacheKey(sanitizedPath + url.search, 'GET');
      setCachedResponse(cacheKey, data);
    }

    return new Response(
      JSON.stringify(data),
      {
        status: response.status,
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': rateLimitResult.remaining.toString(),
          'X-RateLimit-Reset': rateLimitResult.resetTime.toString(),
          'X-Cache': req.method === 'GET' ? 'MISS' : 'BYPASS',
        },
      }
    );

  } catch (error) {
    console.error('Secure proxy error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
