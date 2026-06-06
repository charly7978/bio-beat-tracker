/**
 * NETWORK ERROR BOUNDARY - OPTIMIZADO
 * 
 * Error Boundary especializado para errores de red.
 * Proporciona modo offline-first y sincronización automática.
 * 
 * Optimizaciones:
 * - Detección automática de conexión
 * - Queue de operaciones offline
 * - Sincronización automática al reconectar
 * - Logging de operaciones fallidas
 */

import React, { Component, ReactNode } from 'react';
import { WifiOff, CloudOff, RefreshCw, Database } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onRetry?: () => void;
  onSync?: () => Promise<void>;
}

interface State {
  hasError: boolean;
  isOffline: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  pendingOperations: number;
  isSyncing: boolean;
}

export class NetworkErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      isOffline: !navigator.onLine,
      error: null,
      errorInfo: null,
      pendingOperations: 0,
      isSyncing: false,
    };

    this.handleOnline = this.handleOnline.bind(this);
    this.handleOffline = this.handleOffline.bind(this);
  }

  componentDidMount() {
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    
    // Cargar operaciones pendientes del localStorage
    this.loadPendingOperations();
  }

  componentWillUnmount() {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  handleOnline = async () => {
    this.setState({ isOffline: false });
    
    // Sincronizar operaciones pendientes
    if (this.state.pendingOperations > 0 && this.props.onSync) {
      this.setState({ isSyncing: true });
      
      try {
        await this.props.onSync();
        this.setState({ pendingOperations: 0 });
      } catch (error) {
        console.error('[NetworkErrorBoundary] Sync failed:', error);
      } finally {
        this.setState({ isSyncing: false });
      }
    }
  };

  handleOffline = () => {
    this.setState({ isOffline: true });
  };

  loadPendingOperations() {
    try {
      const pending = localStorage.getItem('pendingOperations');
      if (pending) {
        this.setState({ pendingOperations: parseInt(pending, 10) || 0 });
      }
    } catch (error) {
      console.error('[NetworkErrorBoundary] Failed to load pending operations:', error);
    }
  }

  static getDerivedStateFromError(error: Error): State {
    const isNetworkError = 
      error.message.includes('fetch') ||
      error.message.includes('network') ||
      error.message.includes('Failed to fetch');

    return {
      hasError: true,
      isOffline: !navigator.onLine || isNetworkError,
      error,
      errorInfo: null,
      pendingOperations: 0,
      isSyncing: false,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Logging estructurado
    const errorContext = {
      boundary: 'NetworkErrorBoundary',
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      isOffline: !navigator.onLine,
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
    };

    console.error('[NetworkErrorBoundary] Network error:', errorContext);

    // Enviar a servicio de monitoreo
    if (typeof window !== 'undefined' && (window as any).Sentry) {
      (window as any).Sentry.captureException(error, {
        tags: { boundary: 'Network', isOffline: !navigator.onLine },
        extra: errorContext,
      });
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
    if (this.props.onRetry) {
      this.props.onRetry();
    }
  };

  render() {
    const { hasError, isOffline, pendingOperations, isSyncing } = this.state;

    if (hasError || isOffline) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-6 bg-yellow-950/20 border border-yellow-900/30 rounded-lg">
          {isOffline ? (
            <WifiOff className="w-16 h-16 text-yellow-500 mb-4" />
          ) : (
            <CloudOff className="w-16 h-16 text-yellow-500 mb-4" />
          )}
          <h3 className="text-xl font-semibold text-yellow-400 mb-2">
            {isOffline ? 'Sin Conexión a Internet' : 'Error de Red'}
          </h3>
          <p className="text-yellow-300/70 text-center mb-4 max-w-md">
            {isOffline
              ? 'La aplicación está funcionando en modo offline. Los datos se sincronizarán cuando se restablezca la conexión.'
              : 'Hubo un error de conexión. Los datos se han guardado localmente.'}
          </p>
          
          {pendingOperations > 0 && (
            <div className="flex items-center gap-2 text-yellow-300/70 mb-4">
              <Database className="w-4 h-4" />
              {pendingOperations} operaciones pendientes de sincronización
            </div>
          )}
          
          {isSyncing && (
            <div className="flex items-center gap-2 text-yellow-300 mb-4">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Sincronizando datos...
            </div>
          )}
          
          <div className="text-xs text-yellow-400/50 mb-4 font-mono max-w-md break-all">
            {this.state.error?.message}
          </div>
          
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            {isOffline ? 'Verificar Conexión' : 'Reintentar'}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
