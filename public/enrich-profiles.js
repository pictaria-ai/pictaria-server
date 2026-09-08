// Settings owns profile management; Enrich only selects and previews saved profiles.
window.createEnrichProfileManager = function ({ api, toast }) {
  const el = id => document.getElementById(id);
  let profiles = [];
  let editing = null;
  const select = el('enrichProfile');
  const editor = el('profileEditor');
  const label = p => `${p.name} · r${p.revision}${p.isDefault ? ' · default' : ''}`;
  const request = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const action = fn => async () => { try { await fn(); } catch (error) { toast(error.message, true); } };
  const fields = () => ({ name: el('profileName').value, systemPrompt: el('profileSystem').value,
    userTemplate: el('profileUser').value, taxonomy: el('profileTaxonomy').value });
  const note = message => { el('profileEditorNote').textContent = message; };
  const selected = () => profiles.find(p => p.id === select.value);

  async function load(preferred = select.value, remember = true) {
    const data = await api('/api/enrich/profiles');
    profiles = data.profiles;
    select.replaceChildren(...profiles.filter(p => !p.archived).map(p => new Option(label(p), p.id)));
    select.value = profiles.some(p => p.id === preferred && !p.archived) ? preferred : data.defaultProfileId;
    el('profileDefault').disabled = Boolean(selected()?.isDefault);
    el('profileArchive').disabled = Boolean(selected()?.isDefault);
    el('profileNote').textContent = `Daily Enrich and Send to Enrich use the default: ${profiles.find(p => p.isDefault)?.name}. Back to Enrich opens the selected profile for manual runs. Queued items keep their saved revision.`;
    const archived = profiles.filter(p => p.archived);
    el('profileArchivedRow').hidden = !archived.length;
    el('profileArchived').replaceChildren(...archived.map(p => new Option(label(p), p.id)));
    el('profileReturn').href = `/enrich.html?profile=${encodeURIComponent(select.value)}`;
    if (remember) {
      const url = new URL(location.href);
      url.searchParams.set('profile', select.value);
      history.replaceState(null, '', url);
    }
  }

  function show(value, existing = null) {
    editing = existing;
    el('profileName').value = value.name ?? 'New profile';
    el('profileSystem').value = value.systemPrompt;
    el('profileUser').value = value.userTemplate;
    el('profileTaxonomy').value = JSON.stringify(value.taxonomy, null, 2);
    el('profileEditorTitle').textContent = existing ? `Edit ${existing.name} · r${existing.revision}` : 'Create an enrichment profile';
    note('Saving creates a revision for future runs. Queued and running work keeps its saved inputs.');
    editor.hidden = false;
    el('profileName').focus();
  }

  select.addEventListener('change', action(async () => { editor.hidden = true; await load(select.value); }));
  el('profileEdit').addEventListener('click', action(async () => {
    const value = await api(`/api/enrich/profiles/${select.value}`); show(value, value);
  }));
  el('profileDuplicate').addEventListener('click', action(async () => {
    const value = await api(`/api/enrich/profiles/${select.value}`); show({ ...value, name: `${value.name} copy`.slice(0, 80) });
  }));
  el('profileNew').addEventListener('click', action(async () => { show(await api('/api/enrich/profiles/builtin')); }));
  el('profileClose').addEventListener('click', () => { editor.hidden = true; });
  el('profileValidate').addEventListener('click', action(async () => {
    try { await request('/api/enrich/profiles/validate', 'POST', fields()); note('Profile is valid. No photos were sent to a model.'); }
    catch (error) { note(error.message); }
  }));
  el('profileSave').addEventListener('click', action(async () => {
    el('profileSave').disabled = true;
    try {
      const value = await request(editing ? `/api/enrich/profiles/${editing.id}` : '/api/enrich/profiles', editing ? 'PATCH' : 'POST',
        { ...fields(), expectedRevisionId: editing?.revisionId });
      await load(value.id); show(value, value); note(`Saved ${value.name} · r${value.revision}. No enrichment was started.`);
    } catch (error) { note(error.message); }
    finally { el('profileSave').disabled = false; }
  }));
  el('profileDefault').addEventListener('click', action(async () => {
    await request(`/api/enrich/profiles/${select.value}/default`, 'POST', {}); await load(); toast('Default profile updated for future Daily Enrich and queued work.');
  }));
  el('profileArchive').addEventListener('click', action(async () => {
    await request(`/api/enrich/profiles/${select.value}/archive`, 'POST', { archived: true }); editor.hidden = true; await load(); toast('Profile archived. Saved revisions and queued work are retained.');
  }));
  el('profileRestore').addEventListener('click', action(async () => {
    const id = el('profileArchived').value;
    await request(`/api/enrich/profiles/${id}/archive`, 'POST', { archived: false }); await load(id);
  }));

  return { async load() {
    const requested = new URLSearchParams(location.search).get('profile');
    await load(requested, false);
    if (requested) {
      el('sec-enrichment-profiles').open = true;
      const profile = profiles.find(p => p.id === requested && !p.archived);
      if (!profile) { toast('That profile is unavailable or archived. Select another profile or restore it below.', true); return; }
      const value = await api(`/api/enrich/profiles/${profile.id}`);
      show(value, value);
    }
  } };
};

window.createEnrichProfilePicker = function ({ api, toast, changed }) {
  const el = id => document.getElementById(id);
  const select = el('enrichProfile');
  let profiles = [];
  let loaded = false;
  const label = p => `${p.name} · r${p.revision}${p.isDefault ? ' · default' : ''}`;
  const selected = () => profiles.find(p => p.id === select.value);
  const request = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const action = fn => async () => { try { await fn(); } catch (error) { toast(error.message, true); } };
  function update() {
    const href = `/settings.html?profile=${encodeURIComponent(select.value)}#sec-enrichment-profiles`;
    el('profileEdit').href = href;
    el('profilePreviewEdit').href = href;
    const url = new URL(location.href);
    url.searchParams.set('profile', select.value);
    history.replaceState(null, '', url);
    changed();
  }
  async function load(preferred = new URLSearchParams(location.search).get('profile')) {
    const data = await api('/api/enrich/profiles');
    profiles = data.profiles.filter(p => !p.archived);
    select.replaceChildren(...profiles.map(p => new Option(label(p), p.id)));
    select.value = profiles.some(p => p.id === preferred) ? preferred : data.defaultProfileId;
    if (preferred && select.value !== preferred) toast('That profile is unavailable or archived. The default profile is selected.', true);
    loaded = true;
    el('profileView').disabled = false;
    el('profileNote').textContent = `Selected for new manual runs. Daily Enrich and Send to Enrich use the default: ${profiles.find(p => p.isDefault)?.name}. Queued items keep their saved revision.`;
    update();
  }
  select.addEventListener('change', update);
  return { load, id: () => select.value, ready: () => loaded && Boolean(selected()), label,
    queueControl(item) {
      const wrap = document.createElement('span');
      wrap.className = 'qline';
      const current = document.createElement('span');
      current.textContent = item.profile ? `Profile: ${label(item.profile)}` : 'Profile: migrated default';
      const button = document.createElement('button');
      button.className = 'p-btn quiet queue-profile';
      button.textContent = 'Use selected profile';
      button.title = 'Replace this queued choice with the selected profile’s current revision';
      button.addEventListener('click', action(async () => {
        await request(`/api/enrich/queue/${item.id}/profile`, 'PATCH', { profileId: select.value, expectedRevisionId: item.profileRevisionId });
        changed(); toast('Queued profile updated to the selected revision.');
      }));
      wrap.append(current, button); return wrap;
    },
  };
};
