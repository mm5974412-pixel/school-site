// Theme toggle handler (safe to load with `defer`)
(function () {
  function updateButton(btn) {
    if (!btn) return;
    if (document.body.classList.contains('light')) {
      btn.textContent = '☀️';
      btn.classList.add('sun');
      btn.setAttribute('aria-label', 'Светлая тема');
    } else {
      btn.textContent = '🌙';
      btn.classList.remove('sun');
      btn.setAttribute('aria-label', 'Тёмная тема');
    }
  }

  function init() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;

    // Установить начальное состояние кнопки
    updateButton(btn);

    btn.addEventListener('click', function () {
      if (document.body.classList.contains('light')) {
        document.body.classList.remove('light');
        localStorage.setItem('theme', 'dark');
      } else {
        document.body.classList.add('light');
        localStorage.setItem('theme', 'light');
      }
      updateButton(btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
