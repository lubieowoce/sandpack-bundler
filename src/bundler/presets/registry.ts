import * as logger from '../../utils/logger';
import { Preset } from './Preset';
import { ReactPreset } from './react/ReactPreset';
import { SolidPreset } from './solid/SolidPreset';

type PresetMapEntry = {
  // TODO: let presets expose a .validateOptions static method (or perhaps just a zod schema?)
  // validateOptions: (options: PresetConfiguration) => (PresetOptionError | PresetOptionWarning)[] | undefined
  create: (options?: PresetConfiguration) => Preset;
};

const PRESET_MAP: Map<string, PresetMapEntry> = new Map([
  ['react', { create: (options) => new ReactPreset({ type: 'client', ...options }) }],
  ['react-server', { create: (options) => new ReactPreset({ type: 'server', ...options }) }],
  ['solid', { create: (options) => new SolidPreset(options) }],
]);

export type PresetInput = string | [name: string, options: PresetConfiguration | undefined];
type PresetConfiguration = Record<string, unknown>;

export function getPreset(presetInput: PresetInput): Preset {
  const issues: IssueInfo[] = [];
  let preset = validatePresetInput(presetInput, (info) => {
    issues.push(info);
  });

  if (issues.length) {
    const logMethod = issues.some((info) => info.level === 'error') ? ('error' as const) : ('warn' as const);
    const inputRepr = presetInput === undefined ? 'undefined' : JSON.stringify(presetInput);
    logger[logMethod](
      `Got issues while parsing preset input ${inputRepr}:\n` +
        issues.map((info) => '  - ' + `[${info.level}]: ${info.message}`).join('\n')
    );
  }

  if (!preset) {
    logger.warn(`Unable to parse preset input ${JSON.stringify(presetInput)}, falling back to React`);
    preset = { name: 'react', options: undefined };
  }

  const foundPreset = PRESET_MAP.get(preset.name);
  if (!foundPreset) {
    logger.warn(`Unknown preset "${presetInput}", falling back to React`);
    return new ReactPreset();
  }
  try {
    return foundPreset.create(preset.options);
  } catch (error) {
    logger.error(
      `Failed to initialize preset "${preset.name}" with options ${JSON.stringify(
        preset.options
      )}, falling back to defaults`
    );
    return foundPreset.create();
  }
}

type IssueLevel = 'warning' | 'error';
type IssueInfo = { message: string; level: IssueLevel };

function validatePresetInput(
  presetInput: unknown,
  addIssue: (info: IssueInfo) => void
): { name: string; options: PresetConfiguration | undefined } | undefined {
  if (!presetInput) {
    return undefined;
  }
  if (typeof presetInput === 'string') {
    return { name: presetInput, options: undefined };
  }
  if (Array.isArray(presetInput)) {
    if (presetInput.length !== 2) {
      addIssue({
        level: 'error',
        message: `Array presets should have exactly 2 elements: [name, options], but the input has ${presetInput.length} items`,
      });
      return undefined;
    }
    const [name, options] = presetInput;
    if (typeof name !== 'string') {
      addIssue({
        level: 'error',
        message: `Expected preset name to be a string, got ${typeof name}`,
      });
      return undefined;
    }
    if (typeof options === 'undefined') {
      return { name, options: undefined };
    }
    if (options === null || typeof options !== 'object') {
      const receivedOptionsType = options === null ? 'null' : typeof options;
      addIssue({
        level: 'error',
        message: `Expected preset options to be an object or undefined, got ${receivedOptionsType}. Options will be ignored`,
      });
      return { name, options: undefined };
    }
    return { name, options };
  }
  addIssue({ level: 'error', message: `Expected 'preset' to be a string or a [name, options] tuple` });
  return undefined;
}
