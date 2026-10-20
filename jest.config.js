module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  moduleNameMapper: { '^@prisma/client$': '<rootDir>/test/prisma-mock.js' },
  testEnvironment: 'node',
};
