// Hover hints drawn by the page, because native `title` tooltips don't appear in the webview.
// Elements keep using `title`; it is moved to `data-tip` on first hover so both can't show.

const HOVER_DELAY_MS = 300;
const MARGIN = 6;

export function installTooltips(tip: HTMLElement, help: HTMLElement) {
  let hovered: HTMLElement | null = null;
  let shown: HTMLElement | null = null;
  let timer = 0;
  let pinned = false;

  function hintOf(el: HTMLElement): string {
    const title = el.getAttribute('title');
    if (title !== null) {
      el.dataset.tip = title;
      el.removeAttribute('title');
    }
    return el.dataset.tip ?? '';
  }

  function hide() {
    tip.classList.add('hidden');
    shown = null;
  }

  function show(el: HTMLElement) {
    const text = hintOf(el);
    if (!text) { hide(); return; }
    tip.textContent = text;
    tip.classList.remove('hidden');
    shown = el;
    const anchor = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.min(anchor.left + (anchor.width - box.width) / 2, window.innerWidth - box.width - MARGIN);
    const below = anchor.bottom + MARGIN;
    const fitsBelow = below + box.height <= window.innerHeight - MARGIN;
    tip.style.left = `${Math.max(MARGIN, left)}px`;
    tip.style.top = `${fitsBelow ? below : Math.max(MARGIN, anchor.top - box.height - MARGIN)}px`;
  }

  function setPinned(on: boolean) {
    pinned = on;
    tip.classList.toggle('pinned', on);
    help.setAttribute('aria-expanded', String(on));
  }

  document.addEventListener('mouseover', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[title],[data-tip]');
    if (el === hovered) return;
    hovered = el;
    clearTimeout(timer);
    if (pinned) return;
    hide();
    if (el === help) show(help);
    else if (el) timer = window.setTimeout(() => show(el), HOVER_DELAY_MS);
  });

  document.documentElement.addEventListener('mouseleave', () => {
    hovered = null;
    clearTimeout(timer);
    if (!pinned) hide();
  });

  // Capture phase, so clicks on the image close the panel too.
  document.addEventListener('mousedown', (e) => {
    clearTimeout(timer);
    const target = e.target as Node;
    if (pinned) {
      if (!help.contains(target) && !tip.contains(target)) { setPinned(false); hide(); }
    } else if (hovered !== help) {
      hide();
    }
  }, true);

  // Don't let a mouse click focus the button, so Space keeps controlling clip playback.
  help.addEventListener('mousedown', (e) => e.preventDefault());
  help.addEventListener('click', () => {
    setPinned(!pinned);
    if (pinned) show(help); else hide();
  });

  // Redraw the open hint after its text changes.
  return { refresh() { if (shown) show(shown); } };
}
