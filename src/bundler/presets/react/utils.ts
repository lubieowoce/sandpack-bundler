import type { BabelFile } from '@babel/core';

function pathToFileURL(filename: string) {
  if (!filename.startsWith('/')) {
    throw new Error('Cannot convert non-absolute path to a file URL');
  }
  return new URL('file://' + filename);
}

export const getModuleIdUrl = (file: BabelFile) => {
  return pathToFileURL(file.opts.filename!).href;
};
