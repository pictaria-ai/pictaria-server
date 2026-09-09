// Settings manages profiles in a dialog; Enrich owns the active selection.
window.createEnrichProfileManager = function ({ api, toast }) {
  const el = id => document.getElementById(id);
  const fieldIds = ['profileName', 'profileSystem', 'profileUser', 'profileTaxonomy'];
  let profiles = [], editing = null, baseline = '', createBaseline = '', busy = false, focusId = null;
  const fields = () => ({ name: el('profileName').value, systemPrompt: el('profileSystem').value,
    userTemplate: el('profileUser').value, taxonomy: el('profileTaxonomy').value });
  const createFields = () => JSON.stringify([el('profileCreateName').value, el('profileSource').value]);
  const dirty = () => !el('profileEditor').hidden ? !editing || JSON.stringify(fields()) !== baseline
    : !el('profileCreate').hidden && createFields() !== createBaseline;
  const request = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const node = (tag, text, className) => Object.assign(document.createElement(tag), { textContent: text ?? '', className: className ?? '' });
  const note = message => { el('profileEditorNote').textContent = message; };
  const focus = id => { if (busy) focusId = id; else el(id).focus(); };
  const action = fn => async () => {
    if (busy) return;
    busy = true;
    for (const id of ['profileListControls', 'profileEditorControls', 'profileCreateControls']) el(id).disabled = true;
    try { await fn(); } catch (error) { toast(error.message, true); }
    finally {
      busy = false;
      for (const id of ['profileListControls', 'profileEditorControls', 'profileCreateControls']) el(id).disabled = false;
      if (focusId) { el(focusId).focus(); focusId = null; }
    }
  };
  function view(id) {
    for (const name of ['profileEditor', 'profileCreate']) el(name).hidden = name !== id;
    if (id === 'profileLibrary') el('profileDialog').close();
    else if (!el('profileDialog').open) el('profileDialog').showModal();
    el('profileStatus').textContent = '';
  }
  function remember(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('profile', id); else url.searchParams.delete('profile');
    history.replaceState(null, '', url);
  }
  let discardResolve = null;
  async function discard() {
    if (!dirty()) return true;
    return new Promise(resolve => {
      discardResolve = resolve;
      el('profileDiscardDialog').hidden = false;
      el('profileEditor').inert = el('profileCreate').inert = true;
      el('profileKeepEditing').focus();
    });
  }
  function finishDiscard(confirmed) {
    const resolve = discardResolve; discardResolve = null;
    el('profileDiscardDialog').hidden = true;
    el('profileEditor').inert = el('profileCreate').inert = false;
    if (!confirmed) focus(el('profileEditor').hidden ? 'profileCreateName' : 'profileName');
    resolve?.(confirmed);
  }
  function updateDirty() {
    el('profileDirty').textContent = dirty() ? 'Unsaved changes' : `Saved · revision ${editing?.revision ?? 1}`;
    el('profileClose').textContent = 'Cancel';
  }
  function clearErrors() {
    for (const id of fieldIds) { el(id + 'Error').textContent = ''; el(id).removeAttribute('aria-invalid'); }
  }
  function fieldError(id, message) {
    el(id + 'Error').textContent = message; el(id).setAttribute('aria-invalid', 'true');
    if (id === 'profileTaxonomy') el('profileTaxonomyDetails').open = true;
    focus(id); note('Check the highlighted field before saving.');
  }
  function taxonomySummary() {
    const summary = el('profileTaxonomySummary'); summary.replaceChildren();
    try {
      const taxonomy = JSON.parse(el('profileTaxonomy').value);
      const categories = Object.entries(taxonomy.categories ?? {}).filter(([, tags]) => Array.isArray(tags));
      const count = categories.reduce((sum, [, tags]) => sum + tags.length, 0);
      summary.append(node('p', `${count} tags in ${categories.length} categories`, 'setting-desc'));
      for (const [category, tags] of categories) {
        const row = document.createElement('details'); row.className = 'profile-category';
        row.append(node('summary', `${category} · ${tags.length} tags`));
        const list = node('div', '', 'profile-tags');
        for (const tag of tags) {
          const chip = node('span', typeof tag === 'string' ? tag : tag?.tag, 'profile-tag');
          chip.title = tag?.description ?? ''; list.append(chip);
        }
        row.append(list); summary.append(row);
      }
    } catch { summary.append(node('p', 'Fix the taxonomy JSON to preview its tags.', 'setting-desc')); }
  }
  function show(value, existing = null, afterSave = false) {
    editing = existing;
    el('profileName').value = value.name;
    el('profileSystem').value = value.systemPrompt;
    el('profileUser').value = value.userTemplate;
    el('profileTaxonomy').value = JSON.stringify(value.taxonomy, null, 2);
    baseline = JSON.stringify(fields());
    el('profileEditorTitle').textContent = existing ? `Edit ${value.name}` : 'New profile';
    el('profileSave').textContent = existing ? 'Save changes' : 'Create profile';
    if (!afterSave) el('profileTaxonomyDetails').open = false;
    clearErrors(); note(''); taxonomySummary(); view('profileEditor'); updateDirty();
    if (existing) {
      remember(existing.id);
    }
    if (!afterSave) focus('profileName');
  }
  async function open(id) {
    const value = await api(`/api/enrich/profiles/${id}`);
    if (value.archived) throw new Error('That profile is archived. Restore it below before editing.');
    show(value, value);
  }
  function startCreate(source = '') {
    const active = profiles.filter(p => !p.archived);
    el('profileSource').replaceChildren(new Option('Pictaria templates', ''), ...active.map(p => new Option(`Copy of ${p.name}`, p.id)));
    el('profileSource').value = source;
    el('profileCreateName').value = source ? `${active.find(p => p.id === source).name} copy`.slice(0, 80) : '';
    el('profileCreateError').textContent = '';
    el('profileEditorTitle').textContent = 'New profile'; el('profileDirty').textContent = '';
    createBaseline = createFields(); view('profileCreate'); remember(null); focus('profileCreateName');
  }
  function button(text, kind, profile, fn) {
    const b = node('button', text, 'p-btn quiet'); b.type = 'button'; b.dataset.action = kind; b.dataset.profileId = profile.id;
    b.addEventListener('click', action(fn)); return b;
  }
  async function loadList() {
    const data = await api('/api/enrich/profiles'); profiles = data.profiles;
    const list = el('profileList'), archived = el('profileArchivedList'); list.replaceChildren(); archived.replaceChildren();
    for (const p of profiles) {
      const row = node('div', '', 'profile-row'); row.dataset.profileId = p.id;
      row.append(node('strong', p.name, 'profile-row-name'));
      if (p.archived) row.append(button('Restore', 'restore', p, async () => {
        await request(`/api/enrich/profiles/${p.id}/archive`, 'POST', { archived: false }); await loadList(); toast(`${p.name} restored.`);
      }));
      else {
        if (p.isActive) row.append(node('span', 'Active', 'p-chip'));
        row.append(button('Edit', 'edit', p, () => open(p.id)));
        const menu = node('details', '', 'profile-menu'); const summary = node('summary', '⋯', 'p-btn quiet');
        summary.setAttribute('aria-label', `More actions for ${p.name}`); menu.append(summary);
        const actions = node('div', '', 'profile-menu-actions');
        actions.append(button('Duplicate', 'duplicate', p, () => startCreate(p.id)));
        if (!p.isActive) {
          actions.append(button('Archive', 'archive', p, async () => {
            await request(`/api/enrich/profiles/${p.id}/archive`, 'POST', { archived: true }); await loadList(); toast(`${p.name} archived. Saved run history is retained.`);
          }));
        }
        menu.append(actions); row.append(menu);
      }
      (p.archived ? archived : list).append(row);
    }
    const count = profiles.filter(p => p.archived).length;
    el('profileArchivedSection').hidden = !count;
    el('profileArchivedSummary').textContent = `Archived profiles (${count})`;
    el('profileNote').textContent = `${profiles.find(p => p.isActive)?.name} is active for new Enrich work. Browsing or editing a profile does not activate it.`;
  }
  async function back() {
    if (!await discard()) return;
    view('profileLibrary'); remember(null); await loadList(); focus('profileNew');
  }
  async function validate() {
    clearErrors(); const value = fields();
    for (const [key, id, name, limit] of [['name','profileName','Profile name',80], ['systemPrompt','profileSystem','General instructions',20000], ['userTemplate','profileUser','Photo request template',20000]]) {
      if (!value[key].trim() || value[key].length > limit) { fieldError(id, `${name} must contain 1–${limit.toLocaleString()} characters.`); return false; }
    }
    if (!value.userTemplate.includes('{approved_tags}')) { fieldError('profileUser', 'Include {approved_tags}; Pictaria replaces it with the allowed tag list.'); return false; }
    try { JSON.parse(value.taxonomy); } catch { fieldError('profileTaxonomy', 'Enter valid JSON. Check commas, quotes, and brackets.'); return false; }
    try { await request('/api/enrich/profiles/validate', 'POST', value); }
    catch (error) {
      if (error.status !== 400) throw error;
      fieldError('profileTaxonomy', error.message); return false;
    }
    return true;
  }
  el('profileNew').addEventListener('click', action(() => startCreate()));
  el('profileClose').addEventListener('click', action(back));
  el('profileBack').addEventListener('click', action(back));
  el('profileCreateCancel').addEventListener('click', action(back));
  el('profileCreateForm').addEventListener('submit', event => { event.preventDefault(); void action(async () => {
    const name = el('profileCreateName').value.trim();
    if (!name || name.length > 80) { el('profileCreateError').textContent = 'Give the profile a name of 1–80 characters.'; return; }
    const source = el('profileSource').value;
    const value = await api(source ? `/api/enrich/profiles/${source}` : '/api/enrich/profiles/builtin');
    show({ ...value, name });
  })(); });
  el('profileValidate').addEventListener('click', action(async () => {
    if (await validate()) note('Configuration is valid. This checks format and required fields; no photos were sent to a model.');
  }));
  el('profileEditorForm').addEventListener('submit', event => { event.preventDefault(); void action(async () => {
    if (!await validate()) return;
    try {
      const value = await request(editing ? `/api/enrich/profiles/${editing.id}` : '/api/enrich/profiles', editing ? 'PATCH' : 'POST',
        { ...fields(), expectedRevisionId: editing?.revisionId });
      editing = value; baseline = JSON.stringify(fields());
      view('profileLibrary'); remember(null); await loadList();
      el('profileStatus').textContent = `Saved ${value.name}.`; focus('profileNew');
    } catch (error) { note(error.message); }
  })(); });
  for (const id of fieldIds) el(id).addEventListener('input', () => {
    el(id + 'Error').textContent = ''; el(id).removeAttribute('aria-invalid'); note(''); updateDirty();
    if (id === 'profileTaxonomy') taxonomySummary();
  });
  el('profileKeepEditing').addEventListener('click', () => finishDiscard(false));
  el('profileDiscard').addEventListener('click', () => finishDiscard(true));
  el('profileDialog').addEventListener('cancel', event => {
    event.preventDefault();
    if (discardResolve) finishDiscard(false); else void action(back)();
  });
  el('profileList').addEventListener('click', event => {
    for (const menu of el('profileList').querySelectorAll('.profile-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.profile-menu')) {
      for (const menu of el('profileList').querySelectorAll('.profile-menu[open]')) menu.open = false;
    }
  });
  el('profileList').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const menu = event.target.closest('.profile-menu');
      if (menu?.open) { menu.open = false; menu.querySelector('summary').focus(); }
    }
  });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('click', async event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === '_blank' || link.hasAttribute('download')) return;
    const url = new URL(link.href); const current = new URL(location.href);
    if (url.origin === current.origin && url.pathname === current.pathname && url.search === current.search && url.hash === current.hash) return;
    if (el('profileDialog').open && !dirty() && !busy) { view('profileLibrary'); remember(null); }
    if (busy) { event.preventDefault(); toast('Please wait for the profile operation to finish.'); return; }
    if (!dirty()) return;
    event.preventDefault();
    if (await discard()) { view('profileLibrary'); location.assign(link.href); }
  });
  return { async load() {
    await loadList();
    const requested = new URLSearchParams(location.search).get('profile');
    if (requested) {
      el('sec-enrichment-profiles').open = true;
      if (!profiles.some(p => p.id === requested && !p.archived)) { toast('That profile is unavailable or archived. Choose another profile or restore it below.'); return; }
      await open(requested);
    }
  } };
};

window.createEnrichProfilePicker = function ({ api, toast, changed }) {
  const el = id => document.getElementById(id);
  const select = el('enrichProfile');
  const label = p => `${p.name} · r${p.revision}`;
  let active = null, loaded = false, saving = false, epoch = 0;
  function sync(profile, requestEpoch = epoch) {
    if (!profile || saving || requestEpoch !== epoch) return;
    const previous = active?.revisionId;
    active = profile;
    let option = [...select.options].find(option => option.value === profile.id);
    if (!option) { option = new Option('', profile.id); select.add(option); }
    option.textContent = label(profile); select.value = profile.id;
    loaded = true;
    el('profileNote').textContent = `Used for all new enrichment runs.`;
    if (previous !== active.revisionId) changed();
  }
  async function load() {
    const requestEpoch = epoch;
    const data = await api('/api/enrich/profiles');
    if (requestEpoch !== epoch || saving) return;
    select.replaceChildren(...data.profiles.filter(p => !p.archived).map(p => new Option(label(p), p.id)));
    sync(data.activeProfile, requestEpoch);
  }
  select.addEventListener('change', async () => {
    const profileId = select.value;
    saving = true; epoch++; select.disabled = true;
    el('profileNote').textContent = 'Saving active profile…'; changed();
    try {
      const value = await api('/api/enrich/profiles/active', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, expectedActiveRevisionId: active?.revisionId }) });
      saving = false; epoch++; sync(value);
    } catch (error) {
      saving = false; epoch++; loaded = false;
      try { await load(); } catch { /* polling will retry */ }
      toast(error.message, true);
    } finally { select.disabled = false; saving = false; changed(); }
  });
  return { load, sync, epoch: () => epoch, id: () => active?.id, revision: () => active?.revisionId,
    ready: () => loaded && !saving && Boolean(active), label };
};
