'use strict';
document.getElementById('x').onclick = () => {
  window.api.setFullscreen(false);
  window.api.requestStop();
};
