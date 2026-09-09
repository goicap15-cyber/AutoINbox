// Backward-compatible wrapper. Server runtime code lives under src/server so
// the packaged dist/server tree remains self-contained.
module.exports = require('../../server/utils/machineId');
