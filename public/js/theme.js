// Applies the saved theme before first paint (loaded as a classic script in <head>).
(function () {
  var theme = null;
  try {
    theme = JSON.parse(window.localStorage.getItem('collab-kanban:pref:theme'));
  } catch (e) {
    theme = null;
  }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
})();
