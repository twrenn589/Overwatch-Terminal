'use strict';

/**
 * Git automation: add dashboard-data.json, commit, push to origin/main.
 * Uses simple-git for a clean async API.
 */

const path    = require('path');
const simpleGit = require('simple-git');

const REPO_ROOT   = path.join(__dirname, '..');
const TARGET_FILE = 'dashboard-data.json';

async function pushToGitHub() {
  const git = simpleGit(REPO_ROOT);

  // Verify this is actually a git repo before doing anything
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    console.warn('[git] Not a git repo — skipping push.');
    return;
  }

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  const message = `auto: data update ${stamp}`;

  try {
    console.log('[git] Staging dashboard-data.json…');
    await git.add(TARGET_FILE);

    // Check if there's actually something to commit
    const status = await git.status();
    const staged = status.staged;
    if (staged.length === 0) {
      console.log('[git] Nothing new to commit — dashboard-data.json unchanged.');
      return;
    }

    console.log(`[git] Committing: "${message}"`);
    await git.commit(message);

    console.log('[git] Pushing to origin/main…');
    await git.push('origin', 'main');

    console.log('[git] Push successful.');
  } catch (e) {
    // Don't crash the whole script — the JSON is already written locally
    console.error(`[git] ERROR: ${e.message}`);
    console.error('[git] The dashboard-data.json was written but NOT pushed.');
    console.error('[git] Fix the git issue and push manually, or check your credentials.');
  }
}

module.exports = pushToGitHub;
