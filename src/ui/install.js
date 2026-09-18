import { recordProductEvent } from '../product-data.js';

const DISMISSED_KEY = 'hisaab.install.dismissedUntil';
let deferredPrompt = null;

function installed() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function ios() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function dismissed() {
  try { return Number(localStorage.getItem(DISMISSED_KEY) || 0) > Date.now(); } catch (_) { return false; }
}

function dismiss() {
  try { localStorage.setItem(DISMISSED_KEY, String(Date.now() + 14 * 864e5)); } catch (_) { /* unavailable */ }
  document.querySelector('[data-install-invite]')?.remove();
  recordProductEvent('install_invite_dismissed');
}

function instructions() {
  const dialog = document.createElement('dialog');
  dialog.className = 'install-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <button class="dialog-close" value="cancel" aria-label="Close">×</button>
      <p class="eyebrow">INSTALL HISAAB</p>
      <h2>Keep it on your home screen</h2>
      <p>In Safari, tap <b>Share</b>, choose <b>Add to Home Screen</b>, turn on <b>Open as Web App</b>, then tap <b>Add</b>.</p>
      <button value="done">Got it</button>
    </form>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

export async function requestInstall() {
  if (installed()) return { installed: true };
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    recordProductEvent(choice.outcome === 'accepted' ? 'install_accepted' : 'install_prompt_dismissed');
    return choice;
  }
  instructions();
  recordProductEvent(ios() ? 'install_ios_help' : 'install_help');
  return { instructions: true };
}

function showInvite() {
  if (installed() || dismissed() || document.querySelector('[data-install-invite]')) return;
  const host = document.querySelector('#view .settings, #view > section, #view');
  if (!host) return;
  const card = document.createElement('aside');
  card.className = 'onboarding-invite install-invite';
  card.dataset.installInvite = '';
  card.innerHTML = `
    <div><b>Want Hisaab to feel like an app?</b><span>Add it to your home screen. It opens on its own and keeps working offline.</span></div>
    <div class="onboarding-invite-actions">
      <button type="button" data-install-now>Install</button>
      <button type="button" class="link" data-install-dismiss>Not now</button>
    </div>`;
  host.prepend(card);
  card.querySelector('[data-install-now]').addEventListener('click', requestInstall);
  card.querySelector('[data-install-dismiss]').addEventListener('click', dismiss);
  recordProductEvent('install_invite_shown');
}

export function startInstallExperience() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    document.querySelector('[data-install-invite]')?.remove();
    recordProductEvent('installed');
  });
  window.addEventListener('hisaab:meaningful-use', showInvite, { once: true });
}
