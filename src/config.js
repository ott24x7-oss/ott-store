'use strict';
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  sessionSecret: process.env.SESSION_SECRET || 'change-me-32-char-hex-secret-key',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123!',
  jwtExpiry: '7d',
  adminJwtExpiry: '12h',
  bcryptRounds: 12,
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@store.local',
  },
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
  uploadDir: require('path').join(__dirname, '..', 'data', 'uploads'),
};
