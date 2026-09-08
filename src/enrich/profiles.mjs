import { randomUUID } from 'node:crypto';
import { loadPrompts } from './runner.mjs';
import { loadActiveTaxonomy, loadTaxonomy, parseTaxonomySource } from './taxonomy.mjs';
import { buildUserPrompt, canonicalJson } from './runConfiguration.mjs';

export class ProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.code = 'invalid_enrich_profile';
  }
}

// Profiles and their immutable revisions share enrichment.sqlite's transaction,
// migration and backup boundary. List reads never materialize prompt/taxonomy blobs.
export class EnrichmentProfiles {
  constructor({ repo, config }) { this.repo = repo; this.db = repo.db; this.config = config; }

  builtin() {
    return { ...loadPrompts(this.config.promptsDir, this.config.promptVersion),
      taxonomy: loadTaxonomy(this.config.taxonomyPath).raw };
  }

  initialize() {
    this.repo.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM enrich_profiles LIMIT 1').get()) {
        const prompts = loadPrompts(this.config.promptsDir, this.config.promptVersion);
        const profile = this.create({ name: 'Default', ...prompts,
          systemPrompt: this.config.promptOverrides?.systemPrompt || prompts.systemPrompt,
          userTemplate: this.config.promptOverrides?.userTemplate || prompts.userTemplate,
          taxonomy: loadActiveTaxonomy(this.config).raw });
        this.setDefault(profile.id);
      }
      const initial = this.defaultProfile();
      // Old pending slices had no pinned inputs. Preserve them and capture the
      // migrated effective default once, before any post-upgrade profile edits.
      this.db.prepare('UPDATE enrich_queue SET profile_revision_id = ? WHERE profile_revision_id IS NULL')
        .run(initial.revisionId);
    });
  }

  list() {
    return this.db.prepare(`SELECT p.id, p.name, p.archived, p.is_default, r.id AS revision_id, r.revision
      FROM enrich_profiles p JOIN enrich_profile_revisions r ON r.id = p.current_revision_id
      ORDER BY p.archived, p.is_default DESC, p.name COLLATE NOCASE, p.id`).all().map(row => ({
      id: row.id, name: row.name, archived: Boolean(row.archived), isDefault: Boolean(row.is_default),
      revisionId: row.revision_id, revision: row.revision,
    }));
  }

  defaultProfile() {
    const row = this.db.prepare('SELECT id FROM enrich_profiles WHERE is_default = 1 AND archived = 0').get();
    if (!row) throw new ProfileError('The default enrichment profile is missing. Restore the profile database.', 409);
    return this.get(row.id);
  }

  get(id) {
    if (typeof id !== 'string') throw new ProfileError('Choose an enrichment profile.');
    const row = this.db.prepare('SELECT * FROM enrich_profiles WHERE id = ?').get(id);
    if (!row) throw new ProfileError('That enrichment profile no longer exists.', 404);
    return { ...this.revision(row.current_revision_id), name: row.name,
      archived: Boolean(row.archived), isDefault: Boolean(row.is_default) };
  }

  revision(id) {
    if (typeof id !== 'string') throw new ProfileError('Choose a valid profile revision.');
    const row = this.db.prepare(`SELECT * FROM enrich_profile_revisions WHERE id = ?
      AND length(CAST(system_prompt AS BLOB)) <= 80000
      AND length(CAST(user_template AS BLOB)) <= 80000
      AND length(CAST(taxonomy_json AS BLOB)) <= 800000`).get(id);
    if (!row) throw new ProfileError('That profile revision is missing or exceeds its storage limit.', 404);
    return { id: row.profile_id, revisionId: row.id, revision: row.revision, name: row.name,
      systemPrompt: row.system_prompt, userTemplate: row.user_template,
      taxonomy: JSON.parse(row.taxonomy_json), createdAt: row.created_at };
  }

  attribution(revisionId) {
    const row = this.db.prepare('SELECT id, profile_id, revision, name FROM enrich_profile_revisions WHERE id = ?').get(revisionId);
    return row ? { id: row.profile_id, revisionId: row.id, revision: row.revision, name: row.name } : null;
  }

  resolve({ profileId, profileRevisionId } = {}) {
    for (const value of [profileId, profileRevisionId]) {
      if (value != null && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)))
        throw new ProfileError('Choose a valid enrichment profile or revision.');
    }
    const selected = profileRevisionId ? this.revision(profileRevisionId)
      : profileId ? this.get(profileId) : this.defaultProfile();
    if (selected.archived) throw new ProfileError('This profile is archived. Restore it or choose another profile.', 409);
    if (profileId && profileId !== selected.id) throw new ProfileError('The revision does not belong to the selected profile.');
    return { ...selected, taxonomy: parseTaxonomySource(JSON.stringify(selected.taxonomy)),
      attribution: { id: selected.id, name: selected.name, revision: selected.revision, revisionId: selected.revisionId } };
  }

  validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProfileError('Supply a profile object.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
      throw new ProfileError('Give the profile a name of 1–80 characters.');
    for (const key of ['systemPrompt', 'userTemplate']) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 20000)
        throw new ProfileError(`${key === 'systemPrompt' ? 'System prompt' : 'Per-photo prompt'} must contain 1–20,000 characters.`);
    }
    if (!input.userTemplate.includes('{approved_tags}'))
      throw new ProfileError('The per-photo prompt must include {approved_tags}, which inserts the allowed tag list.');
    const source = typeof input.taxonomy === 'string' ? input.taxonomy : JSON.stringify(input.taxonomy);
    if (!source || source.length > 200000) throw new ProfileError('Taxonomy JSON must contain at most 200,000 characters.');
    try {
      const taxonomy = parseTaxonomySource(source);
      if (!taxonomy.version.trim()) throw new Error('The taxonomy needs a non-empty version label.');
      buildUserPrompt(input.userTemplate, taxonomy);
      return { name: input.name.trim(), systemPrompt: input.systemPrompt,
        userTemplate: input.userTemplate, taxonomy: taxonomy.raw };
    } catch (error) { throw new ProfileError(error.message); }
  }

  create(input) {
    const value = this.validate(input);
    return this.repo.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM enrich_profiles').get().n >= 100)
        throw new ProfileError('This installation has reached the limit of 100 profiles, including archived profiles.', 409);
      const id = randomUUID(); const revisionId = randomUUID();
      this.db.prepare('INSERT INTO enrich_profiles (id, name, current_revision_id) VALUES (?, ?, ?)').run(id, value.name, revisionId);
      this.#insertRevision(id, revisionId, 1, value);
      return this.get(id);
    });
  }

  update(id, input) {
    const value = this.validate(input);
    return this.repo.transaction(() => {
      const current = this.get(id);
      if (current.archived) throw new ProfileError('Restore this profile before editing it.', 409);
      if (input.expectedRevisionId !== current.revisionId)
        throw new ProfileError('This profile changed in another window. Reload it before saving your edits.', 409);
      if (canonicalJson(value) === canonicalJson({ name: current.name, systemPrompt: current.systemPrompt,
        userTemplate: current.userTemplate, taxonomy: current.taxonomy })) return current;
      const revisionId = randomUUID();
      this.#insertRevision(id, revisionId, current.revision + 1, value);
      this.db.prepare('UPDATE enrich_profiles SET name = ?, current_revision_id = ? WHERE id = ?').run(value.name, revisionId, id);
      return this.get(id);
    });
  }

  #insertRevision(id, revisionId, revision, value) {
    this.db.prepare(`INSERT INTO enrich_profile_revisions
      (id, profile_id, revision, name, system_prompt, user_template, taxonomy_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, id, revision, value.name,
      value.systemPrompt, value.userTemplate, JSON.stringify(value.taxonomy), new Date().toISOString());
  }

  setDefault(id) {
    return this.repo.transaction(() => {
      const profile = this.get(id);
      if (profile.archived) throw new ProfileError('Restore this profile before making it the default.', 409);
      this.db.prepare('UPDATE enrich_profiles SET is_default = 0 WHERE is_default = 1').run();
      this.db.prepare('UPDATE enrich_profiles SET is_default = 1 WHERE id = ?').run(id);
      return this.get(id);
    });
  }

  archive(id, archived) {
    if (typeof archived !== 'boolean') throw new ProfileError('Archived must be true or false.');
    const current = this.get(id);
    if (current.isDefault && archived) throw new ProfileError('Choose another default profile before archiving this one.', 409);
    this.db.prepare('UPDATE enrich_profiles SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
    return this.get(id);
  }
}
