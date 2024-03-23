// @ts-check
// simulate '@babel/types' using what's in '@babel/standalone'
const { types } = require('./_standalone');

// there's too many exports there to list them out as an ES Module,
// so use module.exports instead which lets us reexport them all at once
module.exports = { ...types };
module.exports.__esModule = true;
