'use strict';

try {
  document.documentElement.dataset.theme = localStorage.getItem('setscope-theme') === 'dark' ? 'dark' : 'light';
} catch (_) {
  document.documentElement.dataset.theme = 'light';
}
