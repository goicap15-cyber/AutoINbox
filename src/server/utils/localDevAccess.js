function isEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim().toLowerCase();
  return normalized === '::1'
    || normalized === 'localhost'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.');
}

function isPackagedElectron() {
  try {
    const electron = require('electron');
    return Boolean(electron?.app?.isPackaged);
  } catch (_) {
    return false;
  }
}

function isLocalDevRequest(req, flagName, env = process.env, packaged = isPackagedElectron()) {
  const remoteAddress = req?.socket?.remoteAddress
    || req?.connection?.remoteAddress
    || req?.ip
    || '';
  return packaged === false
    && isEnabled(env?.[flagName])
    && isLoopbackAddress(remoteAddress);
}

module.exports = { isEnabled, isLoopbackAddress, isPackagedElectron, isLocalDevRequest };
