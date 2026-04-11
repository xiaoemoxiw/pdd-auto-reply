function getDefaultInvoiceSubmitConfig() {
  return {
    mode: 'json',
    method: 'POST',
    urlPath: '/omaisms/invoice/upload_invoice',
    discoveredAt: 0,
  };
}

module.exports = {
  getDefaultInvoiceSubmitConfig,
};
