import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="max-w-md w-full card-base p-6">
            {/* Header */}
            <div className="text-center mb-6">
              <div className="mx-auto mb-4 h-16 w-16 rounded-xl bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="h-8 w-8 text-destructive" />
              </div>
              <h1 className="text-xl font-semibold text-foreground mb-2">
                Algo salió mal
              </h1>
              <p className="text-sm text-muted-foreground">
                Ha ocurrido un error inesperado. No te preocupes, puedes intentar de nuevo.
              </p>
            </div>

            {/* Error details (development only) */}
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <div className="mb-6 rounded-lg bg-secondary/50 border border-border p-4 overflow-auto max-h-40">
                <p className="text-xs font-mono text-destructive font-medium mb-2">
                  {this.state.error.message}
                </p>
                {this.state.errorInfo && (
                  <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                    {this.state.errorInfo.componentStack?.slice(0, 500)}
                  </pre>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="space-y-3">
              <button
                onClick={this.handleRetry}
                className="btn-primary w-full"
              >
                <RefreshCw className="h-4 w-4" />
                Reintentar
              </button>
              
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={this.handleGoHome}
                  className="btn-secondary"
                >
                  <Home className="h-4 w-4" />
                  Ir al inicio
                </button>
                <button
                  onClick={this.handleReload}
                  className="btn-ghost border border-border"
                >
                  Recargar página
                </button>
              </div>
            </div>

            {/* Help text */}
            <p className="text-xs text-muted-foreground text-center mt-6">
              Si el problema persiste, contacta a soporte.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
