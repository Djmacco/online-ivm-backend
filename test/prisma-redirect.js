// Lets ts-node run the app without a generated Prisma client (harness only).
const Module = require('module');
const path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@prisma/client') return path.join(__dirname, 'prisma-mock.js');
  return orig.call(this, request, ...rest);
};
