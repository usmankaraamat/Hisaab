const ONBOARDING_KEY = 'hisaab.onboarding.v1';

const STEPS = [
  {
    eyebrow: 'Start here',
    title: 'Log money in one line',
    body: 'Type what happened and the amount, like “chicken 900”. Hisaab shows what it understood before anything is saved. Switch to Received when money came in.',
    example: 'chicken 900',
  },
  {
    eyebrow: 'Make the numbers useful',
    title: 'Add the money you have now',
    body: 'In Settings, open Balances & budget. Essential is the money you normally spend from; Other is money you are keeping aside. If you use one account, put its full balance in Essential and enter 0 for Other.',
  },
  {
    eyebrow: 'Shared spending',
    title: 'Say who the expense was for',
    body: 'Type the names in the same line. Hisaab splits the amount and the Ledger keeps track of who owes whom. Log a reimbursement when somebody pays you back.',
    example: 'cake for tom, dick, harry 2500',
  },
  {
    eyebrow: 'Your pace',
    title: 'Use safe to spend as a guide',
    body: 'Hisaab works out a daily amount from your balance, savings target, and money you owe. It is a guide for the rest of the period, not a warning that you have done something wrong.',
  },
  {
    eyebrow: 'Across devices',
    title: 'Sign in only if you want sync',
    body: 'The app saves entries on this device first, so ordinary logging still works offline. Sign in with the same email on another device when you want both copies to sync. Smart categorisation can wait until you are online.',
  },
];

const SETTINGS_HELP = {
  'Account & sync': {
    intro: 'Use this when you want the same Hisaab data on more than one device.',
    items: [
      '<b>Sign in:</b> enter your email and open the secure link Hisaab sends you. Use the same email everywhere.',
      '<b>Sync:</b> entries save on the device first and upload when you are online. You can keep using capture without signing in.',
      '<b>Good first setup:</b> sign in if you use multiple devices; otherwise it is fine to leave this alone.',
    ],
  },
  'Smart capture': {
    intro: 'These shortcuts tidy or import entries. Normal manual capture does not depend on them.',
    items: [
      '<b>AI categorisation:</b> Hisaab includes up to five hosted categorisation runs a day. Add your own Gemini key only if you regularly need more; it stays on this device.',
      '<b>Payment notification import:</b> an advanced setup for forwarding bank or wallet notifications from an Android automation app. “Paste a message” on the Add screen is the easier option.',
      '<b>Good first setup:</b> leave both options alone. Add them later if manual categories or pasted messages start feeling repetitive.',
    ],
  },
  Appearance: {
    intro: 'Choose the colour used for actions and links on this device.',
    items: [
      '<b>Accent colour:</b> tap any swatch to preview it immediately. This is only a visual preference and does not change your data.',
    ],
  },
  'Balances & budget': {
    intro: 'This is what turns a list of expenses into a useful “safe to spend” number.',
    items: [
      '<b>Current balances:</b> Essential is money available for everyday use; Other is money you are keeping aside. With one account, put the full amount in Essential and 0 in Other.',
      '<b>Monthly spending setup:</b> the opening balance is the older one-balance option. Once current balances are set, you only need the savings target here.',
      '<b>Savings target:</b> how much you want Hisaab to protect each period before it works out your daily allowance.',
      '<b>Savings goal:</b> a named long-term target, such as a laptop. It tracks money you explicitly log as savings.',
      '<b>Category limits:</b> optional monthly caps. Leave a category blank when you do not want a limit.',
    ],
  },
  'Recurring payments': {
    intro: 'Add money that repeats so Hisaab can remind you when it is due.',
    items: [
      '<b>Name and amount:</b> use the amount you normally expect; you can correct the final entry when you confirm it.',
      '<b>Spent or Received:</b> choose Spent for bills and Received for salary or other regular income.',
      '<b>Next due:</b> enter the next occurrence, then choose weekly, fortnightly, or monthly.',
      '<b>Good first setup:</b> add rent, subscriptions, and salary. Skip irregular purchases.',
    ],
  },
  'Automatic categories': {
    intro: 'Rules file familiar names the same way every time, without using AI.',
    items: [
      '<b>Match text:</b> enter a stable part of the name, such as “indrive”, and choose its category.',
      '<b>Remember from History:</b> fixing a category there can create the same kind of rule for you.',
      '<b>Good first setup:</b> wait until Hisaab misfiles something you buy often, then add a rule for it.',
    ],
  },
  'Backup & corrections': {
    intro: 'Use these tools when the app and real life no longer match, or when you want a copy of your data.',
    items: [
      '<b>Correct a balance:</b> enter what you actually have. Hisaab records the difference so your history still adds up.',
      '<b>Import from Bluecoins:</b> choose a Bluecoins CSV. Importing the same file again will not duplicate it.',
      '<b>Download a backup:</b> exports a CSV you can keep or open elsewhere.',
      '<b>Data on this device:</b> shows how many entries and events are stored locally.',
    ],
  },
  Reset: {
    intro: 'This is for starting over on the current device.',
    items: [
      '<b>Erase local data:</b> removes every local transaction and event. Download a backup first if you may want them later.',
    ],
  },
};

function markSeen() {
  localStorage.setItem(ONBOARDING_KEY, 'seen');
}

export function openOnboarding({ returnFocus = document.activeElement } = {}) {
  markSeen();
  document.querySelector('.onboarding-dialog')?.remove();

  const dialog = document.createElement('dialog');
  dialog.className = 'onboarding-dialog';
  dialog.setAttribute('aria-labelledby', 'onboarding-title');
  dialog.innerHTML = `
    <div class="onboarding-panel">
      <div class="onboarding-topline">
        <span class="onboarding-count" aria-live="polite"></span>
        <button type="button" class="onboarding-close" aria-label="Close guide">Close</button>
      </div>
      <div class="onboarding-copy">
        <span class="onboarding-eyebrow"></span>
        <h2 id="onboarding-title"></h2>
        <p class="onboarding-body"></p>
        <code class="onboarding-example" hidden></code>
      </div>
      <div class="onboarding-actions">
        <button type="button" class="onboarding-back">Back</button>
        <button type="button" class="onboarding-next">Next</button>
      </div>
    </div>`;

  let index = 0;
  const count = dialog.querySelector('.onboarding-count');
  const eyebrow = dialog.querySelector('.onboarding-eyebrow');
  const title = dialog.querySelector('#onboarding-title');
  const body = dialog.querySelector('.onboarding-body');
  const example = dialog.querySelector('.onboarding-example');
  const back = dialog.querySelector('.onboarding-back');
  const next = dialog.querySelector('.onboarding-next');

  function render() {
    const step = STEPS[index];
    count.textContent = `${index + 1} of ${STEPS.length}`;
    eyebrow.textContent = step.eyebrow;
    title.textContent = step.title;
    body.textContent = step.body;
    example.hidden = !step.example;
    example.textContent = step.example || '';
    back.disabled = index === 0;
    next.textContent = index === STEPS.length - 1 ? 'Done' : 'Next';
  }

  function close() {
    dialog.close();
  }

  back.addEventListener('click', () => {
    if (index > 0) index -= 1;
    render();
  });
  next.addEventListener('click', () => {
    if (index === STEPS.length - 1) close();
    else {
      index += 1;
      render();
    }
  });
  dialog.querySelector('.onboarding-close').addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  });

  document.body.append(dialog);
  render();
  dialog.showModal();
  next.focus();
}

export function maybeOfferOnboarding(root) {
  if (localStorage.getItem(ONBOARDING_KEY)) return;
  const capture = root.querySelector('.capture');
  const composer = capture?.querySelector('.capture-composer');
  if (!capture || !composer) return;

  const invite = document.createElement('aside');
  invite.className = 'onboarding-invite';
  invite.setAttribute('aria-label', 'Getting started');
  invite.innerHTML = `
    <div>
      <b>New here?</b>
      <span>Take a two-minute tour. No finance vocabulary required.</span>
    </div>
    <div class="onboarding-invite-actions">
      <button type="button" class="link" data-guide-start>Show me</button>
      <button type="button" class="link" data-guide-dismiss>Not now</button>
    </div>`;

  invite.querySelector('[data-guide-start]').addEventListener('click', (event) => {
    openOnboarding({ returnFocus: event.currentTarget });
    invite.remove();
  });
  invite.querySelector('[data-guide-dismiss]').addEventListener('click', () => {
    markSeen();
    invite.remove();
  });
  composer.after(invite);
}

export function createSettingsHelp(title) {
  const content = SETTINGS_HELP[title];
  if (!content) return null;
  const details = document.createElement('details');
  details.className = 'settings-help';
  details.innerHTML = `
    <summary>How to set this up</summary>
    <div class="settings-help-body">
      <p>${content.intro}</p>
      <ul>${content.items.map((item) => `<li>${item}</li>`).join('')}</ul>
    </div>`;
  return details;
}
