const path = require('path');

const resolveUploadDir = (configuredDir = process.env.UPLOAD_DIR || 'uploads') => (
  path.isAbsolute(configuredDir)
    ? path.resolve(configuredDir)
    : path.resolve(__dirname, '../../', configuredDir)
);

module.exports = {
  uploadDir: resolveUploadDir(),
  resolveUploadDir,
};
