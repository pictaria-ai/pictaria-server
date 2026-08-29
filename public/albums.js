const DEFAULT_MAX_RESULTS = 50;
const CREATE_PANEL_OPEN_STORAGE_KEY = 'pictariaAlbumsCreatePanelOpen';
const DEFAULT_EXCLUSION_TAG = {
  id: '',
  name: 'frame/never-show',
  value: 'frame/never-show',
};

const state = {
  authRequired: false,
  immichConfigured: true,
  excludeTagSearchTimer: null,
  loading: false,
  peopleSearchTimer: null,
  selectedExcludeTags: [DEFAULT_EXCLUSION_TAG],
  selectedPeople: [],
  selectedTags: [],
  tagSearchTimer: null,
  tags: [],
  tagsLoaded: false,
};

const elements = {
  addExcludeTagButton: document.querySelector('#addExcludeTagButton'),
  addTagButton: document.querySelector('#addTagButton'),
  addPersonButton: document.querySelector('#addPersonButton'),
  albumNameInput: document.querySelector('#albumNameInput'),
  cityInput: document.querySelector('#cityInput'),
  connStatus: document.querySelector('#connStatus'),
  countryInput: document.querySelector('#countryInput'),
  createButton: document.querySelector('#createButton'),
  createForm: document.querySelector('#createForm'),
  createPanel: document.querySelector('#createAlbumPanel'),
  excludeTagInput: document.querySelector('#excludeTagInput'),
  excludeTagResults: document.querySelector('#excludeTagResults'),
  immichChip: document.querySelector('#immichChip'),
  includeAllResultsInput: document.querySelector('#includeAllResultsInput'),
  intervalInput: document.querySelector('#intervalInput'),
  jobCount: document.querySelector('#jobCount'),
  jobsList: document.querySelector('#jobsList'),
  makeInput: document.querySelector('#makeInput'),
  maxResultsInput: document.querySelector('#maxResultsInput'),
  modelInput: document.querySelector('#modelInput'),
  peopleModeInput: document.querySelector('#peopleModeInput'),
  peopleInput: document.querySelector('#peopleInput'),
  peopleResults: document.querySelector('#peopleResults'),
  previewButton: document.querySelector('#previewButton'),
  previewCount: document.querySelector('#previewCount'),
  previewGrid: document.querySelector('#previewGrid'),
  previewPanel: document.querySelector('#previewPanel'),
  queryInput: document.querySelector('#queryInput'),
  bestOfInput: document.querySelector('#bestOfInput'),
  refreshButton: document.querySelector('#refreshButton'),
  ruleSummary: document.querySelector('#ruleSummary'),
  selectedExcludeTags: document.querySelector('#selectedExcludeTags'),
  selectedPeople: document.querySelector('#selectedPeople'),
  smartInput: document.querySelector('#smartInput'),
  stateInput: document.querySelector('#stateInput'),
  selectedTags: document.querySelector('#selectedTags'),
  tagInput: document.querySelector('#tagInput'),
  tagModeInput: document.querySelector('#tagModeInput'),
  tagResults: document.querySelector('#tagResults'),
  takenAfterInput: document.querySelector('#takenAfterInput'),
  takenBeforeInput: document.querySelector('#takenBeforeInput'),
  toast: document.querySelector('#toast'),
};

restoreCreatePanelState();
elements.createPanel.addEventListener('toggle', () => {
  try {
    localStorage.setItem(CREATE_PANEL_OPEN_STORAGE_KEY, String(elements.createPanel.open));
  } catch {
    // Browser storage is optional; the panel still works as a native disclosure.
  }
});
elements.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await createJob();
});
elements.previewButton.addEventListener('click', () => previewSearch());
elements.refreshButton.addEventListener('click', () => loadJobs());
elements.addPersonButton.addEventListener('click', () => addTypedPerson());
elements.addTagButton.addEventListener('click', () => addTypedTag());
elements.addExcludeTagButton.addEventListener('click', () => addTypedExcludeTag());
elements.peopleInput.addEventListener('input', () => schedulePeopleSearch());
elements.peopleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTypedPerson();
  }
});
elements.tagInput.addEventListener('input', () => scheduleTagSearch());
elements.tagInput.addEventListener('focus', () => scheduleTagSearch());
elements.tagInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTypedTag();
  }
});
elements.excludeTagInput.addEventListener('input', () => scheduleExcludeTagSearch());
elements.excludeTagInput.addEventListener('focus', () => scheduleExcludeTagSearch());
elements.excludeTagInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTypedExcludeTag();
  }
});
elements.smartInput.addEventListener('change', () => {
  elements.intervalInput.disabled = !elements.smartInput.checked;
  updateRuleSummary();
});
elements.includeAllResultsInput.addEventListener('change', () => updateMaxResultsState());
elements.queryInput.addEventListener('input', () => {
  updatePeopleOptionState();
  updateTagOptionState();
  updateBestOfState();
  updateRuleSummary();
});
elements.bestOfInput.addEventListener('change', () => {
  updateBestOfState();
  updateRuleSummary();
});
elements.peopleModeInput.addEventListener('change', () => {
  updatePeopleOptionState();
  updateRuleSummary();
});
elements.tagModeInput.addEventListener('change', () => {
  updateTagOptionState();
  updateRuleSummary();
});
for (const input of [
  elements.cityInput,
  elements.countryInput,
  elements.intervalInput,
  elements.makeInput,
  elements.maxResultsInput,
  elements.modelInput,
  elements.stateInput,
  elements.takenAfterInput,
  elements.takenBeforeInput,
]) {
  input.addEventListener('input', () => updateRuleSummary());
}
document.addEventListener('click', (event) => {
  if (!elements.peopleResults.contains(event.target) && event.target !== elements.peopleInput) {
    elements.peopleResults.classList.add('hidden');
  }

  if (!elements.tagResults.contains(event.target) && event.target !== elements.tagInput) {
    elements.tagResults.classList.add('hidden');
  }

  if (!elements.excludeTagResults.contains(event.target) && event.target !== elements.excludeTagInput) {
    elements.excludeTagResults.classList.add('hidden');
  }
});

init();

function restoreCreatePanelState() {
  try {
    const saved = localStorage.getItem(CREATE_PANEL_OPEN_STORAGE_KEY);
    if (saved !== null) {
      elements.createPanel.open = saved === 'true';
    }
  } catch {
    // Keep the HTML default (open) when browser storage is unavailable.
  }
}

async function init() {
  renderSelectedExcludeTags();
  updateMaxResultsState();
  updatePeopleOptionState();
  updateTagOptionState();
  updateBestOfState();
  updateRuleSummary();
  applyPrefillFromHash();

  try {
    const health = await request('/api/health', { skipConnectedChip: true });
    state.authRequired = Boolean(health.authRequired);
    // Health answers trimmed (no immichConfigured field) when our credentials
    // — session cookie or header — did not authorize: show the gate.
    if (state.authRequired && !('immichConfigured' in health)) {
      requirePassword();
      showToast('App password required — enter it and press Connect', true);
      return;
    }
    state.immichConfigured = Boolean(health.immichConfigured);
    elements.immichChip.hidden = state.immichConfigured;
  } catch (error) {
    showToast(error.message, true);
    return;
  }

  await loadJobs();
}

async function loadJobs() {
  setBusy(true);
  try {
    const response = await request('/api/albums/jobs');
    renderJobs(response.jobs || []);
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function previewSearch() {
  const query = elements.queryInput.value.trim();

  if (!(await prepareSearch(query))) {
    return;
  }

  setBusy(true);
  try {
    const preview = await request('/api/albums/preview', {
      method: 'POST',
      body: {
        query,
        bestOf: elements.bestOfInput.checked,
        filters: readFilters(),
        includeAllResults: elements.includeAllResultsInput.checked,
        maxResults: Number(elements.maxResultsInput.value || DEFAULT_MAX_RESULTS),
      },
    });
    renderPreview(preview);
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function createJob() {
  if (!(await prepareSearch(elements.queryInput.value.trim()))) {
    return;
  }

  setBusy(true);
  try {
    const response = await request('/api/albums/jobs', {
      method: 'POST',
      body: {
        query: elements.queryInput.value,
        bestOf: elements.bestOfInput.checked,
        albumName: elements.albumNameInput.value,
        filters: readFilters(),
        includeAllResults: elements.includeAllResultsInput.checked,
        smart: elements.smartInput.checked,
        intervalDays: Number(elements.intervalInput.value || 7),
        maxResults: Number(elements.maxResultsInput.value || DEFAULT_MAX_RESULTS),
      },
    });
    showToast(`Created ${response.job.albumName}.`);
    elements.createForm.reset();
    elements.smartInput.checked = true;
    elements.includeAllResultsInput.checked = true;
    elements.intervalInput.value = '7';
    elements.maxResultsInput.value = String(DEFAULT_MAX_RESULTS);
    elements.peopleModeInput.value = 'all';
    elements.tagModeInput.value = 'all';
    resetExcludeTags();
    updateMaxResultsState();
    updateBestOfState();
    clearFilters();
    elements.intervalInput.disabled = false;
    elements.previewPanel.classList.add('hidden');
    await loadJobs();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function runJob(jobId) {
  setBusy(true);
  try {
    const response = await request(`/api/albums/jobs/${encodeURIComponent(jobId)}/run`, { method: 'POST' });
    const addedCount = response.job.lastResult?.addedCount || 0;
    const removedCount = response.job.lastResult?.removedCount
      ?? response.job.lastResult?.removedNeverShowCount
      ?? 0;
    const warnings = response.job.lastResult?.warnings ?? [];
    showToast(
      `Added ${addedCount} new assets. Removed ${removedCount} that no longer match.`
        + (warnings.length ? ` Warning: ${warnings.join(' ')}` : ''),
    );
    await loadJobs();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function patchJob(jobId, body) {
  setBusy(true);
  try {
    await request(`/api/albums/jobs/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body,
    });
    await loadJobs();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function deleteJob(jobId) {
  const confirmed = window.confirm('Delete this local job record? The Immich album will stay.');

  if (!confirmed) {
    return;
  }

  setBusy(true);
  try {
    await request(`/api/albums/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    await loadJobs();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

// The honest line for a Best-of result: what was confirmed, what was noise,
// and how many candidates can't be judged because they aren't enriched yet.
function describeBestOfStats(stats) {
  const parts = [`Best of: ${stats.corroborated} confirmed`];
  if (stats.droppedLowSignal > 0) {
    parts.push(`${stats.droppedLowSignal} unconfirmed dropped`);
  }
  if (stats.droppedNeverShow > 0) {
    parts.push(`${stats.droppedNeverShow} hidden by your Curate decisions`);
  }
  if (stats.notEnriched > 0) {
    parts.push(`${stats.notEnriched} possible matches not enriched yet`);
  }
  return parts.join(' · ');
}

function renderPreview(preview) {
  elements.previewPanel.classList.remove('hidden');
  const previewWarnings = preview.warnings?.length ? ` — Warning: ${preview.warnings.join(' ')}` : '';
  const bestOfLine = preview.bestOf ? ` — ${describeBestOfStats(preview.bestOf)}` : '';
  elements.previewCount.textContent = `Showing ${preview.assets.length} of ${preview.rankedCount}${preview.truncated ? '+' : ''} matched${bestOfLine}${previewWarnings}`;
  elements.previewGrid.textContent = '';

  if (!preview.assets.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No matching photos';
    elements.previewGrid.append(empty);
    return;
  }

  for (const asset of preview.assets) {
    const tile = document.createElement('div');
    tile.className = 'preview-tile';
    const img = document.createElement('img');
    img.alt = asset.originalFileName || 'Photo';
    img.loading = 'lazy';
    // Thumbnails authenticate via the HttpOnly session cookie set at login.
    img.src = `/api/albums/assets/${encodeURIComponent(asset.id)}/thumbnail?size=thumbnail`;
    tile.append(img);
    elements.previewGrid.append(tile);
  }
}

const JOB_SORTS = {
  name: (a, b) => a.albumName.localeCompare(b.albumName),
  photos: (a, b) =>
    (b.lastResult?.rankedCount ?? b.lastResult?.matchedCount ?? 0) - (a.lastResult?.rankedCount ?? a.lastResult?.matchedCount ?? 0)
    || a.albumName.localeCompare(b.albumName),
  lastRun: (a, b) =>
    String(b.lastSuccessAt || b.lastRunAt || '').localeCompare(String(a.lastSuccessAt || a.lastRunAt || ''))
    || a.albumName.localeCompare(b.albumName),
};

function renderJobs(jobs) {
  state.jobs = jobs;
  elements.jobCount.textContent = String(jobs.length);
  elements.jobsList.textContent = '';

  if (jobs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No managed albums yet';
    elements.jobsList.append(empty);
    return;
  }

  const sort = JOB_SORTS[document.querySelector('#jobSort')?.value] ?? JOB_SORTS.name;
  for (const job of jobs.toSorted(sort)) {
    elements.jobsList.append(renderJob(job));
  }
}
document.querySelector('#jobSort')?.addEventListener('change', () => renderJobs(state.jobs ?? []));

function renderJob(job) {
  const row = document.createElement('article');
  row.className = 'job-row';

  const detail = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'job-title';
  title.innerHTML = `<strong></strong><span class="p-chip accent"></span>`;
  title.querySelector('strong').textContent = job.albumName;
  title.querySelector('.p-chip').textContent = job.scheduleQuarantined
    ? 'Needs review'
    : (job.enabled ? `Every ${job.intervalDays}d` : 'Paused');

  const query = document.createElement('p');
  query.className = 'job-query';
  query.textContent = describeJobQuery(job);

  const meta = document.createElement('div');
  meta.className = 'job-meta';
  meta.append(
    metaRow(
      `Matched: ${job.lastResult?.rankedCount ?? job.lastResult?.matchedCount ?? 0}`,
      job.includeAllResults ? 'Limit: All' : `Limit: ${job.maxResults || DEFAULT_MAX_RESULTS}`,
    ),
  );
  meta.append(
    metaRow(
      `Last run: ${formatDate(job.lastSuccessAt || job.lastRunAt)}`,
      `Added: ${job.lastResult?.addedCount ?? 0}`,
      `Removed: ${job.lastResult?.removedCount ?? job.lastResult?.removedNeverShowCount ?? 0}`,
    ),
  );
  meta.append(metaRow(`Next: ${formatDate(job.nextRunAt)}`));
  if (job.scheduleQuarantined) {
    const warning = metaSpan('Restored schedule is paused. Review this rule before enabling automatic runs.');
    warning.className = 'p-error';
    meta.append(warning);
  }
  if (job.lastResult?.bestOf) {
    meta.append(metaRow(describeBestOfStats(job.lastResult.bestOf)));
  }
  for (const warning of job.lastResult?.warnings ?? []) {
    const warn = metaSpan(warning);
    warn.className = 'p-error';
    meta.append(warn);
  }
  if (job.lastError) {
    const error = metaSpan(job.lastError);
    error.className = 'p-error';
    meta.append(error);
  }

  detail.append(title, query, meta);

  const controls = document.createElement('div');
  controls.className = 'job-controls';
  const interval = document.createElement('input');
  interval.className = 'p-input mini-input';
  interval.type = 'number';
  interval.min = '1';
  interval.max = '365';
  interval.value = String(job.intervalDays || 7);
  interval.title = 'Interval days';
  interval.addEventListener('change', () => patchJob(job.id, { intervalDays: Number(interval.value), smart: true, enabled: true }));

  const maxResults = document.createElement('input');
  maxResults.className = 'p-input mini-input';
  maxResults.type = 'number';
  maxResults.min = '1';
  maxResults.max = '5000';
  maxResults.value = String(job.maxResults || DEFAULT_MAX_RESULTS);
  maxResults.title = 'Photo limit';
  maxResults.addEventListener('change', () => patchJob(job.id, { maxResults: Number(maxResults.value) }));

  const includeAllResults = document.createElement('input');
  includeAllResults.type = 'checkbox';
  includeAllResults.checked = Boolean(job.includeAllResults);
  includeAllResults.title = 'All matching photos';
  includeAllResults.addEventListener('change', () => {
    patchJob(job.id, { includeAllResults: includeAllResults.checked });
  });
  const includeAllResultsLabel = document.createElement('label');
  const includeAllResultsText = document.createElement('span');
  includeAllResultsText.textContent = 'All';
  includeAllResultsLabel.className = 'checkbox-label mini-checkbox-label';
  includeAllResultsLabel.title = 'All results';
  includeAllResultsLabel.append(includeAllResults, includeAllResultsText);
  maxResults.disabled = includeAllResults.checked;

  controls.append(
    button('Run', () => runJob(job.id), 'p-btn'),
    button(
      job.scheduleQuarantined ? 'Review & enable' : (job.enabled ? 'Pause' : 'Enable'),
      () => patchJob(job.id, { smart: true, enabled: !job.enabled }),
      'p-btn',
    ),
    interval,
    includeAllResultsLabel,
    maxResults,
    button('Delete', () => deleteJob(job.id), 'p-btn danger'),
  );

  row.append(detail, controls);
  return row;
}

async function schedulePeopleSearch() {
  window.clearTimeout(state.peopleSearchTimer);
  const name = elements.peopleInput.value.trim();

  if (name.length < 2) {
    renderPeopleResults([]);
    return;
  }

  state.peopleSearchTimer = window.setTimeout(async () => {
    try {
      renderPeopleResults(await searchPeople(name));
    } catch (error) {
      handleError(error);
    }
  }, 250);
}

async function addTypedPerson() {
  const name = elements.peopleInput.value.trim();
  if (!name) {
    showToast('Type a person name first.');
    return false;
  }

  try {
    return await resolveTypedPerson(name);
  } catch (error) {
    handleError(error);
    return false;
  }
}

async function resolveTypedPerson(name) {
  const people = await searchPeople(name);
  const availablePeople = people.filter((person) => !state.selectedPeople.some((selected) => selected.id === person.id));

  if (availablePeople.length === 1) {
    addPerson(availablePeople[0]);
    elements.peopleInput.value = '';
    renderPeopleResults([]);
    return true;
  }

  renderPeopleResults(availablePeople, { showEmpty: true });

  if (availablePeople.length === 0) {
    showToast(`No Immich people found for "${name}".`);
  } else {
    showToast('Choose a person from the People results.');
  }

  return false;
}

async function searchPeople(name) {
  const response = await request(`/api/albums/people?name=${encodeURIComponent(name)}`);
  return response.people || [];
}

function renderPeopleResults(people, { showEmpty = false } = {}) {
  elements.peopleResults.textContent = '';

  const availablePeople = people.filter((person) => !state.selectedPeople.some((selected) => selected.id === person.id));
  if (availablePeople.length === 0) {
    if (showEmpty) {
      const empty = document.createElement('div');
      empty.className = 'people-empty';
      empty.textContent = 'No people found';
      elements.peopleResults.append(empty);
      elements.peopleResults.classList.remove('hidden');
      return;
    }

    elements.peopleResults.classList.add('hidden');
    return;
  }

  for (const person of availablePeople.slice(0, 8)) {
    const result = document.createElement('button');
    result.type = 'button';
    result.className = 'people-result';
    result.textContent = `Add ${person.name || 'Unnamed'}`;
    result.addEventListener('click', () => {
      addPerson(person);
      elements.peopleInput.value = '';
      renderPeopleResults([]);
    });
    elements.peopleResults.append(result);
  }

  elements.peopleResults.classList.remove('hidden');
}

function addPerson(person) {
  if (state.selectedPeople.some((selected) => selected.id === person.id)) {
    return;
  }

  state.selectedPeople.push({
    id: person.id,
    name: person.name || 'Unnamed',
  });
  renderSelectedPeople();
}

function removePerson(personId) {
  state.selectedPeople = state.selectedPeople.filter((person) => person.id !== personId);
  renderSelectedPeople();
}

function renderSelectedPeople() {
  elements.selectedPeople.textContent = '';

  for (const person of state.selectedPeople) {
    const chip = document.createElement('span');
    chip.className = 'pick-chip';
    const label = document.createElement('span');
    label.textContent = person.name || person.id;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'x';
    removeButton.title = `Remove ${person.name || 'person'}`;
    removeButton.addEventListener('click', () => removePerson(person.id));
    chip.append(label, removeButton);
    elements.selectedPeople.append(chip);
  }

  updatePeopleOptionState();
  updateRuleSummary();
}

async function ensureTagsLoaded() {
  if (state.tagsLoaded) {
    return state.tags;
  }

  const response = await request('/api/albums/tags');
  state.tags = (response.tags || []).sort((first, second) => tagLabel(first).localeCompare(tagLabel(second)));
  state.tagsLoaded = true;
  reconcileSelectedExcludeTags();
  return state.tags;
}

function scheduleTagSearch() {
  window.clearTimeout(state.tagSearchTimer);

  state.tagSearchTimer = window.setTimeout(async () => {
    try {
      const tags = await ensureTagsLoaded();
      renderTagResults(filterAvailableTags(tags, elements.tagInput.value.trim(), state.selectedTags));
    } catch (error) {
      handleError(error);
    }
  }, 150);
}

async function addTypedTag() {
  const value = elements.tagInput.value.trim();
  if (!value) {
    showToast('Type a tag first.');
    return false;
  }

  try {
    const tags = await ensureTagsLoaded();
    const availableTags = filterAvailableTags(tags, value, state.selectedTags);

    if (availableTags.length === 1) {
      addTag(availableTags[0]);
      elements.tagInput.value = '';
      renderTagResults([]);
      return true;
    }

    renderTagResults(availableTags, { showEmpty: true });

    if (availableTags.length === 0) {
      showToast(`No Immich tags found for "${value}".`);
    } else {
      showToast('Choose a tag from the Tags results.');
    }

    return false;
  } catch (error) {
    handleError(error);
    return false;
  }
}

function filterAvailableTags(tags, value, selectedTags) {
  const normalizedValue = value.toLowerCase();
  return tags.filter((tag) => {
    if (selectedTags.some((selected) => tagsAreSame(selected, tag))) {
      return false;
    }

    if (!normalizedValue) {
      return true;
    }

    return tagLabel(tag).toLowerCase().includes(normalizedValue)
      || String(tag.name || '').toLowerCase().includes(normalizedValue);
  });
}

function renderTagResults(tags, { showEmpty = false } = {}) {
  elements.tagResults.textContent = '';

  if (tags.length === 0) {
    if (showEmpty) {
      const empty = document.createElement('div');
      empty.className = 'people-empty';
      empty.textContent = 'No tags found';
      elements.tagResults.append(empty);
      elements.tagResults.classList.remove('hidden');
      return;
    }

    elements.tagResults.classList.add('hidden');
    return;
  }

  for (const tag of tags.slice(0, 8)) {
    const result = document.createElement('button');
    result.type = 'button';
    result.className = 'people-result';
    result.textContent = `Add ${tagLabel(tag)}`;
    result.addEventListener('click', () => {
      addTag(tag);
      elements.tagInput.value = '';
      renderTagResults([]);
    });
    elements.tagResults.append(result);
  }

  elements.tagResults.classList.remove('hidden');
}

function addTag(tag) {
  if (state.selectedTags.some((selected) => selected.id === tag.id)) {
    return;
  }

  state.selectedTags.push({
    id: tag.id,
    name: tag.name || tag.value || 'Unnamed',
    value: tag.value || tag.name || 'Unnamed',
  });
  renderSelectedTags();
}

function removeTag(tagId) {
  state.selectedTags = state.selectedTags.filter((tag) => tag.id !== tagId);
  renderSelectedTags();
}

function renderSelectedTags() {
  elements.selectedTags.textContent = '';

  for (const tag of state.selectedTags) {
    const chip = document.createElement('span');
    chip.className = 'pick-chip';
    const label = document.createElement('span');
    label.textContent = tagLabel(tag);
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'x';
    removeButton.title = `Remove ${tagLabel(tag)}`;
    removeButton.addEventListener('click', () => removeTag(tag.id));
    chip.append(label, removeButton);
    elements.selectedTags.append(chip);
  }

  updateRuleSummary();
  updateTagOptionState();
}

function scheduleExcludeTagSearch() {
  window.clearTimeout(state.excludeTagSearchTimer);

  state.excludeTagSearchTimer = window.setTimeout(async () => {
    try {
      const tags = await ensureTagsLoaded();
      renderExcludeTagResults(filterAvailableTags(tags, elements.excludeTagInput.value.trim(), state.selectedExcludeTags));
    } catch (error) {
      handleError(error);
    }
  }, 150);
}

async function addTypedExcludeTag() {
  const value = elements.excludeTagInput.value.trim();
  if (!value) {
    showToast('Type an exclusion tag first.');
    return false;
  }

  try {
    const tags = await ensureTagsLoaded();
    const availableTags = filterAvailableTags(tags, value, state.selectedExcludeTags);

    if (availableTags.length === 1) {
      addExcludeTag(availableTags[0]);
      elements.excludeTagInput.value = '';
      renderExcludeTagResults([]);
      return true;
    }

    renderExcludeTagResults(availableTags, { showEmpty: true });

    if (availableTags.length === 0) {
      showToast(`No Immich tags found for "${value}".`);
    } else {
      showToast('Choose a tag from the Blanket Exclusion results.');
    }

    return false;
  } catch (error) {
    handleError(error);
    return false;
  }
}

function renderExcludeTagResults(tags, { showEmpty = false } = {}) {
  elements.excludeTagResults.textContent = '';

  if (tags.length === 0) {
    if (showEmpty) {
      const empty = document.createElement('div');
      empty.className = 'people-empty';
      empty.textContent = 'No tags found';
      elements.excludeTagResults.append(empty);
      elements.excludeTagResults.classList.remove('hidden');
      return;
    }

    elements.excludeTagResults.classList.add('hidden');
    return;
  }

  for (const tag of tags.slice(0, 8)) {
    const result = document.createElement('button');
    result.type = 'button';
    result.className = 'people-result';
    result.textContent = `Exclude ${tagLabel(tag)}`;
    result.addEventListener('click', () => {
      addExcludeTag(tag);
      elements.excludeTagInput.value = '';
      renderExcludeTagResults([]);
    });
    elements.excludeTagResults.append(result);
  }

  elements.excludeTagResults.classList.remove('hidden');
}

function addExcludeTag(tag) {
  if (state.selectedExcludeTags.some((selected) => tagsAreSame(selected, tag))) {
    return;
  }

  state.selectedExcludeTags.push(normalizeClientTag(tag));
  renderSelectedExcludeTags();
}

function removeExcludeTag(tagKey) {
  state.selectedExcludeTags = state.selectedExcludeTags.filter((tag) => tagKeyFor(tag) !== tagKey);
  renderSelectedExcludeTags();
}

function renderSelectedExcludeTags() {
  elements.selectedExcludeTags.textContent = '';

  for (const tag of state.selectedExcludeTags) {
    const chip = document.createElement('span');
    chip.className = 'pick-chip';
    const label = document.createElement('span');
    label.textContent = tagLabel(tag);
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'x';
    removeButton.title = `Remove ${tagLabel(tag)}`;
    removeButton.addEventListener('click', () => removeExcludeTag(tagKeyFor(tag)));
    chip.append(label, removeButton);
    elements.selectedExcludeTags.append(chip);
  }
}

function tagLabel(tag) {
  return tag?.value || tag?.name || tag?.id || 'Unnamed';
}

function tagKeyFor(tag) {
  return tag?.id || tagLabel(tag).toLowerCase();
}

function tagsAreSame(first, second) {
  return tagKeyFor(first) === tagKeyFor(second)
    || tagLabel(first).toLowerCase() === tagLabel(second).toLowerCase();
}

function normalizeClientTag(tag) {
  return {
    id: tag?.id || '',
    name: tag?.name || tag?.value || '',
    value: tag?.value || tag?.name || tag?.id || '',
  };
}

function readFilters() {
  const peopleMode = elements.peopleModeInput.value;
  const tagMode = elements.tagModeInput.value;
  // Comma-separated cities become an OR list (used by synthetic locations
  // from Insights; also typeable by hand).
  const cityParts = elements.cityInput.value.split(',').map((part) => part.trim()).filter(Boolean);
  // Comma-separated countries become an OR list, mirroring cities. The
  // server rejects multiple countries combined with a city or state.
  const countryParts = elements.countryInput.value.split(',').map((part) => part.trim()).filter(Boolean);

  return {
    people: state.selectedPeople,
    peopleMatchMode: peopleMode === 'any' ? 'any' : 'all',
    peopleOnly: peopleMode === 'only',
    tags: state.selectedTags,
    tagMatchMode: tagMode === 'any' ? 'any' : 'all',
    excludeTags: state.selectedExcludeTags,
    city: cityParts.length === 1 ? cityParts[0] : '',
    cities: cityParts.length > 1 ? cityParts : [],
    state: elements.stateInput.value,
    country: countryParts.length === 1 ? countryParts[0] : '',
    countries: countryParts.length > 1 ? countryParts : [],
    make: elements.makeInput.value,
    model: elements.modelInput.value,
    takenAfter: elements.takenAfterInput.value,
    takenBefore: elements.takenBeforeInput.value,
  };
}

function hasFilters() {
  const filters = readFilters();
  return Boolean(
    filters.people.length ||
    filters.tags.length ||
    filters.city.trim() ||
    filters.cities.length ||
    filters.state.trim() ||
    filters.country.trim() ||
    filters.countries.length ||
    filters.make.trim() ||
    filters.model.trim() ||
    filters.takenAfter ||
    filters.takenBefore,
  );
}

async function prepareSearch(query) {
  if (query || hasFilters()) {
    return true;
  }

  const typedPersonName = elements.peopleInput.value.trim();
  if (typedPersonName) {
    return resolveTypedPerson(typedPersonName);
  }

  showToast('Add at least one match criterion.');
  return false;
}

function updateMaxResultsState() {
  elements.maxResultsInput.disabled = elements.includeAllResultsInput.checked;
  updateRuleSummary();
}

// Best of only means something with a text search to corroborate; without one
// the toggle is disabled.
function updateBestOfState() {
  const hasTextSearch = Boolean(elements.queryInput.value.trim());
  elements.bestOfInput.disabled = !hasTextSearch;
  if (!hasTextSearch) {
    elements.bestOfInput.checked = false;
  }
}

function updatePeopleOptionState() {
  const hasPeople = state.selectedPeople.length > 0;
  const hasTextSearch = Boolean(elements.queryInput.value.trim());
  const anyOption = [...elements.peopleModeInput.options].find((option) => option.value === 'any');
  const onlyOption = [...elements.peopleModeInput.options].find((option) => option.value === 'only');

  elements.peopleModeInput.disabled = !hasPeople;
  anyOption.disabled = !hasPeople || hasTextSearch;
  onlyOption.disabled = state.selectedPeople.length !== 1 || hasTextSearch;

  if (!hasPeople) {
    elements.peopleModeInput.value = 'all';
    return;
  }

  const selectedOption = [...elements.peopleModeInput.options].find((option) => option.value === elements.peopleModeInput.value);
  if (selectedOption?.disabled) {
    elements.peopleModeInput.value = 'all';
  }
}

function updateTagOptionState() {
  const hasTags = state.selectedTags.length > 0;
  const hasTextSearch = Boolean(elements.queryInput.value.trim());
  const anyOption = [...elements.tagModeInput.options].find((option) => option.value === 'any');

  elements.tagModeInput.disabled = !hasTags;
  anyOption.disabled = !hasTags || hasTextSearch;

  if (!hasTags || anyOption.disabled && elements.tagModeInput.value === 'any') {
    elements.tagModeInput.value = 'all';
  }
}

// Insights hands a slice over as #create=<json> (a hash so the filters never
// reach server logs). Hydrate the builder from it, then drop the hash so a
// refresh starts clean.
function applyPrefillFromHash() {
  const match = /^#create=(.+)$/.exec(window.location.hash);
  if (!match) {
    return;
  }
  history.replaceState(null, '', window.location.pathname);

  let prefill;
  try {
    prefill = JSON.parse(decodeURIComponent(match[1]));
  } catch {
    showToast('Could not read the prefilled album criteria.', true);
    return;
  }

  if (prefill.albumName) {
    elements.albumNameInput.value = String(prefill.albumName);
  }
  for (const person of Array.isArray(prefill.people) ? prefill.people : []) {
    if (person?.id) {
      addPerson({ id: String(person.id), name: String(person.name || '') });
    }
  }
  for (const tag of Array.isArray(prefill.tags) ? prefill.tags : []) {
    if (tag?.id) {
      addTag({ id: String(tag.id), name: String(tag.name || tag.value || ''), value: String(tag.value || tag.name || '') });
    }
  }
  if (Array.isArray(prefill.cities) && prefill.cities.length > 0) {
    elements.cityInput.value = prefill.cities.join(', ');
  }
  if (Array.isArray(prefill.countries) && prefill.countries.length > 0) {
    elements.countryInput.value = prefill.countries.join(', ');
  }
  for (const [key, element] of [
    ['city', elements.cityInput],
    ['state', elements.stateInput],
    ['country', elements.countryInput],
    ['make', elements.makeInput],
    ['model', elements.modelInput],
    ['takenAfter', elements.takenAfterInput],
    ['takenBefore', elements.takenBeforeInput],
  ]) {
    if (prefill[key]) {
      element.value = String(prefill[key]);
    }
  }
  updateRuleSummary();
  elements.createForm.scrollIntoView({ block: 'start' });
  showToast('Criteria loaded from Insights — tweak anything, then Preview or Create.');
}

function clearFilters() {
  state.selectedPeople = [];
  state.selectedTags = [];
  resetExcludeTags();
  renderSelectedPeople();
  renderSelectedTags();
  renderSelectedExcludeTags();
  elements.peopleInput.value = '';
  elements.tagInput.value = '';
  elements.excludeTagInput.value = '';
  elements.peopleModeInput.value = 'all';
  elements.tagModeInput.value = 'all';
  elements.peopleResults.classList.add('hidden');
  elements.tagResults.classList.add('hidden');
  elements.excludeTagResults.classList.add('hidden');
  elements.cityInput.value = '';
  elements.stateInput.value = '';
  elements.countryInput.value = '';
  elements.makeInput.value = '';
  elements.modelInput.value = '';
  elements.takenAfterInput.value = '';
  elements.takenBeforeInput.value = '';
  updatePeopleOptionState();
  updateTagOptionState();
  updateRuleSummary();
}

function resetExcludeTags() {
  state.selectedExcludeTags = [{ ...DEFAULT_EXCLUSION_TAG }];
  reconcileSelectedExcludeTags();
}

function reconcileSelectedExcludeTags() {
  if (!state.tagsLoaded) {
    return;
  }

  state.selectedExcludeTags = state.selectedExcludeTags.map((selected) => {
    if (selected.id) {
      return selected;
    }

    const matchingTag = state.tags.find((tag) => tagLabel(tag).toLowerCase() === tagLabel(selected).toLowerCase());
    return matchingTag ? normalizeClientTag(matchingTag) : selected;
  });
}

function describeJobQuery(job) {
  const parts = [];

  if (job.query) {
    parts.push(job.bestOf ? `Best of: ${job.query}` : `Search: ${job.query}`);
  }

  const filters = job.filters || {};
  const filterParts = [];
  if (filters.people?.length) {
    if (filters.peopleOnly && filters.people.length === 1) {
      filterParts.push(`People: ${filters.people[0].name || filters.people[0].id} only`);
    } else {
      const joiner = filters.peopleMatchMode === 'any' ? ' OR ' : ' AND ';
      filterParts.push(`People: ${filters.people.map((person) => person.name || person.id).join(joiner)}`);
    }
  }

  if (filters.tags?.length) {
    const joiner = filters.tagMatchMode === 'any' ? ' OR ' : ' AND ';
    filterParts.push(`Tags: ${filters.tags.map((tag) => tag.value || tag.name || tag.id).join(joiner)}`);
  }

  for (const [label, value] of [
    ['City / Neighborhood', filters.cities?.length > 1 ? filters.cities.join(' OR ') : filters.city],
    ['State / Region', filters.state],
    ['Country', filters.countries?.length > 1 ? filters.countries.join(' OR ') : filters.country],
    ['From', formatFilterDate(filters.takenAfter)],
    ['To', formatFilterDate(filters.takenBefore)],
  ]) {
    if (value) {
      filterParts.push(`${label}: ${value}`);
    }
  }

  if (filterParts.length) {
    parts.push(filterParts.join(' | '));
  }

  return parts.join(' | ') || 'Filter-only album';
}

function updateRuleSummary() {
  const filters = readFilters();
  const query = elements.queryInput.value.trim();
  const parts = describeRuleParts(filters, query);

  elements.ruleSummary.classList.toggle('is-empty', parts.length === 0);

  if (parts.length === 0) {
    elements.ruleSummary.textContent = 'No match criteria selected';
    return;
  }

  const scope = elements.includeAllResultsInput.checked
    ? 'All Photos with'
    : `${elements.bestOfInput.checked ? 'Best' : 'Top'} ${Number(elements.maxResultsInput.value || DEFAULT_MAX_RESULTS)} Photos with`;
  const title = document.createElement('div');
  title.className = 'rule-summary-title';
  title.textContent = 'Matches:';
  const scopeLine = document.createElement('div');
  scopeLine.className = 'rule-summary-scope';
  scopeLine.textContent = scope;
  const list = document.createElement('ul');
  list.className = 'rule-summary-list';

  for (const part of parts) {
    const item = document.createElement('li');
    item.textContent = part;
    list.append(item);
  }

  elements.ruleSummary.replaceChildren(title, scopeLine, list);
}

function describeRuleParts(filters, query) {
  const parts = [];

  if (filters.people.length) {
    if (filters.peopleOnly && filters.people.length === 1) {
      parts.push(`Person is ${filters.people[0].name || filters.people[0].id} only`);
    } else {
      const joiner = filters.peopleMatchMode === 'any' ? ' OR ' : ' AND ';
      parts.push(`People: ${filters.people.map((person) => person.name || person.id).join(joiner)}`);
    }
  }

  if (filters.tags.length) {
    const joiner = filters.tagMatchMode === 'any' ? ' OR ' : ' AND ';
    parts.push(`Tags: ${filters.tags.map(tagLabel).join(joiner)}`);
  }

  for (const [label, value] of [
    ['City / Neighborhood', filters.cities.length > 1 ? filters.cities.join(' OR ') : filters.city.trim()],
    ['State / Region', filters.state.trim()],
    ['Country', filters.countries.length > 1 ? filters.countries.join(' OR ') : filters.country.trim()],
    ['Camera Make', filters.make.trim()],
    ['Camera Model', filters.model.trim()],
    ['From', filters.takenAfter],
    ['To', filters.takenBefore],
  ]) {
    if (value) {
      parts.push(`${label}: ${value}`);
    }
  }

  if (query) {
    parts.push(
      elements.bestOfInput.checked
        ? `Text Search: ${query} (Best of — confirmed matches only, ranked by your library)`
        : `Text Search: ${query}`,
    );
  }

  return parts;
}

function metaSpan(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function metaRow(...items) {
  const row = document.createElement('div');
  row.className = 'job-meta-row';

  for (const item of items) {
    row.append(metaSpan(item));
  }

  return row;
}

function button(label, onClick, className = 'p-btn') {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.className = className;
  element.addEventListener('click', onClick);
  return element;
}

async function request(path, options = {}) {
  const headers = { Accept: 'application/json' };

  let body;
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body,
  });

  if (response.status === 401) {
    requirePassword();
    const error = new Error('App password required — enter it and press Connect');
    error.status = 401;
    throw error;
  }

  if (response.status === 204) {
    setConnected(true);
    return {};
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message || `Request failed with status ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (!options.skipConnectedChip) {
    setConnected(true);
  }

  return payload;
}

function setConnected(connected) {
  elements.connStatus.hidden = !connected;
}

function requirePassword() {
  elements.connStatus.hidden = true;
  window.pictariaGate.show();
}

function handleError(error) {
  showToast(error.message, true);
}

function setBusy(value) {
  state.loading = value;
  for (const buttonElement of document.querySelectorAll('button')) {
    buttonElement.disabled = value;
  }
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = `p-toast visible${isError ? ' error' : ''}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, 4200);
}

function formatDate(value) {
  if (!value) {
    return 'never';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatFilterDate(value) {
  if (!value) {
    return '';
  }

  return String(value).slice(0, 10);
}
