/**
 * 从 Persona 派生 InjectionConfig。Node 端执行，不进浏览器。
 */

import type { Persona } from '@mosaiq/persona-schema';
import { seedToUint32 } from '@mosaiq/persona-schema';

import { buildUserAgent } from '../ua.js';
import type { InjectionConfig } from './types.js';

export function buildInjectionConfig(persona: Persona): InjectionConfig {
  const ua = persona.browser.userAgent ?? buildUserAgent(persona);

  return {
    // Identity
    userAgent: ua,
    appVersion: ua.replace(/^Mozilla\//, ''),
    platform: persona.system.os.platformLabel,
    vendor: persona.browser.brand === 'firefox' ? '' : 'Google Inc.',
    languages: persona.system.languages,

    // Hardware
    hardwareConcurrency: persona.hardware.cpu.cores,
    deviceMemory: persona.hardware.deviceMemoryGb,
    maxTouchPoints: persona.hardware.maxTouchPoints,

    // Screen
    screen: {
      width: persona.system.screen.width,
      height: persona.system.screen.height,
      availWidth: persona.system.screen.availWidth,
      availHeight: persona.system.screen.availHeight,
      colorDepth: persona.system.screen.colorDepth,
      pixelDepth: persona.system.screen.pixelDepth,
      devicePixelRatio: persona.system.screen.devicePixelRatio,
    },

    timezone: persona.system.timezone,

    // GPU
    webglVendor: persona.hardware.gpu.webglVendor,
    webglRenderer: persona.hardware.gpu.webglRenderer,

    // Audio
    audioSampleRate: persona.hardware.audio.sampleRate,
    audioOutputLatency: persona.hardware.audio.outputLatencySec,
    audioInputDevices: persona.hardware.audio.inputDeviceCount,
    audioOutputDevices: persona.hardware.audio.outputDeviceCount,

    // Fingerprint seeds
    canvasNoiseSeed: seedToUint32(persona.fingerprint.canvas.noiseSeed),
    canvasNoiseStrength: persona.fingerprint.canvas.noiseStrength,
    webglNoiseSeed: seedToUint32(persona.fingerprint.webgl.noiseSeed),
    webglPerturbReadPixels: persona.fingerprint.webgl.perturbReadPixels,
    audioNoiseSeed: seedToUint32(persona.fingerprint.audio.noiseSeed),
    audioNoiseAmplitude: persona.fingerprint.audio.noiseAmplitude,

    // Fonts
    fontList: persona.fingerprint.fontList.fonts,

    // WebRTC
    webrtcMode: persona.fingerprint.webrtc.mode,
  };
}
