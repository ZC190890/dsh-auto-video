const { estimateCents } = require('../services/aliyun/budget');

function productionPlan(state, config, videoOnly = false) {
  const script = state.timed || state.script;
  if (!script?.shots) throw new Error('SCRIPT_REQUIRED_FOR_BUDGET_PLAN');
  const plan = [], voices = new Set();
  const speechModels = state.speechProfile?.models || config.models;
  const add = (base, cents) => plan.push({ id: base + '-r' + (state.revisions?.[base] || 0), cents });
  for (const shot of script.shots) {
    if (!videoOnly) {
      if (shot.type === 'dialogue' || shot.type === 'narration') {
        const character = state.characters[shot.speaker];
        const voice = state.speechProfile ? character.voices?.[speechModels.speech] : character.voice;
        if (!voice && !voices.has(shot.speaker)) {
          add('voice-' + shot.speaker, estimateCents('voice', speechModels.voiceEnrollment));
          voices.add(shot.speaker);
        }
        add('speech-' + shot.id, estimateCents('speech', speechModels.speech, [...shot.text].length));
      }
      const refs = shot.characters.length === 1
        ? new Set([state.characters[shot.characters[0]].original, state.characters[shot.characters[0]].front]).size
        : Math.max(1, shot.characters.length);
      add('first-' + shot.id, estimateCents('image', config.models.image, 1, Math.min(3, refs)));
      if (shot.needsLastFrame) add('last-' + shot.id, estimateCents('image', config.models.image, 1, Math.min(3, refs + 1)));
      add('frame-check-' + shot.id, estimateCents('vision', config.models.vision));
    }
    add('video-' + shot.id, estimateCents('video',
      shot.type === 'dialogue' || (shot.type === 'narration' && shot.duration > 5) ? config.models.dialogueVideo : config.models.actionVideo,
      shot.type === 'dialogue' || (shot.type === 'narration' && shot.duration > 5) ? Math.ceil(shot.duration) : 5, 0, config.resolution));
    add('video-check-' + shot.id, estimateCents('vision', config.models.vision));
  }
  return plan;
}
module.exports = { productionPlan };
