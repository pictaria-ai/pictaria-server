import { thumbnail } from './photos.js';

// Only retain the current image and a few neighbors. These are image reads,
// never prefetched comparison/decision scopes.
export class PreviewImages {
  constructor() {
    this.entries = new Map();
  }
  clear() {
    this.entries.clear();
  }
  get(id) {
    let entry = this.entries.get(id);
    if (entry) this.entries.delete(id);
    else {
      const image = new Image();
      image.src = thumbnail(id);
      entry = { image, ready: false, ok: false };
      entry.promise = image
        .decode()
        .then(
          () => {
            entry.ok = true;
          },
          () => {},
        )
        .then(() => {
          entry.ready = true;
          if (!entry.ok && this.entries.get(id) === entry) this.entries.delete(id);
          return entry;
        });
    }
    this.entries.set(id, entry);
    while (this.entries.size > 5) this.entries.delete(this.entries.keys().next().value);
    return entry;
  }
}
