// Size each comparison row to its tallest photo, capped by CSS to leave
// room for the header, decisions and footer. Loading and resizing never crop.
export function fitPhotoRows(grid) {
  let frame;
  const layout = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const rows = new Map();
      for (const card of grid.children) {
        const image = card.querySelector('.photo-image img');
        if (!image || !card.offsetWidth) continue;
        const top = card.offsetTop;
        if (!rows.has(top)) rows.set(top, []);
        rows.get(top).push(image);
      }
      for (const images of rows.values()) {
        const height = Math.max(...images.map(image => image.clientWidth /
          (image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1)));
        for (const image of images) image.style.setProperty('--photo-height', `${Math.round(height)}px`);
      }
    });
  };
  let width = 0;
  new ResizeObserver(entries => {
    const next = entries[0].contentRect.width;
    if (next !== width) { width = next; layout(); }
  }).observe(grid);
  grid.addEventListener('load', layout, true);
  window.addEventListener('resize', layout);
  return layout;
}
