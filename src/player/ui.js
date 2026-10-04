// Video Fit Toggle
const fitModes = ['object-cover', 'object-contain', 'object-fill'];
const fitLabels = { 'object-cover': 'Cover', 'object-contain': 'Contain', 'object-fill': 'Fill' };
let fitIndex = 0;

const fitButton = document.getElementById('fit-button');

fitButton.addEventListener('click', () => {
  video.classList.remove(fitModes[fitIndex]);
  fitIndex = (fitIndex + 1) % fitModes.length;
  const newMode = fitModes[fitIndex];
  video.classList.add(newMode);
  showToast(`Fit: ${fitLabels[newMode]}`);
});

function showToast(msg) {
  let toast = document.getElementById('fit-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fit-toast';
    toast.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;padding:6px 16px;border-radius:6px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity 0.3s;';
    document.getElementById('video-container').appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.style.opacity = '0', 1500);
}

// Block context-menu and common DevTools shortcuts.
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (
    e.key === 'F12' ||
    (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key)) ||
    (e.ctrlKey && e.key === 'U')
  ) {
    e.preventDefault();
  }
});
