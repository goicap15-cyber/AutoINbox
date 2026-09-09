const fs = require('fs');
const path = require('path');
const os = require('os');
const { APP_DATA_ROOT } = require('./appDataRoot');

const MACHINE_FILE = path.join(APP_DATA_ROOT, 'machine_id.txt');

function getMachineId() {
  try {
    if (fs.existsSync(MACHINE_FILE)) {
      return fs.readFileSync(MACHINE_FILE, 'utf8').trim();
    }
  } catch (_) {}

  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.replace(/\s+/g, '') : 'CPU';
  const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
  const machineId = `MAC-${os.platform().toUpperCase()}-${cpuModel.substring(0, 10)}-${rand}`;

  try {
    fs.mkdirSync(APP_DATA_ROOT, { recursive: true });
    fs.writeFileSync(MACHINE_FILE, machineId, 'utf8');
  } catch (_) {}

  return machineId;
}

module.exports = { getMachineId };
