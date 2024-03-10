import * as logger from '../../utils/logger';
import { Preset } from './Preset';
import { ReactPreset } from './react/ReactPreset';
import { SolidPreset } from './solid/SolidPreset';

const PRESET_MAP: Map<string, Preset> = new Map([
  ['react', new ReactPreset()],
  ['react-server', new ReactPreset({ type: 'server' })],
  ['solid', new SolidPreset()],
]);

export function getPreset(presetName: string): Preset {
  const foundPreset = PRESET_MAP.get(presetName);
  if (!foundPreset) {
    logger.warn(`sandpack-bundler :: Unknown preset ${presetName}, falling back to React`);
    return new ReactPreset();
  }
  return foundPreset;
}
