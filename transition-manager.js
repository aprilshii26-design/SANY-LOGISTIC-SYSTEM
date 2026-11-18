/* Observe only direct page replacement inside <main>; does not modify application workflows. */
(() => {
  'use strict';
  const main = document.querySelector('main.container');
  if (!main || !('MutationObserver' in window)) return;

  let frame = 0;
  const animatePage = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      main.classList.remove('sany-page-enter');
      // Force a single style recalculation to restart the page-entry animation.
      void main.offsetWidth;
      main.classList.add('sany-page-enter');
    });
  };

  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList' && record.target === main)) {
      animatePage();
    }
  });
  observer.observe(main, { childList: true });
  window.addEventListener('pageshow', event => { if (event.persisted) animatePage(); });
})();
