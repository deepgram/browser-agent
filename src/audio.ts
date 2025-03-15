/**
 * A basic class for getting AudioContexts with a fallback for some older
 * Webkit browsers.
 */
export const AudioContextClass: typeof AudioContext =
  window.AudioContext ||
  (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

const convertFloat32ToInt16 = (buffer: Float32Array): ArrayBuffer => {
  const buf = new Int16Array(buffer.length);
  for (let l = 0; l < buffer.length; l += 1) {
    buf[l] = Math.min(1, buffer[l] ?? 0) * 0x7fff;
  }
  return buf.buffer;
};

/**
 * Convert an audio buffer to a compatible format for the agent API.
 */
export const firstChannelToArrayBuffer = (audio: AudioBuffer): ArrayBuffer =>
  convertFloat32ToInt16(audio.getChannelData(0));

/**
 * Normalize audio data for visualization.
 */
export const normalizeVolume = (
  analyser: AnalyserNode,
  dataArray: Uint8Array,
  normalizationFactor: number,
): number => {
  analyser.getByteFrequencyData(dataArray);
  const sum = dataArray.reduce((acc, val) => acc + val, 0);
  const average = sum / dataArray.length;
  return Math.min(average / normalizationFactor, 1);
};

/**
 * Create a basic analyser node.
 */
export const createAnalyser = (context: AudioContext): AnalyserNode => {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.96;
  return analyser;
};
