// Applies the saved theme before first paint. Load this synchronously in
// <head> (no defer/async) on every page so the selected theme never flashes.
(() => {
  const saved = localStorage.getItem('pictariaTheme');
  document.documentElement.dataset.theme = saved === 'dark' ? 'dark' : 'light';

  window.pictariaTheme = {
    get() {
      return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    },
    set(theme) {
      const next = theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('pictariaTheme', next);
    },
  };
})();
