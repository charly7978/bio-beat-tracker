/**
 * CAMERA ERROR BOUNDARY - OPTIMIZADO
 * 
 * Error Boundary especializado para la cámara.
 * Proporciona fallback a cámara alternativa o modo degradado.
 * 
 * Optimizaciones:
 * - Detección de permisos denegados
 * - Auto-reintento con backoff
 * - Logging estructurado
 * - Detección de tipo de error (permisos, hardware, etc.)
 */

import React, { Component, ReactNode } from 'react';
import { Camera, AlertCircle, RefreshCw, ShieldAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onRetry?: () => void;
  onAlternativeCamera?: () => void;
  maxRetries?: number;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  errorType: 'permission' | 'hardware' | 'unknown';
  retryCount: number;
  isRetrying: boolean;
}

export class CameraErrorBoundary extends Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorType: 'unknown',
      retryCount: 0,
      isRetrying: false,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
      errorType: 'unknown',
      retryCount: 0,
      isRetrying: false,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Detectar tipo de error
    let errorType: 'permission' | 'hardware' | 'unknown' = 'unknown';
    
    if (error.name === 'NotAllowedError' || error.message.includes('permission')) {
      errorType = 'permission';
    } else if (error.name === 'NotFoundError' || error.message.includes('device')) {
      errorType = 'hardware';
    }

    // Logging estructurado
    const errorContext = {
      boundary: 'CameraErrorBoundary',
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      errorType,
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
      retryCount: this.state.retryCount,
    };

    console.error('[CameraErrorBoundary] Camera error:', errorContext);

    // Enviar a servicio de monitoreo
    if (typeof window !== 'undefined' && (window as any).Sentry) {
      (window as any).Sentry.captureException(error, {
        tags: { boundary: 'Camera', errorType },
        extra: errorContext,
      });
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      errorType: 'unknown',
      retryCount: 0,
      isRetrying: false,
    });
    if (this.props.onRetry) {
      this.props.onRetry();
    }
  };

  handleRetry = () => {
    const maxRetries = this.props.maxRetries || 3;
    
    if (this.state.retryCount >= maxRetries) {
      return;
    }

    this.setState({ isRetrying: true });

    const delay = 1000 * Math.pow(2, this.state.retryCount);
    
    this.retryTimer = setTimeout(() => {
      this.setState({
        hasError: false,
        error: null,
        errorInfo: null,
        retryCount: this.state.retryCount + 1,
        isRetrying: false,
      });
      
      if (this.props.onRetry) {
        this.props.onRetry();
      }
    }, delay);
  };

  handleAlternativeCamera = () => {
    this.handleReset();
    if (this.props.onAlternativeCamera) {
      this.props.onAlternativeCamera();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isPermissionError = this.state.errorType === 'permission';
      const isHardwareError = this.state.errorType === 'hardware';
      const maxRetries = this.props.maxRetries || 3;
      const canRetry = this.state.retryCount < maxRetries;

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-6 bg-blue-950/20 border border-blue-900/30 rounded-lg">
          {isPermissionError ? (
            <ShieldAlert className="w-16 h-16 text-blue-500 mb-4" />
          ) : (
            <Camera className="w-16 h-16 text-blue-500 mb-4" />
          )}
          <h3 className="text-xl font-semibold text-blue-400 mb-2">
            {isPermissionError ? 'Permisos de Cámara Denegados' : 'Error de Cámara'}
          </h3>
          <p className="text-blue-300/70 text-center mb-4 max-w-md">
            {isPermissionError
              ? 'La aplicación necesita permisos para acceder a la cámara. Por favor, habilite los permisos en la configuración del navegador.'
              : isHardwareError
              ? 'No se detectó ninguna cámara en el dispositivo.'
              : 'No se pudo acceder a la cámara. Intente reiniciar o usar una cámara alternativa.'}
          </p>
          <div className="text-xs text-blue-400/50 mb-4 font-mono max-w-md break-all">
            {this.state.error?.message}
          </div>
          <div className="text-xs text-blue-400/30 mb-4">
            Intento {this.state.retryCount} de {maxRetries}
          </div>
          
          {this.state.isRetrying ? (
            <div className="flex items-center gap-2 text-blue-300">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Reintentando...
            </div>
          ) : (
            <div className="flex gap-3">
              {!isPermissionError && canRetry && (
                <button
                  onClick={this.handleRetry}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Reintentar
                </button>
              )}
              {this.props.onAlternativeCamera && (
                <button
                  onClick={this.handleAlternativeCamera}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-800 hover:bg-blue-900 text-white rounded-lg transition-colors"
                >
                  <AlertCircle className="w-4 h-4" />
                  Cámara Alternativa
                </button>
              )}
              <button
                onClick={this.handleReset}
                className="flex items-center gap-2 px-4 py-2 bg-blue-800 hover:bg-blue-900 text-white rounded-lg transition-colors"
              >
                Reiniciar Manual
              </button>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
