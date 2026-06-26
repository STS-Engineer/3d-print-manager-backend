const nodemailer = require('nodemailer');

const PLACEHOLDER_VALUES = new Set([
  'your_email@avocarbon.com',
  'your_email_password',
]);

const getSmtpPassword = () => process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
const getSenderEmail = () => process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER;

const getEmailConfigStatus = () => {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = getSmtpPassword();
  const from = getSenderEmail();
  const missing = [];
  const placeholders = [];

  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASSWORD or SMTP_PASS');
  if (!from) missing.push('SMTP_FROM or EMAIL_FROM');

  if (PLACEHOLDER_VALUES.has(user)) placeholders.push('SMTP_USER');
  if (PLACEHOLDER_VALUES.has(pass)) placeholders.push('SMTP_PASSWORD or SMTP_PASS');

  return {
    configured: missing.length === 0 && placeholders.length === 0,
    missing,
    placeholders,
    host: host || null,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    userConfigured: Boolean(user && !PLACEHOLDER_VALUES.has(user)),
    from: from || null,
  };
};

const isEmailConfigured = () => getEmailConfigStatus().configured;

const createTransporter = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: getSmtpPassword(),
  },
});

const formatDateTime = (value) => {
  if (!value) return 'Not available';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString('en-GB', { hour12: false });
};

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const textToHtml = (text) => text
  .split('\n')
  .map((line) => (line.trim() ? escapeHtml(line) : '<br/>'))
  .join('<br/>');

const sendMail = async ({ to, subject, text, html }) => {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (recipients.length === 0) {
    console.warn('[Email] Email skipped: no recipient provided.', { subject });
    return { skipped: true, reason: 'no_recipients' };
  }

  if (!isEmailConfigured()) {
    const config = getEmailConfigStatus();
    console.warn('[Email] SMTP is not configured. Email skipped.', {
      subject,
      recipients,
      missing: config.missing,
      placeholders: config.placeholders,
    });
    return {
      skipped: true,
      reason: 'smtp_not_configured',
      details: {
        missing: config.missing,
        placeholders: config.placeholders,
      },
    };
  }

  const transporter = createTransporter();
  return transporter.sendMail({
    from: getSenderEmail(),
    to: recipients.join(','),
    subject,
    text,
    html,
  });
};

const REQUESTER_STATUS_EMAILS = {
  requester_confirmation: {
    subject: 'Your 3D Printed Part is Ready for Pickup',
    text: ({ requestNumber, partTitle, completionDate, requestUrl }) => `Hello,

Your 3D printed part has been completed and is ready for pickup.

Please log into the system and confirm reception.

Request ID: ${requestNumber}
Request Title: ${partTitle}
Completion Date: ${formatDateTime(completionDate)}
${requestUrl ? `Direct Link: ${requestUrl}` : 'Direct Link: Not available'}

Thank you.`,
  },
  awaiting_requester_confirmation: null,
  more_info_required: {
    subject: 'Additional Information Required',
    text: ({ requestNumber, partTitle, productionComments }) => `Hello,

Additional information is required before processing your 3D printing request.

Please review the request and provide the requested information.

Request ID: ${requestNumber}
Request Title: ${partTitle}
Production Comments: ${productionComments || 'No comments provided.'}

The request will remain on hold until the required information is received.

Thank you.`,
  },
  info_required: null,
  rejected: {
    subject: '3D Printing Request Rejected',
    text: ({ requestNumber, partTitle, rejectionReason }) => `Hello,

Your request has been reviewed and rejected.

Please review the rejection reason in the system.

Request ID: ${requestNumber}
Request Title: ${partTitle}
Rejection Reason: ${rejectionReason || 'No reason provided.'}

Thank you.`,
  },
};

REQUESTER_STATUS_EMAILS.awaiting_requester_confirmation = REQUESTER_STATUS_EMAILS.requester_confirmation;
REQUESTER_STATUS_EMAILS.info_required = REQUESTER_STATUS_EMAILS.more_info_required;

const sendRequesterStatusEmail = async ({
  status,
  to,
  requestNumber,
  partTitle,
  completionDate,
  requestUrl,
  productionComments,
  rejectionReason,
}) => {
  const template = REQUESTER_STATUS_EMAILS[status];
  if (!template) return { skipped: true, reason: 'status_not_configured' };

  const text = template.text({
    requestNumber,
    partTitle,
    completionDate,
    requestUrl,
    productionComments,
    rejectionReason,
  });

  return sendMail({
    to,
    subject: template.subject,
    text,
    html: textToHtml(text),
  });
};

module.exports = {
  sendMail,
  isEmailConfigured,
  getEmailConfigStatus,
  sendRequesterStatusEmail,
  REQUESTER_STATUS_EMAILS,
};
