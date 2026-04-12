function getLicenseData(store) {
  return store.get('license') || null;
}

function setLicenseData(store, data) {
  store.set('license', data || null);
}

function updateLicenseData(store, patch) {
  const cur = getLicenseData(store);
  if (!cur) return;
  store.set('license', { ...cur, ...(patch || {}) });
}

function clearLicenseData(store) {
  store.set('license', null);
}

function isLicenseValid(store) {
  const license = getLicenseData(store);
  if (!license || !license.valid) return false;

  const expiresAt = new Date(String(license.expiresAt || license.expires_at || ''));
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt > new Date();
}

module.exports = {
  getLicenseData,
  setLicenseData,
  updateLicenseData,
  clearLicenseData,
  isLicenseValid
};
