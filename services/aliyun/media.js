const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readCache, fileHash, readJson, writeJson } = require('./io');

// ONE description of what the local composition produces. assemble() builds the film's own encode commands from it
// and re-verifies the finished file against it, and the creative chain records it as part of a composition's input
// identity (workflows/creative.js), so a changed profile can never be answered by a film encoded with the older
// parameters. This is the only place these numbers may be written down: no second, parallel copy of the command.
const FINAL_PROFILE = Object.freeze({ container: 'mp4', width: 1920, height: 1080, fps: 30,
  pixelFormat: 'yuv420p', videoCodec: 'libx264', preset: 'fast', crf: 18,
  audioCodec: 'aac', audioRate: 48000, audioChannels: 2 });
const SCALE_FILTER = 'scale=' + FINAL_PROFILE.width + ':' + FINAL_PROFILE.height + ':force_original_aspect_ratio=decrease,pad=' +
  FINAL_PROFILE.width + ':' + FINAL_PROFILE.height + ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=' + FINAL_PROFILE.fps +
  ',format=' + FINAL_PROFILE.pixelFormat;
const VIDEO_ARGS = ['-c:v', FINAL_PROFILE.videoCodec, '-preset', FINAL_PROFILE.preset, '-crf', String(FINAL_PROFILE.crf)];
const AUDIO_ARGS = ['-c:a', FINAL_PROFILE.audioCodec, '-ar', String(FINAL_PROFILE.audioRate), '-ac', String(FINAL_PROFILE.audioChannels)];
const SILENCE_ARGS = ['-f', 'lavfi', '-i', 'anullsrc=r=' + FINAL_PROFILE.audioRate + ':cl=stereo'];

class Media {
  constructor(root, project) {
    this.ffmpeg = path.resolve(root, project.tools.ffmpeg);
    this.ffprobe = path.resolve(root, project.tools.ffprobe);
  }
  command(args, cwd) {
    try { return execFileSync(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('FFMPEG_FAILED: 请检查输入媒体和本地工具；命令未经过shell'); }
  }
  probe(file) {
    try {
      return JSON.parse(execFileSync(this.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.resolve(file)],
        { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }));
    } catch { throw new Error('INVALID_MEDIA:' + path.basename(file)); }
  }
  image(file) {
    const stat = fs.statSync(file), video = this.probe(file).streams.find(s => s.codec_type === 'video');
    if (!stat.isFile() || !stat.size || stat.size > 10 * 1024 * 1024 || !video || !['png', 'mjpeg', 'webp'].includes(video.codec_name) ||
        video.width < 384 || video.height < 384 || video.width > 8000 || video.height > 8000) throw new Error('IMAGE_NOT_USABLE:' + path.basename(file));
    return { width: video.width, height: video.height, hash: fileHash(file) };
  }
  audio(file, reference = false) {
    const p = this.probe(file), audio = p.streams.find(s => s.codec_type === 'audio'), seconds = Number(p.format.duration);
    if (!audio || !Number.isFinite(seconds) || seconds <= 0 || (reference && (seconds < 3 || seconds > 60))) throw new Error('AUDIO_NOT_USABLE:' + path.basename(file));
    if (seconds > 120) throw new Error('AUDIO_TOO_LONG:' + path.basename(file));
    const pcm = this.command(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']);
    let squares = 0, clipped = 0, peak = 0;
    const samples = Math.floor(pcm.length / 2);
    for (let i = 0; i < samples; i++) {
      const amplitude = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      squares += amplitude * amplitude; peak = Math.max(peak, amplitude);
      if (amplitude >= 0.999) clipped++;
    }
    const rmsDb = samples && squares ? 20 * Math.log10(Math.sqrt(squares / samples)) : -Infinity;
    if (rmsDb < -60) throw new Error('AUDIO_SILENT_OR_TOO_QUIET:' + path.basename(file));
    return { duration: seconds, hash: fileHash(file), sampleRate: Number(audio.sample_rate), channels: audio.channels,
      quality: { rmsDb, peak, clippedFraction: clipped / samples, warnings: clipped / samples > 0.02 ? ['音频可能削波失真，请试听'] : [] } };
  }
  cached(source, destination, key, args) {
    const stamp = destination + '.meta.json', sourceHash = fileHash(source);
    if (fs.existsSync(destination) && fs.existsSync(stamp)) {
      const record = readCache(stamp);
      if (record?.sourceHash === sourceHash && record.key === key && record.outputHash === fileHash(destination)) return destination;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    this.command(args);
    writeJson(stamp, { sourceHash, key, outputHash: fileHash(destination) });
    return destination;
  }
  prepareImage(source, destination, portrait = false) {
    this.image(source);
    const size = portrait ? '1024:1360' : '1664:936';
    return this.cached(source, destination, size, ['-i', source, '-vf', 'scale=' + size + ':force_original_aspect_ratio=decrease,pad=' + size + ':(ow-iw)/2:(oh-ih)/2:color=white,format=rgb24', '-frames:v', '1', destination]);
  }
  visionImage(source, destination) {
    return this.cached(source, destination, 'vision512', ['-i', source, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-frames:v', '1', destination]);
  }
  normalizeAudio(source, destination, minimumSeconds = 0) {
    this.audio(source);
    const args = ['-i', source, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le'];
    if (minimumSeconds > 0) args.push('-af', 'apad=whole_dur=' + minimumSeconds);
    args.push(destination);
    return this.cached(source, destination, 'audio24000-' + minimumSeconds, args);
  }
  performanceAudio(source, destination, rate = 1, leadSeconds = 0) {
    if (!Number.isFinite(rate) || rate < 0.85 || rate > 1.35 || !Number.isFinite(leadSeconds) || leadSeconds < 0 || leadSeconds > 8) throw new Error('INVALID_SPEECH_PACING');
    this.audio(source);
    const filters = [rate === 1 ? 'anull' : 'atempo=' + rate, ...(leadSeconds ? ['adelay=' + Math.round(leadSeconds * 1000) + ':all=1'] : [])];
    return this.cached(source, destination, 'performance-v2-' + rate + '-' + leadSeconds, ['-i',source,'-vn','-af',filters.join(','),'-ac','1','-ar','24000','-c:a','pcm_s16le',destination]);
  }
  // The only local gate on a clip before it is used: it must be decodable and long enough for the window it has to
  // cover. `requireAudio` additionally demands an audio track, and callers only use it where the track itself
  // matters — this project's own assembled film (whose dialogue is a fact of the composition) and the legacy
  // per-shot path's dialogue takes. The creative lip-sync path deliberately does NOT use it: no supplier evidence in
  // this project says a 口型驱动 take must come back with an audio track, so a missing one is recorded there as an
  // observation instead of being treated as an invalid take (workflows/production.js).
  video(file, duration, requireAudio = false) {
    const p = this.probe(file), v = p.streams.find(s => s.codec_type === 'video'), a = p.streams.find(s => s.codec_type === 'audio');
    const actual = Number(p.format.duration);
    if (!v || !Number.isFinite(actual) || actual + 0.12 < duration || (requireAudio && !a)) throw new Error('VIDEO_INVALID_OR_TOO_SHORT:' + path.basename(file));
    return { duration: actual, width: v.width, height: v.height, audio: !!a };
  }
  // Frames are taken at an explicit, recorded time plan. The caller states the times, so the coverage of
  // every check is auditable and can be printed inside the request and the stored evidence.
  sampleFramesAt(video, directory, times, prefix = 'frame') {
    fs.mkdirSync(directory, { recursive: true });
    return times.map((seconds, index) => {
      const file = path.join(directory, prefix + index + '.png');
      this.command(['-ss', String(seconds), '-i', video, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-frames:v', '1', file]);
      return { file, at: Number(seconds) };
    });
  }
  sampleFrames(video, directory, duration) {
    return this.sampleFramesAt(video, directory, [0.1, duration / 2, Math.max(0.1, duration - 0.2)]).map(entry => entry.file);
  }
  // Local, zero-cost evidence: the average colour of one frame. It makes the time mapping of a sampling
  // plan verifiable on synthetic media without any provider call.
  averageColor(frame) {
    const raw = this.command(['-i', frame, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    if (!raw || raw.length < 3) throw new Error('FRAME_NOT_READABLE:' + path.basename(frame));
    return { r: raw[0], g: raw[1], b: raw[2] };
  }
  // Local repair of a generated clip: take only the usable source window and retime it to the
  // timeline slot. Audio is always dropped here because assembly muxes the planned narration or
  // speech track from assets[shot].audio; the video's own track is never used by assemble().
  localEdit(source, destination, { sourceStart, sourceEnd, targetDuration }) {
    const sourceDuration = Number(this.probe(source).format?.duration);
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('INVALID_MEDIA:' + path.basename(source));
    if (sourceEnd > sourceDuration + 0.05) throw new Error('LOCAL_EDIT_SOURCE_TOO_SHORT:' + path.basename(source));
    const rate = targetDuration / (sourceEnd - sourceStart);
    return this.cached(source, destination, 'local-edit-' + sourceStart + '-' + sourceEnd + '-' + targetDuration,
      ['-i', source, '-an', '-vf', 'trim=start=' + sourceStart + ':end=' + sourceEnd + ',setpts=(PTS-STARTPTS)*' + rate + ',fps=30',
        '-t', String(targetDuration), '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', destination]);
  }
  // A local slice of an accepted line, used only when a shot needs its own driving audio (lip sync).
  // It never changes speed: the slice is copied, not retimed.
  audioSlice(source, destination, start, end) {
    const duration = Number(this.probe(source).format?.duration);
    if (!Number.isFinite(duration) || end > duration + 0.05 || end - start < 0.1) throw new Error('INVALID_AUDIO_SLICE:' + path.basename(source));
    return this.cached(source, destination, 'slice-' + start + '-' + end,
      ['-ss', String(start), '-i', source, '-t', String(end - start), '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', destination]);
  }
  // The driving audio of ONE shot, built from the same source ranges the film's audio bed will play, placed at
  // their real position inside the shot (a leading silence keeps the words where they will be heard). The
  // pieces are copied, never retimed and never re-voiced, so the mouth is driven by the very audio of the
  // film; a provider minimum below the covered span is filled with silence, not with stretched speech.
  // The only processing is resampling/channel unification (24000 Hz mono PCM) plus the `adelay` placement:
  // no tempo change, no fades, and no piece may be moved — the windows here ARE the bed's source ranges.
  drivingAudio(source, destination, { pieces, minimumSeconds = 2 } = {}) {
    const duration = Number(this.probe(source).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('INVALID_MEDIA:' + path.basename(source));
    if (!Array.isArray(pieces) || !pieces.length) throw new Error('DRIVING_AUDIO_REQUIRES_PIECES');
    const ordered = pieces.map(piece => ({ sourceStart: Number(piece.sourceStart), sourceEnd: Number(piece.sourceEnd),
      inShotStart: Number(piece.inShotStart) })).sort((left, right) => left.inShotStart - right.inShotStart);
    let previousEnd = 0;
    for (const piece of ordered) {
      if (![piece.sourceStart, piece.sourceEnd, piece.inShotStart].every(Number.isFinite) ||
          piece.sourceEnd - piece.sourceStart < 0.1 || piece.inShotStart < 0) throw new Error('DRIVING_AUDIO_PIECE_INVALID');
      if (piece.sourceEnd > duration + 0.05) throw new Error('DRIVING_AUDIO_SOURCE_TOO_SHORT:' + path.basename(source));
      if (piece.inShotStart < previousEnd - 0.05) throw new Error('DRIVING_AUDIO_PIECE_OVERLAP');
      previousEnd = Number((piece.inShotStart + (piece.sourceEnd - piece.sourceStart)).toFixed(3));
    }
    const minimum = Number.isFinite(minimumSeconds) && minimumSeconds > 0 ? minimumSeconds : 0;
    const total = Number(Math.max(minimum, previousEnd).toFixed(3));
    const filters = [], labels = [];
    ordered.forEach((piece, index) => {
      filters.push('[' + index + ':a]adelay=' + Math.round(piece.inShotStart * 1000) + ':all=1[p' + index + ']');
      labels.push('[p' + index + ']');
    });
    filters.push(labels.join('') + 'amix=inputs=' + ordered.length + ':duration=longest:normalize=0,apad=whole_dur=' + total + '[mix]');
    const args = ordered.flatMap(piece => ['-ss', String(piece.sourceStart), '-t', String(Number((piece.sourceEnd - piece.sourceStart).toFixed(3))), '-i', source]);
    return this.cached(source, destination, 'driving-' + JSON.stringify(ordered) + '-' + total,
      [...args, '-filter_complex', filters.join(';'), '-map', '[mix]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', destination]);
  }
  assemble(script, assets, directory, { preview = false } = {}) {
    fs.mkdirSync(directory, { recursive: true });
    // Timeline mode: the film track carries the shots and ONE continuous audio bed. Each shot is muted and
    // the dialogue track is placed once on the film track, so a line crossing a cut is neither repeated nor
    // interrupted, and a video's own track never doubles the dialogue.
    const timelineMode = Array.isArray(script.audioBed);
    const clips = [];
    for (let i = 0; i < script.shots.length; i++) {
      const s = script.shots[i], a = assets[s.id], clip = path.join(directory, 'part-' + i + '.mp4');
      if (!a) throw new Error('SHOT_ASSETS_MISSING:' + s.id);
      let args = preview ? ['-loop', '1', '-i', a.first] : ['-i', a.video];
      if (!preview) this.video(a.video, s.duration);
      if (timelineMode) {
        // The shot keeps its picture only; the dialogue track is muxed once on the film track below.
        args.push(...SILENCE_ARGS);
      } else if (s.type === 'dialogue' || s.type === 'narration') {
        this.audio(a.audio);
        args.push('-i', a.audio);
      } else args.push(...SILENCE_ARGS);
      args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', SCALE_FILTER, '-af', 'apad', '-t', String(s.duration),
        ...VIDEO_ARGS, ...AUDIO_ARGS, '-movflags', '+faststart', clip);
      this.command(args);
      clips.push(path.basename(clip));
    }
    if (script.ending) {
      const e = script.ending, card = path.join(directory, 'ending-card.mp4'), black = path.join(directory, 'ending-black.mp4');
      this.image(e.image);
      this.command(['-loop','1','-i',e.image,...SILENCE_ARGS,'-t',String(e.cardSeconds),
        '-vf',SCALE_FILTER + ',fade=t=out:st=' + Math.max(0,e.cardSeconds-0.35) + ':d=0.35',
        ...VIDEO_ARGS, ...AUDIO_ARGS, card]);
      this.command(['-f','lavfi','-i','color=c=black:s=' + FINAL_PROFILE.width + 'x' + FINAL_PROFILE.height +
        ':r=' + FINAL_PROFILE.fps, ...SILENCE_ARGS, '-t',String(e.blackSeconds),
        '-c:v', FINAL_PROFILE.videoCodec, '-preset', FINAL_PROFILE.preset, '-pix_fmt', FINAL_PROFILE.pixelFormat,
        ...AUDIO_ARGS, black]);
      clips.push(path.basename(card),path.basename(black));
    }
    fs.writeFileSync(path.join(directory, 'concat.txt'), clips.map(f => "file '" + f + "'").join('\n') + '\n');
    const clean = path.join(directory, 'picture.mp4'), output = path.join(directory, preview ? 'storyboard.mp4' : 'final.mp4');
    this.command(['-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', clean], directory);
    // Subtitles follow the film timeline: in timeline mode they come from the audio map, so a line that
    // crosses a cut keeps one continuous subtitle. The legacy path keeps its per-shot subtitles.
    const srt = timelineMode ? timelineSubtitles(script.subtitles || []) : subtitles(script);
    fs.writeFileSync(path.join(directory, 'subtitles.srt'), srt, 'utf8');
    // The subtitle filter refuses an empty subtitle file, so a film without cues is mapped directly.
    const burn = srt.trim().length > 0;
    const style = "subtitles=subtitles.srt:force_style='FontName=Microsoft YaHei,FontSize=22,Outline=2,MarginV=35'";
    if (timelineMode) {
      const inputs = [], filters = [];
      for (const [index, entry] of (script.audioBed || []).entries()) {
        if (!entry.file) throw new Error('AUDIO_BED_FILE_MISSING:' + entry.lineId);
        this.audio(entry.file);
        // A bed entry may use a window of the accepted take (a usable sub-range of a longer recording).
        // The window is selected by decoding from sourceStart, never by retiming, so the take keeps its pace.
        const from = Number(entry.sourceStart) || 0;
        if (from > 0) inputs.push('-ss', String(from));
        inputs.push('-i', entry.file);
        const span = Number(entry.durationSeconds) > 0 ? ':' + Number(entry.durationSeconds) : '';
        filters.push('[' + (index + 1) + ':a]atrim=0' + span + ',adelay=' + Math.max(0, Math.round((entry.startSeconds || 0) * 1000)) + ':all=1[a' + index + ']');
      }
      let audioMap;
      if (filters.length) {
        filters.push((script.audioBed || []).map((entry, index) => '[a' + index + ']').join('') +
          'amix=inputs=' + script.audioBed.length + ':duration=longest:normalize=0[mix]');
        audioMap = '[mix]';
      } else { inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'); audioMap = '1:a:0'; }
      filters.push('[0:v]' + (burn ? style : 'null') + '[v]');
      this.command(['-i', clean, ...inputs, '-filter_complex', filters.join(';'),
        '-map', '[v]', '-map', audioMap, '-t', String(script.totalDuration), ...VIDEO_ARGS, ...AUDIO_ARGS,
        '-movflags', '+faststart', output], directory);
    } else if (script.shots.some(s => s.text) && burn) this.command(['-i', clean, '-vf', style,
      ...VIDEO_ARGS, '-c:a', 'copy', '-movflags', '+faststart', output], directory);
    else fs.copyFileSync(clean, output);
    const info = this.video(output, script.totalDuration, true), p = this.probe(output);
    const v = p.streams.find(s => s.codec_type === 'video');
    // The finished film is checked against the same profile its commands were built from.
    if (info.width !== FINAL_PROFILE.width || info.height !== FINAL_PROFILE.height ||
      v.avg_frame_rate !== FINAL_PROFILE.fps + '/1' || Math.abs(info.duration - script.totalDuration) > 0.15)
      throw new Error('FINAL_SPEC_MISMATCH');
    return output;
  }
}
function timestamp(seconds) {
  let n = Math.round(seconds * 1000);
  const h = Math.floor(n / 3600000); n %= 3600000;
  const m = Math.floor(n / 60000); n %= 60000;
  const s = Math.floor(n / 1000), ms = n % 1000;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':') + ',' + String(ms).padStart(3, '0');
}
function subtitles(script) {
  let index = 0;
  const spoken = script.shots.filter(s => s.text).map(s => {
    const text = s.text.replace(/[<>{}\r\n]/g, '').trim();
    return ++index + '\n' + timestamp(s.start + (s.speechLeadSeconds || 0)) + ' --> ' + timestamp(Math.min(s.end, s.start + s.speechDuration)) + '\n' + text + '\n';
  }).join('\n');
  const ending = script.ending;
  const note = ending?.caption ? ++index + '\n' + timestamp(ending.start) + ' --> ' + timestamp(ending.start + ending.cardSeconds) + '\n' + '{\\an8}' + ending.caption.replace(/[<>{}\r\n]/g, '') + '\n' : '';
  return spoken + (note ? '\n' + note : '');
}
// Subtitles placed on the film timeline. A line keeps ONE continuous subtitle even when it is heard
// across several cuts, and a silent gap stays empty: nothing is reset at a cut, duplicated or dropped.
function timelineSubtitles(entries) {
  const ordered = [...(entries || [])].filter(e => e && e.text).sort((a, b) => a.start - b.start);
  for (const [index, e] of ordered.entries()) {
    if (!(e.end > e.start)) throw new Error('SUBTITLE_RANGE_INVALID:' + e.lineId);
    const previous = ordered[index - 1];
    if (previous && e.start < previous.end - 0.001) {
      if (e.lineId !== previous.lineId) throw new Error('SUBTITLE_OVERLAP:' + previous.lineId + '+' + e.lineId);
      throw new Error('SUBTITLE_DUPLICATED:' + e.lineId);
    }
  }
  return ordered.map((e, index) => (index + 1) + '\n' + timestamp(e.start) + ' --> ' + timestamp(e.end) + '\n' +
    e.text.replace(/[<>{}\r\n]/g, '').trim() + '\n').join('\n');
}
module.exports = { FINAL_PROFILE, Media, subtitles, timelineSubtitles, timestamp };
