// Shared hover/focus/tap overlays, kept inside the active dialog's top layer.
// Content is constructed with textContent; model explanations are never HTML.
export function textTooltip(label, title, text, id) {
  const wrap = document.createElement('span'); wrap.className = 'why-tooltip';
  const trigger = document.createElement('button'); trigger.className = 'why-trigger';
  trigger.type = 'button'; trigger.textContent = label;
  trigger.setAttribute('aria-label', title);
  trigger.setAttribute('aria-describedby', id);
  trigger.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div'); panel.className = 'why-content';
  panel.id = id; panel.hidden = true;
  const heading = document.createElement('strong'); heading.textContent = title;
  const copy = document.createElement('p'); copy.textContent = text;
  panel.append(heading, copy);
  attachTooltip(wrap, trigger, panel);
  wrap.append(trigger, panel);
  return wrap;
}

export function attachTooltip(wrap, trigger, panel) {
  installListeners();
  let pinned = false;
  wrap.dismiss = () => {
    panel.hidden = true;
    pinned = false;
    trigger.setAttribute('aria-expanded', 'false');
  };
  const show = () => {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect(),
      width = panel.offsetWidth,
      height = panel.offsetHeight;
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, rect.bottom + height > innerHeight - 12 ? rect.top - height : rect.bottom)}px`;
  };
  wrap.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') show();
  });
  wrap.addEventListener('pointerleave', () => {
    if (!pinned && !wrap.contains(document.activeElement)) wrap.dismiss();
  });
  trigger.addEventListener('focus', show);
  wrap.addEventListener('focusout', (event) => {
    if (!wrap.contains(event.relatedTarget)) wrap.dismiss();
  });
  trigger.onclick = () => {
    if (pinned) wrap.dismiss();
    else {
      pinned = true;
      show();
    }
  };
}
function dismissAll(event) {
  for (const tooltip of document.querySelectorAll('.why-tooltip')) {
    if (event?.target instanceof Node && tooltip.contains(event.target)) continue;
    tooltip.dismiss();
  }
}
let listenersInstalled = false;
function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  document.addEventListener('pointerdown', dismissAll);
  document.addEventListener('scroll', dismissAll, true);
  window.addEventListener('resize', dismissAll);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !document.querySelector('.why-content:not([hidden])')) return;
      dismissAll();
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}
