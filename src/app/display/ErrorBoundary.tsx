import { Component, type ErrorInfo, type ReactNode } from 'react';

import { createLogger } from '../../lib/log';

const log = createLogger('display/boundary');

interface Props {
  children: ReactNode;
  fallback(error: Error): ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The display page runs unattended for weeks on a screen nobody watches. An
 * uncaught render error must degrade to a readable card, never to a black
 * panel that looks like dead hardware.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error(error.message, info.componentStack ?? '');
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : this.props.fallback(error);
  }
}
