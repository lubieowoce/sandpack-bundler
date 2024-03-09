import { BundlerError } from './BundlerError';

export const errorMessage = (error: BundlerError) => {
  console.error('sandpack-bundler :: errorMessage', error);
  // debugger;
  return {
    type: 'action',
    action: 'show-error',

    title: error.title,
    path: error.path,
    message: error.message,
    line: error.line,
    column: error.column,
    payload: { frames: [] },
  };
};
