# Synthetic pre-migration installation

This directory is test data, not a runnable Pictaria installation. The
whole-install upgrade test materializes the SQL files into temporary SQLite
databases and copies the JSON/model files into a temporary data volume.

Everything here is invented. The `.tflite` file is inert text, not a model;
it exists only to exercise registry/file integrity and directory backup. No
photo, credential, personal metadata, license, or distributable model is
included.

The fixture represents the last unversioned/legacy shapes supported by the
current migration code:

- settings schema v1, including both historical Voice/OpenAI field names;
- enrichment SQLite before `PRAGMA user_version` migrations 1–5;
- the shared Frame database with legacy label-only voice counters;
- Insights before the day/latitude/longitude migration;
- Smart Albums and wake-word registry schema v1;
- no persistent-state inventory (the one-time adoption boundary).

Never edit an old fixture to match new code. Add a new versioned fixture when
the persisted contract advances, then keep every supported upgrade origin in
CI.
