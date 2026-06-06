/**
 * VITAL SIGNS ERROR BOUNDARY
 * 
 * Error Boundary especializado para signos vitales.
 * Proporciona modo degradado cuando falla el cálculo de signos vitales.
 */

import React, { Component, ReactNode } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onDegradedMode?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class VitalSignsErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[VitalSignsErrorBoundary] Vital signs error:', error);
    console.error('Component stack:', errorInfo.componentStack);
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleDegradedMode = () => {
    this.handleReset();
    if (this.props.onDegradedMode) {
      this.props.onDegradedMode();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center p-6 bg-green-950/20 border border-green-900/30 rounded-lg">
          <Activity className="w-16 h-16 text-green-500 mb-4" />
          <h3 className="text-xl font-semibold text-green-400 mb-2">
            Error en Signos Vitales
          </h3>
          <p className="text-green-300/70 text-center mb-4 max-w-md">
            El cálculo de signos vitales ha encontrado un error.
            Puede continuar en modo degradado (solo frecuencia cardíaca).
          </p>
          <div className="text-xs text-green-400/50 mb-4 font-mono">
            {this.state.error?.message}
          </div>
          <div className="flex gap-3">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reintentar
            </button>
            {this.props.onDegradedMode && (
              <button
                onClick={this.handleDegradedMode}
                className="flex items-center gap-2 px-4 py-2 bg-green-800 hover:bg-green-900 text-white rounded-lg transition-colors"
              >
                <AlertTriangle className="w-4 h-4" />
                Modo Degradado
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
