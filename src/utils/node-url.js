const url = require('../../node_modules/url');
module.exports = { __esModule: true, URL, URLSearchParams, ...url };
// the "url" package doesn't provide pathToFileURL.
module.exports.pathToFileURL = (path) => {
  if (typeof path !== 'string') {
    throw new Error('path must be a string');
  }
  if (!path.startsWith('/')) {
    throw new Error('Cannot convert non-absolute path to a file URL');
  }
  return new URL('file://' + path);
};
