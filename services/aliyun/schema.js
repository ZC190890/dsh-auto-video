const { safeId } = require('./io');

// Closed vocabulary for the optional referenceCoverage declaration in the manifest. It is exported so the
// reference plan (which maps each word to the frame requirement it can keep) and the contract test can be checked
// against ONE list instead of drifting apart.
const REFERENCE_COVERAGE_VOCABULARY = ['identity', 'face', 'hair', 'costume', 'accessories', 'materials',
  'weapon', 'palette', 'background'];

function string(value, name, max = 4000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw new Error(`INVALID_${name}`);
  return value;
}
function validateProduction(p) {
  safeId(p.id);
  string(p.description, 'DESCRIPTION', 8000);
  string(p.style, 'STYLE', 1000);
  if (!Number.isFinite(p.targetDurationSeconds) || !Number.isFinite(p.maxDurationSeconds) ||
      p.targetDurationSeconds < 2 || p.targetDurationSeconds > p.maxDurationSeconds || p.maxDurationSeconds > 60) throw new Error('INVALID_FILM_DURATION');
  if (!Array.isArray(p.characters) || p.characters.length < 1 || p.characters.length > 5) throw new Error('INVALID_CHARACTERS');
  const ids = new Set();
  for (const c of p.characters) {
    safeId(c.id);
    if (ids.has(c.id)) throw new Error('DUPLICATE_CHARACTER');
    ids.add(c.id);
    string(c.name, 'CHARACTER_NAME', 60);
    string(c.image, 'IMAGE_PATH', 1000);
    if (c.speaks !== undefined && typeof c.speaks !== 'boolean') throw new Error('INVALID_SPEAKS_FLAG');
    if (c.speaks !== false) string(c.voiceSample, 'VOICE_PATH', 1000);
    if (c.frontImage) string(c.frontImage, 'FRONT_PATH', 1000);
    // Optional declaration of what each material has been CONFIRMED to show. It is the only basis the reference
    // plan may use to decide necessity: without it a material's coverage is unknown, and unknown coverage is
    // never treated as droppable. The vocabulary is closed so a typo cannot silently look like a declaration.
    if (c.referenceCoverage !== undefined) {
      const coverage = c.referenceCoverage;
      if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id);
      for (const [source, value] of Object.entries(coverage)) {
        if (!['frontImage', 'image'].includes(source)) throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id + ':' + source + ':UNKNOWN_MATERIAL');
        if (!c[source]) throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id + ':' + source + ':DECLARED_WITHOUT_MATERIAL');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id + ':' + source);
        if (!Array.isArray(value.covers) || value.covers.length > 9 ||
            value.covers.some(item => !REFERENCE_COVERAGE_VOCABULARY.includes(item)))
          throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id + ':' + source + ':covers（允许值：' +
            REFERENCE_COVERAGE_VOCABULARY.join('、') + '）');
        if (value.optional !== undefined && typeof value.optional !== 'boolean')
          throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id + ':' + source + ':optional');
        if (value.note !== undefined && (typeof value.note !== 'string' || !value.note.trim() || value.note.length > 200))
          throw new Error('INVALID_REFERENCE_COVERAGE:' + c.id + ':' + source + ':note');
      }
    }
    string(c.traits || '', 'TRAITS', 2000, true);
  }
  if (p.narrator && !p.characters.some(c => c.id === p.narrator && c.speaks !== false)) throw new Error('INVALID_NARRATOR');
  if (p.ending) {
    string(p.ending.image, 'ENDING_IMAGE', 1000);
    if (![p.ending.cardSeconds,p.ending.blackSeconds].every(n => Number.isFinite(n) && n > 0 && n <= 5)) throw new Error('INVALID_ENDING_DURATION');
  }
  return p;
}
function validateScript(script, production, timed = false) {
  string(script.title, 'TITLE', 100);
  if (!Array.isArray(script.shots) || script.shots.length < 1 || script.shots.length > 20) throw new Error('INVALID_SHOTS');
  const characters = new Set(production.characters.map(c => c.id));
  const ids = new Set();
  let duration = 0;
  for (const s of script.shots) {
    safeId(s.id);
    if (ids.has(s.id)) throw new Error('DUPLICATE_SHOT');
    ids.add(s.id);
    if (!['dialogue', 'narration', 'action', 'cutaway'].includes(s.type)) throw new Error('INVALID_SHOT_TYPE');
    if (!Array.isArray(s.characters) || s.characters.length > 2 || new Set(s.characters).size !== s.characters.length || s.characters.some(id => !characters.has(id))) throw new Error('INVALID_SHOT_CHARACTERS');
    string(s.scene, 'SCENE', 1800);
    string(s.action, 'ACTION', 1800);
    string(s.text, 'TEXT', 300, true);
    string(s.emotion || '', 'EMOTION', 200, true);
    if (s.speechRate !== undefined && (!Number.isFinite(s.speechRate) || s.speechRate < 0.85 || s.speechRate > 1.35)) throw new Error('INVALID_SPEECH_PACING');
    if (s.speechLeadSeconds !== undefined && (!Number.isFinite(s.speechLeadSeconds) || s.speechLeadSeconds < 0 || s.speechLeadSeconds > 8 || (s.speechLeadSeconds > 0 && s.type !== 'narration'))) throw new Error('INVALID_SPEECH_LEAD');
    if (typeof s.needsLastFrame !== 'boolean') throw new Error('INVALID_LAST_FRAME_FLAG');
    if (s.needsLastFrame) string(s.endScene, 'END_SCENE', 1800);
    // Optional per-shot action contract (the rules live in workflows/shot-contract.js). Shape only here:
    // a legacy script without the fields stays valid, a half-filled contract is refused.
    const contractFields = ['startState', 'endState', 'primaryAction', 'beats', 'cut', 'handoff'];
    if (contractFields.some(key => s[key] !== undefined && s[key] !== null)) {
      for (const key of ['startState', 'endState', 'primaryAction', 'handoff'])
        if (typeof s[key] !== 'string' || !s[key].trim() || s[key].length > 400) throw new Error('INVALID_CONTRACT:' + key);
      if (!Array.isArray(s.beats) || s.beats.length < 1 || s.beats.length > 3 ||
          s.beats.some(beat => typeof beat !== 'string' || !beat.trim() || beat.length > 400)) throw new Error('INVALID_CONTRACT:beats');
      if (!['continuous', 'scene', 'time'].includes(s.cut)) throw new Error('INVALID_CONTRACT:cut');
    }
    if ((!timed && !Number.isInteger(s.duration)) || !Number.isFinite(s.duration) || s.duration < 2 || s.duration > 15) throw new Error('INVALID_SHOT_DURATION');
    if (s.speaker && (production.characters.find(c => c.id === s.speaker)?.speaks === false || (production.narrator && s.speaker !== production.narrator))) throw new Error('ONLY_AUTHORIZED_NARRATOR');
    if (s.type === 'narration') {
      if (!s.text.trim() || !characters.has(s.speaker) || (!timed && s.duration !== 5) || !s.needsLastFrame) throw new Error('NARRATION_REQUIRES_SPEAKER_AND_5_SECONDS');
    } else if (s.type === 'dialogue') {
      if (!s.text.trim() || !characters.has(s.speaker) || s.characters.length !== 1 || s.characters[0] !== s.speaker) throw new Error('DIALOGUE_REQUIRES_ONE_VISIBLE_SPEAKER');
    } else if (s.speaker !== null || s.text !== '' || s.duration !== 5 || !s.needsLastFrame) {
      throw new Error('ACTION_REQUIRES_5_SECONDS_AND_TWO_FRAMES');
    }
    duration += s.duration;
  }
  if (duration + (production.ending ? production.ending.cardSeconds + production.ending.blackSeconds : 0) > production.maxDurationSeconds) throw new Error('FILM_TOO_LONG');
  if (production.requiredQuotes) {
    const normalize = value => value.replace(/[\s\p{P}]/gu, '');
    const spoken = normalize(script.shots.map(s => s.text).join(''));
    if (production.requiredQuotes.some(q => !spoken.includes(normalize(q)))) throw new Error('REQUIRED_QUOTE_MISSING');
  }
  return script;
}
function timedScript(script, audioDurations, production) {
  const timed = structuredClone(script);
  let cursor = 0;
  for (const s of timed.shots) {
    if (s.type === 'dialogue' || s.type === 'narration') {
      const seconds = audioDurations[s.id];
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`AUDIO_DURATION_MISSING:${s.id}`);
      s.speechDuration = seconds;
      if (!script.preciseTiming && s.type === 'narration' && seconds > s.duration - 0.15) throw new Error('NARRATION_TOO_LONG:' + s.id + ': 请缩短台词，禁止截断或强制加速');
      if (script.preciseTiming) s.duration = Math.max(s.minimumVisualSeconds || 2, Math.ceil((seconds + 0.1) * 30) / 30);
      else if (s.type === 'dialogue') s.duration = Math.max(2, Math.ceil(seconds + 0.3));
      if (s.duration > 15) throw new Error(`DIALOGUE_TOO_LONG:${s.id}: 请缩短或拆分台词，不截断语音`);
    }
    s.start = cursor;
    s.end = cursor + s.duration;
    cursor = s.end;
  }
  validateScript(timed, production, true);
  if (production.ending) timed.ending = { ...production.ending, start: cursor };
  timed.totalDuration = cursor + (production.ending ? production.ending.cardSeconds + production.ending.blackSeconds : 0);
  return timed;
}
function parseModelJson(text) {
  if (typeof text !== 'string') throw new Error('MODEL_RETURNED_NO_TEXT');
  const trimmed = text.trim();
  const blocks = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 1) return JSON.parse(blocks[0][1].trim());
  if (blocks.length > 1) throw new Error('MODEL_RETURNED_MULTIPLE_JSON_BLOCKS');
  return JSON.parse(trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
module.exports = { validateProduction, validateScript, timedScript, parseModelJson, REFERENCE_COVERAGE_VOCABULARY };
