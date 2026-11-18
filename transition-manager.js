/* SANY Global Page Transition Manager V2
   Watches only direct page replacement inside main.container.
   No application/business logic is modified.
*/
(() => {
  'use strict';

  const main = document.querySelector('main.container');
  if (!main || !('MutationObserver' in window)) return;

  let frameId = 0;
  let lastRun = 0;

  const animatePage = () => {
    if (window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      main.classList.remove('sany-page-enter');
      return;
    }

    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(() => {
      // Avoid replaying the same animation for several DOM writes in one frame.
      const now = performance.now();
      if (now - lastRun < 40) return;
      lastRun = now;

      main.classList.remove('sany-page-enter');
      void main.offsetWidth;
      main.classList.add('sany-page-enter');
    });
  };

  const observer = new MutationObserver(records => {
    const pageWasReplaced = records.some(record =>
      record.type === 'childList' && record.target === main
    );

    if (pageWasReplaced) animatePage();
  });

  observer.observe(main, { childList: true });

  window.addEventListener('pageshow', event => {
    if (event.persisted) animatePage();
  });

  // Handle a page that was already rendered before this manager initialized.
  if (main.children.length) animatePage();
})();
