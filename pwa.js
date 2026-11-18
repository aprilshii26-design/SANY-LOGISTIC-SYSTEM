/* SANY PWA bootstrap - presentation/install support only. */
(() => {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' })
      .then(registration => {
        // Keep the current session stable; activate updates on a later safe reload.
        registration.update().catch(() => {});
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('sany:pwa-update-ready'));
            }
          });
        });
      })
      .catch(error => console.warn('[SANY PWA] Service worker registration failed:', error));
  });

  // Installation prompt is exposed for a future UI button; no unsolicited prompt.
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    window.dispatchEvent(new CustomEvent('sany:pwa-install-available'));
  });
  window.sanyPWA = {
    canInstall: () => Boolean(installPrompt),
    promptInstall: async () => {
      if (!installPrompt) return { outcome: 'unavailable' };
      const promptEvent = installPrompt;
      installPrompt = null;
      await promptEvent.prompt();
      return await promptEvent.userChoice;
    }
  };
})();
