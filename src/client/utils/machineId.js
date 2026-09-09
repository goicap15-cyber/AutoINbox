/**
 * Unique Machine Hardware Identifier Utility
 */
export function getMachineId() {
  let id = localStorage.getItem('crm_machine_id');
  if (!id) {
    // Sinh UUID ngẫu nhiên kết hợp với thông tin phần cứng cơ bản
    const platform = navigator.platform || 'Win32';
    const screenRes = `${window.screen.width}x${window.screen.height}`;
    const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
    id = `MAC-${platform.substring(0, 3).toUpperCase()}-${screenRes}-${rand}`;
    localStorage.setItem('crm_machine_id', id);
  }
  return id;
}

export function getStoredLicenseKey() {
  return localStorage.getItem('crm_license_key') || '';
}

export function setStoredLicenseKey(key) {
  if (key) {
    localStorage.setItem('crm_license_key', key.trim());
  } else {
    localStorage.removeItem('crm_license_key');
  }
}
