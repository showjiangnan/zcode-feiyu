interface AppLaunchGateLike {
  consume(): boolean;
}

interface RendererReadyInput {
  hasPendingOAuthCallback: boolean;
  rendererId: number;
}

interface OAuthCallbackHandledInput {
  rendererId: number;
}

export function createAppLaunchCoordinator(appLaunchGate: AppLaunchGateLike) {
  let waitingRendererId: number | null = null;

  return {
    onRendererReady({ hasPendingOAuthCallback, rendererId }: RendererReadyInput): boolean {
      if (hasPendingOAuthCallback) {
        waitingRendererId = rendererId;
        return false;
      }

      if (waitingRendererId !== null) {
        return false;
      }

      return appLaunchGate.consume();
    },

    onOAuthCallbackHandled({ rendererId }: OAuthCallbackHandledInput): boolean {
      if (waitingRendererId == null || waitingRendererId !== rendererId) {
        return false;
      }

      waitingRendererId = null;
      return appLaunchGate.consume();
    },
  };
}
