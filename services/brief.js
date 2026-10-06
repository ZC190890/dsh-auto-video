const fs = require('node:fs');
const path = require('node:path');
const { readJson, fileHash, hash } = require('./aliyun/io');

// The production brief is produced by the configured planner model and stored inside the job. A brief
// file that predates the model-generated flow (for example one whose author field names a former
// assistant) stays readable as a historical source, but nothing in the pipeline requires it and no
// author field is ever part of the validity rules: only content and material integrity are checked.
function briefPath(root, production) {
  return path.resolve(root, production.intakeFile || 'input/director-brief.json');
}
function generatedBriefPath(directory) { return path.join(directory, 'brief.json'); }

function briefState(brief, production) {
  if (!brief || typeof brief !== 'object') return { usable: false, reason: 'BRIEF_MISSING' };
  if (brief.productionId !== production.id) return { usable: false, reason: 'BRIEF_PRODUCTION_MISMATCH' };
  if (brief.descriptionHash !== hash(production.description)) return { usable: false, reason: 'BRIEF_DESCRIPTION_CHANGED' };
  if (typeof brief.storySummary !== 'string' || !brief.storySummary.trim() ||
      typeof brief.shotGuidance !== 'string' || !Array.isArray(brief.characters)) return { usable: false, reason: 'BRIEF_INCOMPLETE' };
  for (const c of production.characters) {
    const entry = brief.characters.find(e => e.id === c.id);
    if (!entry || entry.imageSha256 !== fileHash(c.image) ||
        entry.voiceSha256 !== (c.speaks === false ? null : fileHash(c.voiceSample)) ||
        entry.frontSha256 !== (c.frontImage ? fileHash(c.frontImage) : null) ||
        typeof entry.visualAnalysis !== 'string' || !entry.visualAnalysis.trim() ||
        typeof entry.voiceAnalysis !== 'string' || !entry.voiceAnalysis.trim())
      return { usable: false, reason: 'BRIEF_MATERIALS_MISMATCH:' + c.id };
  }
  return { usable: true, reason: null };
}
function briefSource(brief) {
  if (!brief) return null;
  const generatedBy = typeof brief.generatedBy === 'string' ? brief.generatedBy : null;
  const preparedBy = typeof brief.preparedBy === 'string' ? brief.preparedBy : null;
  return { generatedBy, preparedBy, historical: !generatedBy && !!preparedBy,
    role: generatedBy ? 'model' : preparedBy ? 'external-source' : 'unknown' };
}
// Returns null when no usable brief exists; the caller then generates one with the planner model.
function loadBrief(root, production, directory) {
  const candidates = [directory ? generatedBriefPath(directory) : null, briefPath(root, production)].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const brief = readJson(file);
    const state = briefState(brief, production);
    if (state.usable) return { brief, file, source: briefSource(brief) };
  }
  return null;
}
module.exports = { briefPath, briefSource, briefState, generatedBriefPath, loadBrief };
